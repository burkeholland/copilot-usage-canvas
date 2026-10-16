// Local HTTP server for the usage canvas: serves the web UI, the aggregated data,
// and an SSE stream that tells the page when new data or a focus request arrives.

import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "web");
const CACHE = path.join(HERE, ".cache.json");
const DISK_CACHE = path.join(HERE, ".disk-cache.json");
const STALE_MS = 2 * 60 * 1000;
const DISK_STALE_MS = 30 * 60 * 1000; // measuring every worktree takes a minute or more
const STATIC = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/app.css": ["app.css", "text/css"] };
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- data stores (one per extension process, shared by every open panel) ----------

const store = { data: null, builtAt: 0, building: null, error: null };
const disk = { data: null, builtAt: 0, building: null, error: null, progress: null, deleting: null };
const subs = new Set();

// A cache written by an older version lacks newer fields; drop it rather than render a half-empty page.
for (const [s, file, key] of [[store, CACHE, "calendar"], [disk, DISK_CACHE, "items"]]) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (c?.data?.[key]) Object.assign(s, { data: c.data, builtAt: c.builtAt || 0 });
  } catch { /* no cache yet */ }
}

function status() {
  return {
    builtAt: store.builtAt, building: !!store.building, error: store.error, hasData: !!store.data,
    disk: { builtAt: disk.builtAt, building: !!disk.building, error: disk.error, hasData: !!disk.data, progress: disk.progress, deleting: disk.deleting },
  };
}

function emit(event, payload) {
  for (const fn of subs) fn(event, payload);
}

// node:sqlite and the disk walk are slow, so both run in a worker to keep the extension responsive.
function runWorker(job, onProgress) {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker(new URL("./worker.mjs", import.meta.url), { workerData: { job } });
    } catch {
      const p = job === "disk" ? import("./disk.mjs").then((m) => m.scanDisk({ onProgress })) : import("./data.mjs").then((m) => m.build());
      p.then(resolve, reject);
      return;
    }
    w.on("message", (m) => (m.progress ? onProgress?.(m.progress) : m.ok ? resolve(m.data) : reject(new Error(m.error))));
    w.once("error", reject);
    w.once("exit", (code) => code && reject(new Error(`Data worker exited with code ${code}`)));
  });
}

function rebuild(s, { job, file, staleMs, force, onProgress }) {
  if (s.building) return s.building;
  if (!force && s.data && Date.now() - s.builtAt < staleMs) return Promise.resolve(s.data);
  s.error = null;
  s.building = runWorker(job, onProgress)
    .then((data) => {
      Object.assign(s, { data, builtAt: Date.now() });
      fs.promises.writeFile(file, JSON.stringify({ builtAt: s.builtAt, data })).catch(() => {});
      return data;
    })
    .catch((e) => {
      s.error = String(e?.message || e);
      if (!s.data) throw e;
      return s.data;
    })
    .finally(() => {
      s.building = null;
      if ("progress" in s) s.progress = null;
      emit("state", status());
    });
  emit("state", status());
  return s.building;
}

export function refresh({ force = false } = {}) {
  return rebuild(store, { job: "usage", file: CACHE, staleMs: STALE_MS, force });
}

export function refreshDisk({ force = false } = {}) {
  // Measuring while folders are being removed would report sizes for half-deleted folders.
  if (disk.deleting) return Promise.resolve(disk.data);
  let last = 0;
  return rebuild(disk, {
    job: "disk", file: DISK_CACHE, staleMs: DISK_STALE_MS, force,
    onProgress: (p) => {
      disk.progress = p;
      if (Date.now() - last > 500 || p.done === p.total) { last = Date.now(); emit("state", status()); }
    },
  });
}

export async function getData() {
  return store.data || refresh();
}

export async function getDisk() {
  return disk.data || refreshDisk();
}

export function getStatus() {
  return status();
}

