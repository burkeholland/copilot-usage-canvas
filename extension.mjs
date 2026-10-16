// Copilot usage canvas: shows this billing period's AI Credit usage from local logs and GitHub,
// and lets the agent query it, refresh it, and point the panel at specific rows.

import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { startServer, stopServer, refresh, refreshDisk, getData, getDisk, getStatus } from "./server.mjs";

const CANVAS_ID = "copilot-usage";
const servers = new Map(); // instanceId -> server entry
let session = null;

const sum = (a, f = (x) => x) => a.reduce((t, x) => t + f(x), 0);
const r1 = (v) => Math.round(v * 10) / 10;

function totals(D) {
  const P = D.period;
  const day = D.daily.you.map((_, i) => D.daily.you[i] + D.daily.sub[i] + D.daily.auto[i]);
  const local = sum(day);
  const week = day.slice(0, P.today - 1).slice(-7);
  const localRate = week.length ? sum(week) / week.length : local / Math.max(P.elapsed, 1);
  const billed = P.serverUsed ?? local;
  const ratio = local ? billed / local : 1;
  const projected = billed + localRate * ratio * Math.max(0, P.days - P.elapsed);
  return { local, billed, ratio, ratePerDay: localRate * ratio, projected };
}

function sessionSummary(D, sid) {
  const s = D.sessions[sid];
  if (!s) return { id: sid, note: "Not in the top sessions kept by the canvas" };
  return {
    id: sid, title: s.title, project: s.project, started: s.started, active: s.live,
    status: s.status, automation: s.automation || undefined,
    credits: r1(s.aic), requests: s.req, contextTokens: s.ctx,
    timesTypical: r1(s.aic / (D.medianSessionAic || 1)),
    models: Object.fromEntries(Object.entries(s.byModel || {}).map(([k, v]) => [k, r1(v)])),
  };
}

async function data() {
  const D = await getData();
  if (!D) throw new Error("Usage data isn't available yet");
  return D;
}

function focusAll(payload) {
  for (const e of servers.values()) e.push("focus", payload);
  return { focused: servers.size > 0, panels: servers.size };
}

const BY = { type: "string", enum: ["model", "source", "project"], description: "model, source (you / subagents / automations) or project" };

