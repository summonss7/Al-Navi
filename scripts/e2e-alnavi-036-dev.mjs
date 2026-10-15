// Dev E2E for alnavi-036: Ctrl+F6 (sort by size) must sort folders by their
// computed "≈" sizes too, not treat them all as 0. Verified against the vite
// dev build with a mocked Tauri backend, driving a REAL Ctrl+F6 key through
// CDP and delivering REAL dirsize events through the mocked event plugin:
//   - with no sizes yet the folders keep listing order (all raw 0)
//   - each dirsize event re-sorts the size-sorted panel in place; the cursor
//     row follows its entry by name (no jump to an unrelated row)
//   - dirs-first off: folders interleave with files by real bytes
//   - a second Ctrl+F6 reverses the order (smallest first)
//   - name sort (Ctrl+F3) ignores arriving folder sizes
//   - the "≈<size>" cell shows the computed size on the folder's row
// Usage: node scripts/e2e-alnavi-036-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9273;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-036-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = await fetch(`${ORIGIN}/`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
const vite = alive && alive.includes("Al-Navi") ? null : spawn("npm", ["run", "dev"], { shell: true, stdio: "ignore" });
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
    await sleep(100);
  }
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  };
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  return {
    ready, events,
    send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); },
    close: () => ws.close(),
  };
}
async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
async function key(cdp, name, vk, mods = 0) {
  const base = { key: name, code: name, windowsVirtualKeyCode: vk, modifiers: mods, location: 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}
const CTRL = 2;

async function bootstrap(cdp) {
  await cdp.send("Page.navigate", { url: `${ORIGIN}/?r=${Math.random().toFixed(8)}` });
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell") && !!document.querySelector(".cmdline input")`).catch(() => null), 30000, "app UI");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await evalIn(cdp, `
    (async () => {
      const mk = (name, isDir, size, mtime) => ({ name, isDir, size, mtime, attrs: "", isSymlink: false, isHidden: false });
      // listing order matters: with all folder sizes unknown (raw 0) a stable
      // size sort must keep this order among the folders
      const rows = [
        mk("alpha", true, 0, 1000),
        mk("zeta", true, 0, 1000),
        mk("mid", true, 0, 1000),
        mk("big.bin", false, 5000000, 1000),
        mk("tiny.txt", false, 900, 1000),
      ];
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      window.__cbs = {};
      window.__listeners = {};
      window.__e2e = { dirSizeRequests: [] };
      window.__TAURI_INTERNALS__.transformCallback = (cb) => {
        const id = ++window.__e2eCbSeq;
        window.__cbs[id] = cb;
        return id;
      };
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen":
            window.__listeners[args.event] = args.handler;
            return Promise.resolve(args.handler);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": return Promise.resolve({ path: args.path, entries: rows, freeBytes: 0, totalBytes: 0 });
          case "home_path": return Promise.resolve("D:\\\\e2e");
          case "drives_list": return Promise.resolve([]);
          case "load_json": return Promise.resolve(null);
          case "save_json": return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          case "dir_sizes":
            window.__e2e.dirSizeRequests.push(args.paths);
            return Promise.resolve(null); // the test emits dirsize events itself
          default: return Promise.resolve(null);
        }
      };
      // deliver a backend dirsize event through the real listen callback
      window.__emitDirSize = (path, size) => {
        const id = window.__listeners["dirsize"];
        if (!id || !window.__cbs[id]) throw new Error("no dirsize listener registered");
        window.__cbs[id]({ event: "dirsize", id, payload: { path, size } });
      };
      const imp = new Function("u", "return import(u)");
      const { panels } = await imp("${ORIGIN}/src/lib/stores/panels.svelte.ts");
      const { settings } = await imp("${ORIGIN}/src/lib/stores/settings.svelte.ts");
      window.__e2e.p = panels;
      window.__e2e.settings = settings;
      await panels.init();
      return { view: panels.left.view.length, mode: panels.left.sortMode };
    })()
  `);
  await waitFor(() => evalIn(cdp, `window.__e2e?.p?.left?.view?.length === 6 ? true : null`).catch(() => null), 15000, "left panel loaded");
  await sleep(400);
}

// left-panel facts: row names from the DOM, cursor row name, size cell text
const names = (cdp) => evalIn(cdp, `(() => {
  const panel = document.querySelectorAll(".panel")[0];
  return [...panel.querySelectorAll(".vlist .row")].map((r) => ({
    name: r.querySelector(".name").textContent,
    size: r.querySelector(".size").textContent,
    cursor: r.classList.contains("cursor"),
  }));
})()`);

try {
  const step = (m) => console.log(`-- ${m}`);
  step("waiting vite");
  await waitFor(() => fetch(`${ORIGIN}/`).then((r) => (r.ok ? true : null)), 30000, "vite dev");
  step("waiting edge cdp");
  const targets = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.find((t) => t.type === "page");
  }, 20000, "edge cdp");
  const cdp = await connect(targets.webSocketDebuggerUrl);
  await cdp.ready;

  step("bootstrapping stores + backend mock");
  await bootstrap(cdp);

  step("initial state: name sort, folders on top");
  let rows = await names(cdp);
  check("boot order is name-sorted (dirs first)", rows.map((r) => r.name).join(",") === "..,alpha,mid,zeta,big.bin,tiny.txt", rows.map((r) => r.name).join(","));
  check("sizes were requested for the folders (both panels)", await evalIn(cdp, `JSON.stringify(window.__e2e.dirSizeRequests)`).then((s) => {
    const reqs = JSON.parse(s);
    return reqs.length === 2 && reqs.every((r) => r.length === 3);
  }), await evalIn(cdp, `JSON.stringify(window.__e2e.dirSizeRequests)`));

  step("Ctrl+F6 with no sizes yet: folders keep listing order as 0");
  await key(cdp, "F6", 117, CTRL);
  await sleep(250);
  rows = await names(cdp);
  check("size sort set (header col on)", await evalIn(cdp, `!!document.querySelectorAll(".panel")[0].querySelector(".col.size.on")`), "");
  check("unknown folders keep listing order below ..", rows.map((r) => r.name).join(",") === "..,alpha,zeta,mid,big.bin,tiny.txt", rows.map((r) => r.name).join(","));

  step("dirsize events arrive: zeta=7MB, alpha=1MB, mid=100KB");
  // cursor sits on zeta: after re-sorts the cursor row must still be zeta
  await evalIn(cdp, `(() => { const p = window.__e2e.p.left; p.cursor = p.view.findIndex((e) => e.name === "zeta"); return p.current?.name; })()`);
  await evalIn(cdp, `window.__emitDirSize("D:\\\\e2e\\\\zeta", 7000000)`);
  await sleep(150);
  rows = await names(cdp);
  check("zeta (7MB) jumps to the top of the folders", rows.map((r) => r.name).join(",") === "..,zeta,alpha,mid,big.bin,tiny.txt", rows.map((r) => r.name).join(","));
  check("cursor row still zeta after the re-sort", rows.find((r) => r.cursor)?.name === "zeta", `cursor=${rows.find((r) => r.cursor)?.name}`);
  const zetaSize = rows.find((r) => r.name === "zeta")?.size;
  check("zeta shows its computed ≈ size", /^≈6\.68 MB$/.test(zetaSize ?? ""), `cell="${zetaSize}"`);

  await evalIn(cdp, `window.__emitDirSize("D:\\\\e2e\\\\alpha", 1000000)`);
  await evalIn(cdp, `window.__emitDirSize("D:\\\\e2e\\\\mid", 100000)`);
  await sleep(200);
  rows = await names(cdp);
  check("folders ordered by size: zeta, alpha, mid", rows.slice(0, 4).map((r) => r.name).join(",") === "..,zeta,alpha,mid", rows.map((r) => r.name).join(","));

  step("dirs-first off: folders interleave with files by real bytes");
  // the UI path (options dialog) toggles the setting and refreshes both panels
  await evalIn(cdp, `(() => { const s = window.__e2e.settings; s.set({ dirsFirst: false }); window.__e2e.p.refreshView(); return true; })()`);
  await sleep(200);
  rows = await names(cdp);
  check("zeta(7MB) big.bin(5MB) alpha(1MB) mid(100KB) tiny(900B)", rows.map((r) => r.name).join(",") === "..,zeta,big.bin,alpha,mid,tiny.txt", rows.map((r) => r.name).join(","));
  await evalIn(cdp, `(() => { const s = window.__e2e.settings; s.set({ dirsFirst: true }); window.__e2e.p.refreshView(); return true; })()`);

  step("second Ctrl+F6 reverses: smallest first");
  await key(cdp, "F6", 117, CTRL);
  await sleep(250);
  rows = await names(cdp);
  check("reversed order: mid(100KB) first, big.bin(5MB) last", rows.map((r) => r.name).join(",") === "..,mid,alpha,zeta,tiny.txt,big.bin", rows.map((r) => r.name).join(","));
  await key(cdp, "F6", 117, CTRL); // back to largest-first for the red check
  await sleep(250);

  step("red check: name sort (Ctrl+F3) ignores arriving folder sizes");
  await key(cdp, "F3", 114, CTRL);
  await sleep(250);
  await evalIn(cdp, `window.__emitDirSize("D:\\\\e2e\\\\mid", 99000000)`);
  await sleep(200);
  rows = await names(cdp);
  check("name-sorted order unchanged by a folder size", rows.map((r) => r.name).join(",") === "..,alpha,mid,zeta,big.bin,tiny.txt", rows.map((r) => r.name).join(","));

  step("console errors");
  const errors = cdp.events.filter((e) =>
    (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") ||
    (e.method === "Runtime.exceptionThrown") ||
    (e.method === "Log.entryAdded" && e.params.entry.level === "error"),
  );
  const errText = (e) => {
    if (e.method === "Log.entryAdded") return `${e.params.entry.text} ${e.params.entry.url ?? ""}`;
    return (e.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
  };
  const real = errors.filter((e) => !/favicon|404 \(Not Found\)/.test(errText(e)));
  check("no console errors", real.length === 0, real.map(errText).join(" | "));
  if (real.length !== errors.length) console.log(`(ignored ${errors.length - real.length} dev-harness 404 noise: ${errors.filter((e) => !real.includes(e)).map(errText).join(" | ")})`);

  cdp.close();
} finally {
  edge.kill();
  if (vite) vite.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
