// Dev E2E for 1.10.1: panel.copyPaths on ".." copies the panel's own dir path.
// Loads the app from the vite dev server in headless Edge, then drives the REAL
// command (runCommand("panel.copyPaths")) with the panels store seeded directly
// and navigator.clipboard.writeText replaced by a recorder. Store/command modules
// are imported through the exact URLs register-commands.ts itself uses, so the
// command handler closes over the instances we seed (the HMR-url lesson).
// Usage: node scripts/e2e-1-10-1-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9228;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-dev-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// reuse a dev server left running by a previous session if it serves this app
const alive = await fetch(`${ORIGIN}/`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
const ours = alive && alive.includes("Al-Navi") ? null : spawn("npm", ["run", "dev"], { shell: true, stdio: "ignore" });
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
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
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const ready = new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws error"));
  });
  return {
    ready,
    send(method, params = {}) {
      return new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

try {
  await waitFor(() => fetch(`${ORIGIN}/`).then((r) => (r.ok ? true : null)), 30000, "vite dev");
  const targets = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.find((t) => t.type === "page");
  }, 20000, "edge cdp");
  const cdp = await connect(targets.webSocketDebuggerUrl);
  await cdp.ready;
  const nav = await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  if (nav.errorText) throw new Error("nav: " + nav.errorText);
  await sleep(2500);

  const out = await evalIn(cdp, `
    (async () => {
      const imp = new Function("u", "return import(u)");
      const base = "${ORIGIN}/src/lib/";
      // resolve the exact (possibly HMR-suffixed) module URLs the commands use
      const src = await (await fetch(base + "register-commands.ts")).text();
      const u = (re) => new URL(src.match(re)[1], base).href;
      const panelsUrl = u(/from\\s+"([^"]*panels\\.svelte\\.ts[^"]*)"/);
      const searchUrl = u(/from\\s+"([^"]*search\\.svelte\\.ts[^"]*)"/);
      const commandsUrl = u(/from\\s+"([^"]*\\/commands[^"]*)"/);
      const { panels } = await imp(panelsUrl);
      const { searchStore } = await imp(searchUrl);
      const { runCommand } = await imp(commandsUrl);

      // clipboard recorder
      if (!navigator.clipboard) navigator.clipboard = {};
      const clip = [];
      navigator.clipboard.writeText = (t) => { clip.push(String(t)); return Promise.resolve(); };

      const p = panels.active;
      const t = p.tabs.find((x) => x.id === p.activeTabId) || p.tabs[0];
      const entry = (name, isDir = false) => ({ name, isDir, size: 1, mtime: 0, attrs: "", isSymlink: false, isHidden: false });
      const out = {};

      // a) ".." under the cursor, nothing marked -> the panel's own dir path
      t.path = "D:\\\\Docs";
      p.view = [entry("..", true), entry("a.txt"), entry("b.log")];
      p.cursor = 0;
      p.selected = new Set();
      runCommand("panel.copyPaths");
      out.up = clip.at(-1);

      // b) ".." under the cursor + marked files -> marked paths win (FAR semantics)
      p.selected = new Set(["a.txt"]);
      runCommand("panel.copyPaths");
      out.marked = clip.at(-1);
      p.selected = new Set();

      // c) regular file under the cursor -> its full path (unchanged behavior)
      p.cursor = 2;
      runCommand("panel.copyPaths");
      out.file = clip.at(-1);

      // d) search panel ".." -> where the search started
      p.cursor = 0;
      t.path = "search://";
      searchStore.originPath = "D:\\\\SearchRoot";
      runCommand("panel.copyPaths");
      out.search = clip.at(-1);

      // e) search panel ".." with no origin remembered -> literal panel path
      searchStore.originPath = null;
      runCommand("panel.copyPaths");
      out.searchNoOrigin = clip.at(-1);

      // f) empty panel (root, no ".." row) -> clipboard untouched
      t.path = "C:\\\\";
      p.view = [];
      p.cursor = 0;
      clip.length = 0;
      runCommand("panel.copyPaths");
      out.emptyWrites = clip.length;
      return out;
    })()
  `);
  check("'..' copies the panel dir path", out.up === "D:\\Docs", JSON.stringify(out.up));
  check("marked files win over '..'", out.marked === "D:\\Docs\\a.txt", JSON.stringify(out.marked));
  check("file under cursor still copies its path", out.file === "D:\\Docs\\b.log", JSON.stringify(out.file));
  check("search panel '..' copies the origin path", out.search === "D:\\SearchRoot", JSON.stringify(out.search));
  check("search panel without origin falls back to panel path", out.searchNoOrigin === "search://", JSON.stringify(out.searchNoOrigin));
  check("empty panel writes nothing", out.emptyWrites === 0, String(out.emptyWrites));

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
