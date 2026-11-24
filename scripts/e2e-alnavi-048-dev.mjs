// Dev E2E for alnavi-048: Alt+F3 re-reads the occupied size of the folder
// under the cursor (FAR-style manual "≈" recompute). Verified against the
// vite dev build with a mocked Tauri backend, driving a REAL Alt+F3 key
// through CDP and delivering a REAL dirsize event through the mocked event
// plugin:
//   - on a folder: one dir_sizes walk for exactly that folder, tagged
//     "<side>:manual" (the panel's background auto-walk tag stays untouched),
//     a toast names the target, and the delivered size lands in the "≈" cell
//   - on a file: no walk, a hint toast (recursive size is for local folders)
//   - on "..": the target is the folder being viewed itself
// Usage: node scripts/e2e-alnavi-048-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9273;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-048-"));
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
const ALT = 1;

async function bootstrap(cdp) {
  await cdp.send("Page.navigate", { url: `${ORIGIN}/?r=${Math.random().toFixed(8)}` });
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell") && !!document.querySelector(".cmdline input")`).catch(() => null), 30000, "app UI");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await evalIn(cdp, `
    (async () => {
      const mk = (name, isDir, size, mtime) => ({ name, isDir, size, mtime, attrs: "", isSymlink: false, isHidden: false });
      const rows = [
        mk("alpha", true, 0, 1000),
        mk("zeta", true, 0, 1000),
        mk("file.txt", false, 900, 1000),
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
          case "read_text": return Promise.resolve({ text: "e2e file content\\n", encoding: "utf-8", bom: false, eol: "lf", size: 17, truncated: false });
          case "dir_sizes":
            window.__e2e.dirSizeRequests.push({ paths: args.paths, tag: args.tag });
            return Promise.resolve(null); // the test emits dirsize events itself
          default: return Promise.resolve(null);
        }
      };
      // deliver a backend dirsize event through the real listen callback
      window.__emitDirSize = (path, size) => {
        const id = window.__listeners["dirsize"];
        if (!id || !window.__cbs[id]) throw new Error("no dirsize listener registered");
        window.__cbs[id]({ event: "dirsize", id, payload: { items: [{ path, size }] } });
      };
      const imp = new Function("u", "return import(u)");
      const { panels } = await imp("${ORIGIN}/src/lib/stores/panels.svelte.ts");
      window.__e2e.p = panels;
      await panels.init();
      return { view: panels.left.view.length };
    })()
  `);
  await waitFor(() => evalIn(cdp, `window.__e2e?.p?.left?.view?.length === 4 ? true : null`).catch(() => null), 15000, "left panel loaded");
  await sleep(400);
}

// left-panel facts: row names from the DOM, size cell text, cursor row name
const rows = (cdp) => evalIn(cdp, `(() => {
  const panel = document.querySelectorAll(".panel")[0];
  return [...panel.querySelectorAll(".vlist .row")].map((r) => ({
    name: r.querySelector(".name").textContent,
    size: r.querySelector(".size").textContent,
    cursor: r.classList.contains("cursor"),
  }));
})()`);
const lastReq = (cdp) => evalIn(cdp, `JSON.stringify(window.__e2e.dirSizeRequests.at(-1) ?? null)`);
const toast = (cdp) => evalIn(cdp, `document.querySelector(".toast")?.textContent ?? null`);
const cursorTo = (cdp, name) => evalIn(cdp, `(() => { const p = window.__e2e.p.left; p.cursor = p.view.findIndex((e) => e.name === ${JSON.stringify(name)}); return p.current?.name; })()`);

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
  const auto = await evalIn(cdp, `JSON.stringify(window.__e2e.dirSizeRequests)`);
  check("background auto-walk requested both folders for each panel's own tag", JSON.parse(auto).length === 2
    && JSON.parse(auto).every((r) => r.tag === "left" || r.tag === "right"), auto);

  step("Alt+F3 on a folder: exactly that folder, :manual tag, toast names it");
  await cursorTo(cdp, "alpha");
  await key(cdp, "F3", 114, ALT);
  await sleep(250);
  const req = JSON.parse(await lastReq(cdp) ?? "null");
  check("one walk: [alpha] with tag left:manual", JSON.stringify(req) === JSON.stringify({ paths: ["D:\\e2e\\alpha"], tag: "left:manual" }), JSON.stringify(req));
  const t1 = await toast(cdp);
  check("toast names the target folder", (t1 ?? "").includes("alpha"), `toast="${t1}"`);

  step("the delivered size lands in the ≈ cell of the folder's row");
  await evalIn(cdp, `window.__emitDirSize("D:\\\\e2e\\\\alpha", 1234567)`);
  await sleep(200);
  let r = await rows(cdp);
  const alphaSize = r.find((x) => x.name === "alpha")?.size;
  check("alpha row shows ≈1.18 MB", /^≈1\.18 MB$/.test(alphaSize ?? ""), `cell="${alphaSize}"`);

  step("Alt+F3 on a file: no walk, hint toast");
  const before = await evalIn(cdp, `window.__e2e.dirSizeRequests.length`);
  await cursorTo(cdp, "file.txt");
  await key(cdp, "F3", 114, ALT);
  await sleep(250);
  const after = await evalIn(cdp, `window.__e2e.dirSizeRequests.length`);
  const t2 = await toast(cdp);
  check("no dir_sizes walk for a file", after === before, `before=${before} after=${after}`);
  check("hint toast: recursive size is for local folders", (t2 ?? "").includes("Alt+F3"), `toast="${t2}"`);

  step("Alt+F3 on \"..\": the target is the viewed folder itself");
  await cursorTo(cdp, "..");
  await key(cdp, "F3", 114, ALT);
  await sleep(250);
  const reqUp = JSON.parse(await lastReq(cdp) ?? "null");
  check("one walk: [D:\\e2e] with tag left:manual", JSON.stringify(reqUp) === JSON.stringify({ paths: ["D:\\e2e"], tag: "left:manual" }), JSON.stringify(reqUp));

  step("plain F3 still opens the viewer (chord untouched)");
  await cursorTo(cdp, "file.txt");
  await key(cdp, "F3", 114, 0);
  await sleep(400);
  const viewer = await evalIn(cdp, `!!document.querySelector(".viewer")`);
  check("F3 opened the viewer area", viewer === true, `viewer=${viewer}`);
  await key(cdp, "Escape", 27, 0); // close the viewer back to panels
  await sleep(250);

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