// Deletes worktree folders that belong to archived or deleted sessions, one at a time.
// Ownership is re-read from data.db right before each delete, so a folder that was reopened since the scan is skipped.
export async function deleteFolders(paths) {
  if (disk.deleting) throw new Error("Already deleting folders");
  if (disk.building) throw new Error("Wait for disk measuring to finish");
  const known = new Map((disk.data?.items || []).map((x) => [x.path, x]));
  const list = [...new Set(paths)].filter((p) => known.has(p));
  if (!list.length) throw new Error("Those folders aren't in the last scan");
  const { folderOwners, removeFolder } = await import("./disk.mjs");
  const done = [], failed = [];
  disk.deleting = { done: 0, total: list.length };
  emit("state", status());
  try {
    for (const p of list) {
      try {
        const owners = folderOwners();
        const owner = owners.byPath.get(path.resolve(p).toLowerCase());
        if (owner?.status === "open") throw new Error("Its session is open in the app");
        await removeFolder(p, owners);
        done.push(p);
      } catch (e) {
        failed.push({ path: p, error: String(e?.message || e) });
      }
      disk.deleting = { done: done.length + failed.length, total: list.length };
      emit("state", status());
    }
  } finally {
    const gone = new Set(done);
    const freed = (disk.data?.items || []).filter((x) => gone.has(x.path)).reduce((t, x) => t + x.bytes, 0);
    if (disk.data && done.length) {
      const items = disk.data.items.filter((x) => !gone.has(x.path));
      disk.data = { ...disk.data, items, total: items.reduce((t, x) => t + x.bytes, 0) };
      disk.builtAt = Date.now();
      fs.promises.writeFile(DISK_CACHE, JSON.stringify({ builtAt: disk.builtAt, data: disk.data })).catch(() => {});
    }
    disk.deleting = null;
    emit("state", status());
    disk.lastDelete = { deleted: done.length, freed, failed };
  }
  return disk.lastDelete;
}

// Opens a URL or folder with the OS, which hands ghapp:// links back to the Copilot app.
// Only validated session URLs go through cmd.exe; folders go straight to Explorer so no shell parses them.
function osOpen(target, { folder = false } = {}) {
  const win = process.platform === "win32";
  const [cmd, args] = win ? (folder ? ["explorer.exe", [target]] : ["cmd.exe", ["/d", "/c", "start", '""', `"${target}"`]])
    : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: win && !folder });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

// ---------- per-panel server ----------

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

/**
 * @param {{ onAsk?: (prompt: string) => Promise<void> }} hooks
 */
export async function startServer({ onAsk } = {}) {
  // The token keeps other local pages from reading usage data or sending prompts into the session.
  const token = randomBytes(16).toString("hex");
  const clients = new Set();
  const push = (event, payload) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  subs.add(push);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(res, 200, fs.readFileSync(path.join(WEB, file), "utf8"), type);
      }
      const ok = url.searchParams.get("t") === token || req.headers["x-token"] === token;
      if (!ok) return send(res, 403, { error: "forbidden" });

      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(`event: state\ndata: ${JSON.stringify(status())}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        req.on("close", () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/data") {
        return send(res, 200, { ...status(), data: store.data });
      }
      if (req.method === "GET" && url.pathname === "/api/disk") {
        return send(res, 200, { ...status().disk, data: disk.data });
      }
      if (req.method === "POST" && url.pathname === "/api/refresh") {
        refresh({ force: true }).catch(() => {});
        refreshDisk({ force: true }).catch(() => {});
        return send(res, 202, status());
      }
      if (req.method === "POST" && url.pathname === "/api/open") {
        const { id } = await readBody(req);
        if (typeof id !== "string" || !SESSION_ID.test(id)) return send(res, 400, { error: "invalid session id" });
        await osOpen(`ghapp://sessions/${id}`);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/reveal") {
        // Only folders the scan reported can be revealed.
        const { path: p } = await readBody(req);
        const item = disk.data?.items.find((x) => x.path === p) || (disk.data?.sessionState.path === p ? disk.data.sessionState : null);
        if (!item || !fs.existsSync(p)) return send(res, 404, { error: "That folder no longer exists" });
        await osOpen(p, { folder: true });
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/delete") {
        const { paths } = await readBody(req);
        if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== "string")) return send(res, 400, { error: "paths required" });
        return send(res, 200, await deleteFolders(paths));
      }
      if (req.method === "POST" && url.pathname === "/api/ask") {
        const { prompt } = await readBody(req);
        if (typeof prompt !== "string" || !prompt.trim()) return send(res, 400, { error: "prompt required" });
        if (!onAsk) return send(res, 501, { error: "Asking Copilot isn't available here" });
        await onAsk(prompt.trim().slice(0, 4000));
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: String(e?.message || e) });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, clients, push, url: `http://127.0.0.1:${port}/?t=${token}` };
}

export async function stopServer(entry) {
  subs.delete(entry.push);
  for (const res of entry.clients) res.end();
  await new Promise((resolve) => entry.server.close(() => resolve()));
}
