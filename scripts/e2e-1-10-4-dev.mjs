// Dev E2E for 1.10.4: entering a folder puts the cursor on ".." (not on the
// old numeric position or a coincidentally same-named entry), and leaving a
// folder (.., Ctrl+PgUp) puts the cursor back on the exited folder's row.
// Loads the app from the vite dev server in headless Edge, installs a fake
// list_dir backend into window.__TAURI_INTERNALS__.invoke and drives the REAL
// store methods (load/enter/up/historyBack) plus the rendered cursor row.
// Also regression-checks that same-dir reloads and re-sorts keep the cursor
// on its entry, and that the search-jump pendingFocusName still wins.
// Usage: node scripts/e2e-1-10-4-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9234;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-1104-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = (name) => ({ name, isDir: true, size: 0, mtime: 0, attrs: "", isSymlink: false, isHidden: false });
const file = (name, size = 1) => ({ name, isDir: false, size, mtime: 0, attrs: "", isSymlink: false, isHidden: false });
const P = {
  root: "D:\\E2E-1104",
  target: "D:\\E2E-1104\\target",
  loop: "D:\\E2E-1104\\loop",
};
// the fixture reproduces both faces of the bug: "target" sits deep in the
// parent listing (numeric position 3 would land on "c.txt" inside), and "loop"
// contains a nested "loop" (the old by-name carryover landed exactly on it)
const FS = {
  [P.root]: [dir("alpha"), file("aa.txt", 500), dir("loop"), file("mm.txt", 100), dir("target"), file("zz.txt", 900)],
  [P.target]: [file("a.txt"), file("b.txt"), file("c.txt"), file("d.txt"), file("e.txt"), file("f.txt")],
  [P.loop]: [dir("loop"), file("x.txt", 5)],
};

const alive = await fetch(`${ORIGIN}/`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
const ours = alive && alive.includes("Al-Navi") ? null : spawn("npm", ["run", "dev"], { shell: true, stdio: "ignore" });
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  "--window-size=1280,800",
  "about:blank",
], { stdio: "ignore" });

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  return { ready, send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); }, close: () => ws.close() };
}
async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

