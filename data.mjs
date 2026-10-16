// Aggregates local Copilot usage for the current billing period.
//
// Sources (all read-only):
//   <copilot home>/session-store.db   assistant_usage_events (one row per model request), turns, sessions
//   <copilot home>/data.db            app sessions, workspaces -> projects, workflows (automations)
//   <copilot home>/session-state/<id>/events.jsonl   subagent names (subagent.started)
//   gh api /copilot_internal/user     billing period, limit, credits GitHub has billed

import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NANO = 1e9; // nano-AIU per AI Credit

export function findHome() {
  const cands = [process.env.COPILOT_HOME, path.join(os.homedir(), ".copilot")];
  if (process.platform === "linux" && fs.existsSync("/mnt/c/Users")) {
    for (const u of fs.readdirSync("/mnt/c/Users")) cands.push(path.join("/mnt/c/Users", u, ".copilot"));
  }
  const size = (c) => { try { return fs.statSync(path.join(c, "session-store.db")).size; } catch { return -1; } };
  const ok = cands.filter((c) => c && size(c) >= 0);
  if (!ok.length) throw new Error("Couldn't find a Copilot home with session-store.db");
  return ok.sort((a, b) => size(b) - size(a))[0];
}

// Open read-only in place; fall back to a temp copy when the live WAL database can't be opened (e.g. from WSL).
export function openDb(home, name, tmp) {
  const src = path.join(home, name);
  try {
    const db = new DatabaseSync(src, { readOnly: true });
    db.prepare("select count(*) from sqlite_master").get();
    return db;
  } catch {
    for (const suffix of ["", "-wal"]) {
      if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, path.join(tmp, name + suffix));
    }
    return new DatabaseSync(path.join(tmp, name));
  }
}

