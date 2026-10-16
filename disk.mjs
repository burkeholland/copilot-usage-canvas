// Measures how much disk the app's session worktrees use, and which session owns each folder.
//
// Worktrees live in <root>/<project>/<folder>. Roots come from the worktrees table in data.db, and every
// folder under them is measured, including leftovers that no session points at any more.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { findHome, openDb } from "./data.mjs";

const norm = (p) => path.resolve(p).toLowerCase();

// Sum file sizes without following links or junctions.
async function dirSize(dir) {
  let bytes = 0, files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let it;
    try { it = await fsp.opendir(d, { bufferSize: 256 }); } catch { continue; }
    const stats = [];
    for await (const e of it) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) stats.push(fsp.lstat(p).then((s) => { bytes += s.size; files++; }, () => {}));
    }
    await Promise.all(stats);
  }
  return { bytes, files };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

// Which session owns each worktree folder, read fresh from data.db.
export function folderOwners(home = findHome()) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-usage-disk-"));
  let rows = [];
  try {
    const d = openDb(home, "data.db", tmp);
    try {
      rows = d.prepare(`select t.path, p.name project, w.id ws, coalesce(w.session_id, w.id) sid, w.archived_at warch,
          s.id sexists, s.title, s.archived_at sarch, w.name wsname
        from worktrees t left join projects p on p.id = t.project_id
        left join workspaces w on w.worktree_id = t.id
        left join sessions s on s.id = coalesce(w.session_id, w.id)`).all();
    } finally { d.close(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // A reusable worktree can belong to several workspaces; prefer the one that's still open.
  const byPath = new Map();
  for (const r of rows) {
    const k = norm(r.path);
    const status = !r.ws ? "orphan" : r.warch || r.sarch || !r.sexists ? "archived" : "open";
    const cur = byPath.get(k);
    if (!cur || (cur.status !== "open" && status === "open") || (cur.status === "orphan" && status === "archived")) {
      byPath.set(k, { project: r.project, status, openId: status === "open" ? r.sid : null, title: (r.title || r.wsname || "").trim() || null });
    }
  }
  const roots = [...new Set(rows.map((r) => path.dirname(path.dirname(path.resolve(r.path)))))].filter((r) => fs.existsSync(r));
  return { byPath, roots };
}

// Deletes a worktree folder. Callers must check it isn't owned by an open session first.
export async function removeFolder(p, { roots }) {
  const full = path.resolve(p);
  // Only <root>/<project>/<folder>, never a root or project folder.
  if (!roots.some((r) => norm(path.dirname(path.dirname(full))) === norm(r))) throw new Error("That folder isn't a session worktree");
  let gitdir = null;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(full, ".git"), "utf8"));
    if (m) gitdir = path.resolve(full, m[1].trim());
  } catch { /* not a linked worktree */ }
  try { await fsp.rm(full, { recursive: true, force: true, maxRetries: 3 }); } catch { /* checked below */ }
  if (fs.existsSync(full)) throw new Error("Some files are in use. Close any app or terminal using that folder and try again");
  // gitdir is <repo>/.git/worktrees/<name>. Pruning drops the now-dangling entry so `git worktree list` stays clean.
  if (gitdir && /[\\/]worktrees[\\/][^\\/]+$/.test(gitdir)) {
    await new Promise((resolve) => {
      const c = spawn("git", ["--git-dir", path.dirname(path.dirname(gitdir)), "worktree", "prune"], { stdio: "ignore", windowsHide: true });
      c.once("error", resolve); c.once("exit", resolve);
    });
  }
}

export async function scanDisk({ home = findHome(), onProgress } = {}) {
  const { byPath, roots } = folderOwners(home);
  for (const root of roots) {
    for (const p of fs.readdirSync(root, { withFileTypes: true })) {
      if (!p.isDirectory()) continue;
      for (const w of fs.readdirSync(path.join(root, p.name), { withFileTypes: true })) {
        if (w.isDirectory()) folders.push({ path: path.join(root, p.name, w.name), projectDir: p.name, name: w.name });
      }
    }
  }

  const stateDir = path.join(home, "session-state");
  const total = folders.length + 1;
  let done = 0;
  const tick = () => onProgress?.({ done: ++done, total });
  const items = [];
  await pool(folders, 4, async (f) => {
    const { bytes, files } = await dirSize(f.path);
    const m = byPath.get(norm(f.path));
    items.push({ path: f.path, name: f.name, project: m?.project || f.projectDir, bytes, files,
      status: m?.status || "orphan", openId: m?.openId || null, title: m?.title || null });
    tick();
  });
  const state = fs.existsSync(stateDir) ? await dirSize(stateDir) : { bytes: 0, files: 0 };
  tick();

  items.sort((a, b) => b.bytes - a.bytes);
  return {
    generatedAt: new Date().toISOString(),
    roots,
    total: items.reduce((t, x) => t + x.bytes, 0),
    items,
    sessionState: { path: stateDir, ...state },
  };
}