// the whole scenario runs in-page against the real panels store (imported
// through the exact URL register-commands.ts uses — the HMR-instance lesson)
const scenario = `
  (async () => {
    const imp = new Function("u", "return import(u)");
    const base = "${ORIGIN}/src/lib/";
    const src = await (await fetch(base + "register-commands.ts")).text();
    const u = (re) => new URL(src.match(re)[1], base).href;
    const { panels } = await imp(u(/from\\s+"([^"]*panels\\.svelte\\.ts[^"]*)"/));

    const FS = ${JSON.stringify(FS)};
    const P = ${JSON.stringify(P)};
    window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
    window.__TAURI_INTERNALS__.invoke = (cmd, args) => new Promise((resolve, reject) => {
      if (cmd === "list_dir") {
        const entries = FS[args.path];
        if (!entries) { reject(new Error("no such dir: " + args.path)); return; }
        resolve({ path: args.path, entries, freeBytes: 123, totalBytes: 456 });
        return;
      }
      resolve(null);
    });

    const p = panels.active;
    const out = {};
    const name = () => p.current?.name ?? null;
    const idxOf = (n) => p.view.findIndex((e) => e.name === n);

    // A) Enter a folder from a deep cursor position -> cursor lands on ".."
    await p.load(P.root);
    p.cursor = idxOf("target");
    out.a = { before: { path: p.path, cur: name(), idx: p.cursor } };
    await p.enter();
    out.a.after = { path: p.path, cur: name(), idx: p.cursor, view0: p.view[0]?.name };

    // B) same-name trap: the child contains an entry named like the entered dir
    await p.load(P.root);
    p.cursor = idxOf("loop");
    await p.enter();
    out.b = { path: p.path, cur: name(), idx: p.cursor, nestedLoopIdx: idxOf("loop") };

    // C) up() puts the cursor back on the exited folder
    await p.load(P.target);
    await p.up();
    out.c = { path: p.path, cur: name() };

    // D) Enter on ".." behaves like up
    await p.load(P.loop);
    p.cursor = 0;
    await p.enter();
    out.d = { path: p.path, cur: name() };

    // E) same-dir reload (Ctrl+R / watcher) keeps the cursor on its entry
    await p.load(P.root);
    p.cursor = idxOf("mm.txt");
    await p.load(p.path, { push: false });
    out.e = { cur: name() };

    // F) re-sort keeps the cursor on the same entry
    p.sortMode = "size";
    p.rebuild();
    const afterSort = name();
    p.sortMode = "name";
    p.rebuild();
    out.f = { afterSort, restored: name() };

    // G) search-jump pendingFocusName survives the path change
    await p.load(P.loop);
    p.pendingFocusName = "zz.txt";
    await p.load(P.root);
    out.g = { path: p.path, cur: name() };

    // H) history back after entering resets to ".."
    await p.load(P.root);
    p.cursor = idxOf("target");
    await p.enter();
    await p.historyBack();
    out.h = { path: p.path, cur: name() };

    // I) the rendered panel follows: cursor row is ".." right after an Enter
    await p.load(P.root);
    p.cursor = idxOf("target");
    await p.enter();
    await new Promise((r) => setTimeout(r, 200));
    out.i = {
      path: p.path,
      cursorRow: document.querySelector(".panel.active .vlist .row.cursor .name")?.getAttribute("title") ?? null,
      rows: [...document.querySelectorAll(".panel.active .vlist .row .name")].map((n) => n.getAttribute("title")),
    };
    return out;
  })()
`;

try {
  await waitFor(() => fetch(`${ORIGIN}/`).then((r) => (r.ok ? true : null)), 30000, "vite dev");
  const targets = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.find((t) => t.type === "page");
  }, 20000, "edge cdp");
  const cdp = await connect(targets.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  await sleep(2500);

  const o = await evalIn(cdp, scenario);

  check("A: entered folder from a deep position", o.a.before.idx >= 2 && o.a.before.cur === "target", `idx=${o.a.before.idx}`);
  check("A: cursor lands on '..' (not the old index)", o.a.after.cur === ".." && o.a.after.idx === 0 && o.a.after.view0 === "..",
    `cur=${o.a.after.cur} idx=${o.a.after.idx}`);
  check("B: same-named child entry does not capture the cursor", o.b.cur === ".." && o.b.idx === 0,
    `cur=${o.b.cur} (nested loop at ${o.b.nestedLoopIdx})`);
  check("C: up() puts the cursor on the exited folder", o.c.path === P.root && o.c.cur === "target", `cur=${o.c.cur}`);
  check("D: Enter on '..' also lands on the exited folder", o.d.path === P.root && o.d.cur === "loop", `cur=${o.d.cur}`);
  check("E: same-dir reload keeps the cursor entry", o.e.cur === "mm.txt", `cur=${o.e.cur}`);
  check("F: re-sort keeps the cursor entry", o.f.afterSort === "mm.txt" && o.f.restored === "mm.txt", JSON.stringify(o.f));
  check("G: search-jump focus survives the path change", o.g.path === P.root && o.g.cur === "zz.txt", `cur=${o.g.cur}`);
  check("H: history back resets to '..'", o.h.path === P.root && o.h.cur === "..", `cur=${o.h.cur}`);
  check("I: rendered cursor row is '..' after Enter", o.i.cursorRow === ".." && o.i.rows[0] === ".." && o.i.rows.includes("c.txt"),
    `row=${o.i.cursorRow}`);

  cdp.close();
} catch (e) {
  check("script ran", false, String(e));
} finally {
  edge.kill();
  if (ours) ours.kill();
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 500);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