function ghCandidates() {
  const list = ["gh"];
  const local = process.env.LOCALAPPDATA;
  if (local && fs.existsSync(local)) {
    // The Copilot app ships its own gh; newest version first.
    const dirs = fs.readdirSync(local).filter((d) => d.startsWith("copilot-desktop-gh-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const d of dirs) list.push(path.join(local, d, "gh.exe"));
  }
  return list;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20000, windowsHide: true, maxBuffer: 4e6 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export async function quota() {
  for (const gh of ghCandidates()) {
    try {
      const j = JSON.parse(await run(gh, ["api", "/copilot_internal/user"]));
      const q = j.quota_snapshots?.premium_interactions || {};
      return { reset: j.quota_reset_date_utc, plan: j.copilot_plan, unlimited: !!q.unlimited,
               entitlement: q.entitlement || null, used: q.credits_used ?? null };
    } catch { /* try next */ }
  }
  return {};
}

const TAG = /<(current_datetime|system_reminder|reminder|attachments?)>[\s\S]*?<\/\1>/g;
export function cleanPrompt(t) {
  if (!t) return null;
  if (t.trimStart().startsWith("<system_notification")) return "(background task finished)";
  t = t.replace(TAG, "").trim().replace(/^User request \(verbatim\):\s*/, "");
  t = t.replace(/\s+/g, " ").trim().replace(/^"+|"+$/g, "");
  return t.length > 220 ? t.slice(0, 220) + "…" : t;
}

function subagentNames(home, sessionIds) {
  const names = new Map();
  for (const sid of sessionIds) {
    let text;
    try { text = fs.readFileSync(path.join(home, "session-state", sid, "events.jsonl"), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.includes('"subagent.started"')) continue;
      try {
        const e = JSON.parse(line);
        names.set(e.agentId ?? e.data?.agentId, e.data?.agentName || e.data?.agentType);
      } catch { /* skip */ }
    }
  }
  return names;
}

const DAY = 86400000;
const utcDate = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const localKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const parseTs = (s) => new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
const fmtStarted = (d) =>
  `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()} · ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const r2 = (v) => Math.round(v * 100) / 100;
const pick = (entries, n = 6) => [...entries].sort((a, b) => b[1] - a[1]).slice(0, n);
const inc = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
const topKey = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";

export async function build({ home = findHome(), quotaInfo } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-usage-"));
  let s, d;
  try {
    const qp = quotaInfo ? Promise.resolve(quotaInfo) : quota();
    s = openDb(home, "session-store.db", tmp);
    d = openDb(home, "data.db", tmp);
    const q = await qp;

    const now = new Date();
    // Billing periods reset at midnight UTC; daily buckets use UTC dates so they sum to the period total.
    let start, end;
    if (q.reset) {
      end = new Date(q.reset);
      start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, Math.min(end.getUTCDate(), 28)));
    } else {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    }
    const day0 = utcDate(start);
    const days = Math.round((utcDate(end) - day0) / DAY);
    const today = Math.round((utcDate(now) - day0) / DAY) + 1;
    const elapsed = (now - start) / DAY;
    const dayIndex = (t) => Math.floor((utcDate(t) - day0) / DAY);

    const rows = s.prepare(`select session_id sid, turn_index turn, agent_id agent, model,
        coalesce(input_tokens,0) inp, coalesce(output_tokens,0) outp, coalesce(cache_read_tokens,0) cr,
        coalesce(cache_write_tokens,0) cw, coalesce(reasoning_tokens,0) rs, coalesce(total_nano_aiu,0) nano,
        created_at ts, token_details_json td
      from assistant_usage_events where created_at >= ?`).all(start.toISOString().slice(0, 19));

    // ---- session metadata
    const all = (db, sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
    const app = new Map(all(d, "select id, session_type type, title, archived_at archived from sessions").map((r) => [r.id, r]));
    const wsInfo = new Map(all(d, "select id, archived_at archived from workspaces").map((r) => [r.id, r]));
    const projByWs = new Map(all(d, "select w.id, p.name from workspaces w join projects p on p.id = w.project_id").map((r) => [r.id, r.name]));
    const wsBySession = new Map(all(d, "select session_id sid, id from workspaces where session_id is not null").map((r) => [r.sid, r.id]));
    for (const r of all(d, "select session_id sid, workspace_id ws from workspace_session_aliases")) wsBySession.set(r.sid, r.ws);
    const repoToProj = new Map(all(d, "select name, github_owner o, github_repo r from projects where github_repo is not null").map((r) => [`${r.o}/${r.r}`.toLowerCase(), r.name]));
    const store = new Map(all(s, "select id, repository repo, cwd, summary from sessions").map((r) => [r.id, r]));
    const wf = new Map(all(d, `select id, name, interval, schedule_hour hour, schedule_minute minute, schedule_day day,
        cron_expression cron, model, project_id project from workflows`).map((r) => [r.id, r]));
    const projNameById = new Map(all(d, "select id, name from projects").map((r) => [r.id, r.name]));
    const runWf = new Map(all(d, "select session_id sid, task_id tid from workflow_runs where session_id is not null").map((r) => [r.sid, r.tid]));

    const autoCache = new Map();
    const autoOf = (sid) => {
      if (!autoCache.has(sid)) {
        let v = null;
        if (runWf.has(sid)) v = wf.get(runWf.get(sid))?.name || "Deleted automation";
        else if ((app.get(sid)?.type || "").startsWith("workflow")) v = "Unnamed automation";
        autoCache.set(sid, v);
      }
      return autoCache.get(sid);
    };
    const projCache = new Map();
    const projectOf = (sid) => {
      if (projCache.has(sid)) return projCache.get(sid);
      let v = "Other";
      const st = store.get(sid), w = wf.get(runWf.get(sid));
      if (app.get(sid)?.type === "general_chat") v = "Chats (no project)";
      else if (projByWs.has(wsBySession.get(sid))) v = projByWs.get(wsBySession.get(sid));
      else if (w && projNameById.has(w.project)) v = projNameById.get(w.project);
      else if (st?.repo) v = repoToProj.get(st.repo.toLowerCase()) || st.repo;
      else if (st?.cwd) v = st.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Other"; // cwd may be a Windows path
      projCache.set(sid, v);
      return v;
    };
    const titleOf = (sid) => (app.get(sid)?.title || store.get(sid)?.summary || "").trim() || null;
    // Whether the app still has this session, and the id to open it with (aliases open their workspace).
    const linkOf = (sid) => {
      const a = app.get(sid), wsId = wsBySession.get(sid), ws = wsInfo.get(wsId);
      if (a) return { status: a.archived || ws?.archived ? "archived" : "open", openId: sid };
      if (ws) return { status: ws.archived ? "archived" : "open", openId: wsId };
      return { status: "deleted", openId: null };
    };

    // ---- aggregate
    const models = new Map(), modelSessions = new Map();
    const daily = { you: Array(days).fill(0), sub: Array(days).fill(0), auto: Array(days).fill(0) };
    const cal = new Map(); // local date -> { you, sub, auto, hours, sess }
    const sess = new Map(), autos = new Map(), agentRows = new Map(), proj = new Map();
    const buckets = [[25e3, "< 25k"], [50e3, "25–50k"], [100e3, "50–100k"], [150e3, "100–150k"], [Infinity, "> 150k"]];
    const bucketReq = new Map(), bucketAic = new Map();
    const prices = new Map(); // model -> { tokenType: nano-AIU per token }, from the request's own price sheet

    for (const r of rows) {
      if (!prices.has(r.model) && r.td) {
        try { prices.set(r.model, Object.fromEntries(JSON.parse(r.td).map((x) => [x.tokenType, x.costPerBatch / x.batchSize]))); } catch { /* skip */ }
      }
      const c = r.nano / NANO, t = parseTs(r.ts);
      let m = models.get(r.model);
      if (!m) models.set(r.model, (m = { aic: 0, req: 0, input: 0, read: 0, write: 0, output: 0, reasoning: 0, sids: new Set() }));
      m.aic += c; m.req++; m.input += r.inp; m.read += r.cr; m.write += r.cw; m.output += r.outp; m.reasoning += r.rs;
      m.sids.add(r.sid);

      const auto = autoOf(r.sid);
      const src = auto ? "auto" : r.agent ? "sub" : "you";
      const di = dayIndex(t);
      if (di >= 0 && di < days) daily[src][di] += c;
      const lk = localKey(t);
      let cd = cal.get(lk);
      if (!cd) cal.set(lk, (cd = { you: 0, sub: 0, auto: 0, hours: Array(24).fill(0), sess: new Map() }));
      cd[src] += c; cd.hours[t.getHours()] += c; inc(cd.sess, r.sid, c);
      if (auto) {
        let a = autos.get(auto);
        if (!a) autos.set(auto, (a = { aic: 0, tokens: 0, sessions: new Set(), models: new Map() }));
        a.aic += c; a.tokens += r.inp; a.sessions.add(r.sid); inc(a.models, r.model, c);
      }
      if (r.agent) {
        let ar = agentRows.get(r.agent);
        if (!ar) agentRows.set(r.agent, (ar = { aic: 0, tokens: 0, models: new Map(), session: null }));
        ar.aic += c; ar.tokens += r.inp; inc(ar.models, r.model, c); ar.session = r.sid;
      }
      for (const [lim, label] of buckets) {
        if (r.inp < lim) { inc(bucketReq, label, 1); inc(bucketAic, label, c); break; }
      }
      let x = sess.get(r.sid);
      if (!x) sess.set(r.sid, (x = { aic: 0, req: 0, ctx: 0, byModel: new Map(), subAic: 0, turns: new Map(), agents: new Map(), first: t, last: t }));
      x.aic += c; x.req++; x.ctx += r.inp; inc(x.byModel, r.model, c);
      if (r.agent) {
        x.subAic += c;
        const ag = x.agents.get(r.agent) || [0, 0]; ag[0] += c; ag[1]++; x.agents.set(r.agent, ag);
      }
      if (r.turn != null) {
        const tt = x.turns.get(r.turn) || [0, 0, 0]; tt[0] += c; tt[1]++; tt[2] += r.inp; x.turns.set(r.turn, tt);
      }
      if (t < x.first) x.first = t;
      if (t > x.last) x.last = t;

      const pn = projectOf(r.sid);
      let p = proj.get(pn);
      if (!p) proj.set(pn, (p = { aic: 0, sessions: new Set(), spark: Array(days).fill(0), first: t }));
      p.aic += c; p.sessions.add(r.sid);
      if (t < p.first) p.first = t;
      if (di >= 0 && di < days) p.spark[di] += c;
    }

    const names = subagentNames(home, new Set([...agentRows.values()].map((a) => a.session)));
    const subagents = new Map();
    for (const [aid, ar] of agentRows) {
      if (autoOf(ar.session)) continue;
      const n = names.get(aid) || "Unnamed subagent";
      let sa = subagents.get(n);
      if (!sa) subagents.set(n, (sa = { aic: 0, tokens: 0, runs: 0, models: new Map() }));
      sa.aic += ar.aic; sa.tokens += ar.tokens; sa.runs++;
      for (const [k, v] of ar.models) inc(sa.models, k, v);
    }

    // ---- shape output
    const interactive = new Map([...sess].filter(([sid]) => !autoOf(sid)));
    const totals = [...interactive.values()].map((x) => x.aic).filter((v) => v > 0).sort((a, b) => a - b);
    const mid = totals.length >> 1;
    const median = !totals.length ? 0 : totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2;

    const needed = new Set();
    const topSessions = pick([...interactive].map(([sid, x]) => [sid, x.aic]), 15).map(([sid]) => sid);
    const modelOut = [...models].sort((a, b) => b[1].aic - a[1].aic).map(([id, m]) => {
      const perSess = [...m.sids].filter((sid) => interactive.has(sid)).map((sid) => [sid, sess.get(sid).byModel.get(id)]);
      const perAuto = [...autos].filter(([, a]) => a.models.get(id)).map(([n, a]) => [n, a.models.get(id)]);
      const p = prices.get(id) || {};
      const top = pick(perSess);
      top.forEach(([sid]) => needed.add(sid));
      return {
        id, aic: r2(m.aic), req: m.req, input: m.input, read: m.read, write: m.write, output: m.output, reasoning: m.reasoning,
        // Credits saved by cache reads vs. paying the uncached input price for the same tokens.
        saved: r2((m.read * Math.max(0, (p.input || 0) - (p.cache_read || 0))) / NANO),
        sessions: perSess.length,
        top: top.map(([sid, v]) => [sid, r2(v)]),
        autos: pick(perAuto).map(([n, v]) => [n, r2(v)]),
      };
    });

    const projOut = [...proj].sort((a, b) => b[1].aic - a[1].aic).map(([name, p]) => {
      const ps = pick([...p.sessions].filter((sid) => interactive.has(sid)).map((sid) => [sid, sess.get(sid).aic]));
      ps.forEach(([sid]) => needed.add(sid));
      return { name, aic: r2(p.aic), sessions: p.sessions.size,
               spark: p.spark.slice(Math.max(0, today - 14), today).map(r2),
               newToday: utcDate(p.first) === utcDate(now),
               top: ps.map(([sid, v]) => [sid, r2(v)]) };
    });

    const youTop = pick([...interactive].map(([sid, x]) => [sid, x.aic - x.subAic]));
    topSessions.forEach((sid) => needed.add(sid));
    youTop.forEach(([sid]) => needed.add(sid));

    // One entry per local calendar day in the period. West of UTC the period starts the previous
    // evening, so that partial day is only listed when it has usage.
    const calendar = [];
    const firstKey = localKey(start), periodKey = isoDate(day0), todayKey = localKey(now);
    const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const lastKey = localKey(new Date(end.getTime() - 1));
    for (let guard = 0; guard < 40; guard++, cur.setDate(cur.getDate() + 1)) {
      const k = localKey(cur), cd = cal.get(k);
      if (k === firstKey && k < periodKey && !cd) continue;
      const total = cd ? cd.you + cd.sub + cd.auto : 0;
      const top = cd ? pick([...cd.sess], 12) : [];
      top.forEach(([sid]) => needed.add(sid));
      calendar.push({
        date: k, future: k > todayKey, aic: r2(total),
        you: r2(cd?.you || 0), sub: r2(cd?.sub || 0), auto: r2(cd?.auto || 0),
        hours: cd ? cd.hours.map(r2) : Array(24).fill(0),
        sessions: cd?.sess.size || 0,
        top: top.map(([sid, v]) => [sid, r2(v)]),
      });
      if (k >= lastKey) break;
    }

    const ids = [...needed];
    const turnText = new Map();
    const turnsStmt = s.prepare("select turn_index ti, user_message msg from turns where session_id = ?");
    for (const sid of ids) for (const t of turnsStmt.all(sid)) turnText.set(`${sid}|${t.ti}`, t.msg);

    const sessionOut = (sid) => {
      const x = sess.get(sid);
      const subs = new Map();
      for (const [aid, [c]] of x.agents) {
        const n = names.get(aid) || "Unnamed subagent";
        const v = subs.get(n) || [0, 0]; v[0]++; v[1] += c; subs.set(n, v);
      }
      const prompts = [...x.turns].sort((a, b) => b[1][0] - a[1][0]).slice(0, 5).map(([ti, [c, req, ctx]]) => ({
        q: cleanPrompt(turnText.get(`${sid}|${ti}`)) || `Turn ${ti + 1} (prompt not recorded)`, aic: r2(c), req, ctx,
      }));
      const first = cleanPrompt(turnText.get(`${sid}|0`));
      return {
        title: titleOf(sid) || (first ? first.slice(0, 80) : "Untitled session"),
        project: projectOf(sid), started: fmtStarted(x.first), automation: autoOf(sid) || undefined,
        ...linkOf(sid),
        live: now - x.last < 600000,
        aic: r2(x.aic), you: r2(x.aic - x.subAic), req: x.req, ctx: x.ctx,
        byModel: Object.fromEntries([...x.byModel].sort((a, b) => b[1] - a[1]).filter(([, v]) => v >= 0.01).map(([k, v]) => [k, r2(v)])),
        subs: [...subs].sort((a, b) => b[1][1] - a[1][1]).map(([n, [runs, c]]) => [n, runs, r2(c)]),
        prompts,
      };
    };

    const sched = (w) => {
      if (w.cron) return `cron ${w.cron}`;
      const hm = `${String(w.hour ?? 0).padStart(2, "0")}:${String(w.minute ?? 0).padStart(2, "0")}`;
      if (w.interval === "daily") return `daily ${hm}`;
      if (w.interval === "weekly") return `weekly · ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][(w.day ?? 0) % 7]} ${hm}`;
      return w.interval || "";
    };
    const wfByName = new Map([...wf.values()].map((w) => [w.name, w]));

    return {
      generatedAt: now.toISOString(),
      source: { home, requests: rows.length, sessions: sess.size },
      plan: q.plan ?? null,
      period: {
        start: isoDate(day0), days, today, elapsed: Math.round(elapsed * 1000) / 1000,
        limit: q.unlimited ? null : q.entitlement ?? null, unlimited: !!q.unlimited, serverUsed: q.used ?? null,
      },
      daily: Object.fromEntries(Object.entries(daily).map(([k, v]) => [k, v.slice(0, today).map(r2)])),
      models: modelOut,
      contextBuckets: buckets.map(([, l]) => ({ label: l, req: bucketReq.get(l) || 0, aic: r2(bucketAic.get(l) || 0) })),
      you: { sessions: interactive.size, top: youTop.map(([sid, v]) => [sid, r2(v)]) },
      subagents: [...subagents].sort((a, b) => b[1].aic - a[1].aic).map(([n, a]) => ({
        name: n, model: topKey(a.models), runs: a.runs, aic: r2(a.aic), tokens: a.tokens })),
      automations: [...autos].sort((a, b) => b[1].aic - a[1].aic).map(([n, a]) => ({
        name: n, sched: wfByName.has(n) ? sched(wfByName.get(n)) : "", model: topKey(a.models),
        runs: a.sessions.size, aic: r2(a.aic), tokens: a.tokens })),
      medianSessionAic: r2(median),
      topSessions,
      sessions: Object.fromEntries(ids.map((sid) => [sid, sessionOut(sid)])),
      projects: projOut,
      calendar,
    };
  } finally {
    try { s?.close(); } catch { /* ignore */ }
    try { d?.close(); } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