const actions = [
  {
    name: "get_summary",
    description: "Headline numbers for the current billing period: credits billed by GitHub, credits seen in local logs, daily pace, projection, and the top models, projects and sessions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const D = await data();
      const t = totals(D);
      return {
        period: D.period, plan: D.plan,
        creditsBilled: Math.round(t.billed), creditsInLocalLogs: Math.round(t.local),
        note: Math.abs(t.ratio - 1) > 0.05 ? "Local logs and GitHub's billed number differ; treat breakdowns as shares." : undefined,
        pacePerDay: Math.round(t.ratePerDay), projectedForPeriod: Math.round(t.projected),
        topModels: D.models.slice(0, 5).map((m) => ({ model: m.id, credits: r1(m.aic), share: r1((m.aic / t.local) * 100) + "%" })),
        topProjects: [...D.projects].sort((a, b) => b.aic - a.aic).slice(0, 5).map((p) => ({ project: p.name, credits: r1(p.aic), sessions: p.sessions })),
        topSessions: D.topSessions.slice(0, 5).map((sid) => sessionSummary(D, sid)),
        cache: { tokensSent: sum(D.models, (m) => m.input), fromCache: sum(D.models, (m) => m.read), creditsSavedByCache: Math.round(sum(D.models, (m) => m.saved || 0)) },
        dataBuiltAt: new Date(getStatus().builtAt).toISOString(),
      };
    },
  },
  {
    name: "get_breakdown",
    description: "Credits broken down by model, by source (you / subagents / automations) or by project, with each row's largest sessions.",
    inputSchema: { type: "object", properties: { by: BY }, required: ["by"], additionalProperties: false },
    handler: async (ctx) => {
      const D = await data();
      const top = (pairs) => pairs.slice(0, 5).map(([sid, v]) => ({ id: sid, title: D.sessions[sid]?.title, credits: r1(v) }));
      switch (ctx.input?.by) {
        case "model":
          return D.models.map((m) => ({ model: m.id, credits: r1(m.aic), requests: m.req, sessions: m.sessions, tokensSent: m.input, fromCache: m.read, creditsSavedByCache: Math.round(m.saved || 0), topSessions: top(m.top) }));
        case "project":
          return [...D.projects].sort((a, b) => b.aic - a.aic).map((p) => ({ project: p.name, credits: r1(p.aic), sessions: p.sessions, last7Days: r1(sum(p.spark.slice(-7))), topSessions: top(p.top) }));
        case "source":
          return {
            you: { sessions: D.you.sessions, topSessions: top(D.you.top) },
            subagents: D.subagents.map((s) => ({ name: s.name, runs: s.runs, credits: r1(s.aic), tokens: s.tokens, model: s.model })),
            automations: D.automations.map((a) => ({ name: a.name, schedule: a.sched, runs: a.runs, credits: r1(a.aic), tokens: a.tokens, model: a.model })),
          };
        default:
          throw new Error('by must be "model", "source" or "project"');
      }
    },
  },
  {
    name: "list_sessions",
    description: "The most expensive sessions this period, optionally filtered by project or model.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max sessions (default 10)" },
        project: { type: "string", description: "Only sessions in this project" },
        model: { type: "string", description: "Only sessions that used this model" },
      },
      additionalProperties: false,
    },
    handler: async (ctx) => {
      const D = await data();
      const { limit = 10, project, model } = ctx.input || {};
      return Object.keys(D.sessions)
        .filter((sid) => (!project || D.sessions[sid].project === project) && (!model || D.sessions[sid].byModel?.[model]))
        .sort((a, b) => D.sessions[b].aic - D.sessions[a].aic)
        .slice(0, Math.max(1, Math.min(50, limit)))
        .map((sid) => sessionSummary(D, sid));
    },
  },
  {
    name: "get_session",
    description: "One session's cost: credits, requests, context, models, subagents, and its most expensive prompts.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Session id" } }, required: ["id"], additionalProperties: false },
    handler: async (ctx) => {
      const D = await data();
      const sid = Object.keys(D.sessions).find((k) => k === ctx.input?.id || k.startsWith(ctx.input?.id || "\0"));
      if (!sid) throw new Error(`Session "${ctx.input?.id}" isn't among the sessions the canvas tracks`);
      const s = D.sessions[sid];
      return {
        ...sessionSummary(D, sid),
        subagents: (s.subs || []).map(([name, runs, credits]) => ({ name, runs, credits: r1(credits) })),
        prompts: s.prompts.map((p) => ({ prompt: p.q, credits: r1(p.aic), requests: p.req, contextTokens: p.ctx })),
      };
    },
  },
  {
    name: "get_day",
    description: "One local calendar day: credits split by you / subagents / automations, credits per hour (local time), and that day's biggest sessions.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "Local date, YYYY-MM-DD" } }, required: ["date"], additionalProperties: false },
    handler: async (ctx) => {
      const D = await data();
      const c = (D.calendar || []).find((x) => x.date === ctx.input?.date);
      if (!c || c.future) throw new Error(`${ctx.input?.date} isn't a past or current day in this billing period`);
      return {
        date: c.date, credits: r1(c.aic), byYou: r1(c.you), bySubagents: r1(c.sub), byAutomations: r1(c.auto), sessions: c.sessions,
        creditsByHour: c.hours.map(r1),
        topSessions: c.top.map(([sid, v]) => ({ ...sessionSummary(D, sid), creditsThisDay: r1(v) })),
      };
    },
  },
  {
    name: "get_disk_usage",
    description: "How much disk space each session worktree folder takes, biggest first, and whether its session is open, archived, or gone (orphan). Measuring can take a couple of minutes the first time.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max folders (default 15)" } }, additionalProperties: false },
    handler: async (ctx) => {
      const d = await getDisk();
      const gb = (n) => Math.round((n / 1e9) * 100) / 100;
      const stale = d.items.filter((x) => x.status !== "open");
      return {
        measuredAt: d.generatedAt, totalGB: gb(d.total), folders: d.items.length,
        archivedOrOrphanGB: gb(sum(stale, (x) => x.bytes)),
        sessionStateGB: d.sessionState ? gb(d.sessionState.bytes) : undefined,
        items: d.items.slice(0, Math.max(1, Math.min(100, ctx.input?.limit ?? 15)))
          .map((x) => ({ path: x.path, project: x.project, sizeGB: gb(x.bytes), files: x.files, status: x.status, sessionId: x.openId || undefined, title: x.title || undefined })),
      };
    },
  },
  {
    name: "focus",
    description: "Point the open usage panel at something: a model, source or project row in the breakdown, a session by id, a day (YYYY-MM-DD) in the calendar, or the disk space section.",
    inputSchema: {
      type: "object",
      properties: {
        by: BY, name: { type: "string", description: "Row name, e.g. claude-opus-5.5 or markdoc" },
        session: { type: "string", description: "Session id to open instead" },
        day: { type: "string", description: "Local date YYYY-MM-DD to zoom the calendar into" },
        disk: { type: "boolean", description: "Scroll to the disk space section" },
      },
      additionalProperties: false,
    },
    handler: async (ctx) => focusAll(ctx.input || {}),
  },
  {
    name: "refresh",
    description: "Rebuild the usage data from local logs and GitHub now, and re-measure disk usage in the background.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      refreshDisk({ force: true }).catch(() => {});
      await refresh({ force: true });
      return getStatus();
    },
  },
];

const canvas = createCanvas({
  id: CANVAS_ID,
  displayName: "Copilot usage",
  description: "AI Credit usage for this billing period: pace, a clickable calendar of daily use, models, subagents, automations, projects, expensive sessions, and disk space used by session worktrees.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  actions,
  open: async (ctx) => {
    let entry = servers.get(ctx.instanceId);
    if (!entry) {
      entry = await startServer({ onAsk: (prompt) => session.send({ prompt }) });
      servers.set(ctx.instanceId, entry);
    }
    refresh().catch(() => {});
    refreshDisk().catch(() => {});
    const st = getStatus();
    return { title: "Copilot usage", url: entry.url, status: st.building ? "refreshing" : st.hasData ? "ready" : "loading" };
  },
  onClose: async (ctx) => {
    const entry = servers.get(ctx.instanceId);
    if (!entry) return;
    servers.delete(ctx.instanceId);
    await stopServer(entry);
  },
});

session = await joinSession({ canvases: [canvas] });

// Older hosts deliver actions through a raw request instead of the canvas runtime.
session.connection?.onRequest?.("canvas.invokeAction", async (params) => {
  if (!params || typeof params.actionName !== "string" || typeof params.instanceId !== "string") {
    throw new Error("Invalid canvas action payload");
  }
  if (params.canvasId !== CANVAS_ID) throw new Error(`No canvas registered with id "${params.canvasId}"`);
  const handler = canvas.actionHandlers?.get?.(params.actionName);
  if (!handler) throw new Error(`No handler for action "${params.actionName}"`);
  return handler({ ...params });
});
