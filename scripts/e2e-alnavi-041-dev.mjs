// Dev E2E for alnavi-041: the group-select keys + / - / * (main row and the
// numpad "gray" spellings) opened the mask dialog even while a command was
// being typed — `ping` SPACE `-` popped the deselect-by-mask dialog instead
// of typing the minus, and the same happened on the Ctrl+O screen (both
// panels hidden, the line is the whole UI). Now the chords fire their panel
// command ONLY with an EMPTY line over VISIBLE panels; otherwise the
// character types into the command line. REAL keys are driven through CDP
// (keyDown with text, so preventDefault/no-preventDefault decides whether
// the char lands in the input — same as physical typing).
// Usage: node scripts/e2e-alnavi-041-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9276;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-041-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// installed before any app script runs (see e2e-040 for the rationale)
const INIT_MOCK = `
(() => {
  const mk = (name, isDir, size, mtime) => ({ name, isDir, size, mtime, attrs: "", isSymlink: false, isHidden: false });
  const rows = [mk("notes.txt", false, 100, 1000), mk("pic.jpg", false, 200, 2000), mk("data", true, 0, 3000)];
  window.__e2eCbSeq = 0;
  window.__cbs = {};
  window.__e2e = { shells: [], saves: [] };
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = { currentWindow: "main", currentWebview: "main" };
  window.__TAURI_INTERNALS__.transformCallback = (cb) => {
    const id = ++window.__e2eCbSeq;
    window.__cbs[id] = cb;
    return id;
  };
  window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
    switch (cmd) {
      case "plugin:event|listen":
        window.__cbs[args.handler] = args.handler;
        return Promise.resolve(args.handler);
      case "plugin:event|unlisten": return Promise.resolve();
      case "list_dir": return Promise.resolve({ path: args.path, entries: rows, freeBytes: 0, totalBytes: 0 });
      case "home_path": return Promise.resolve("D:\\\\e2e");
      case "drives_list": return Promise.resolve([]);
      case "load_json": return Promise.resolve(null);
      case "save_json": { window.__e2e.saves.push({ name: args.name, data: args.data }); return Promise.resolve(null); }
      case "free_space": return Promise.resolve([0, 0]);
      case "run_shell": { window.__e2e.shells.push(args.commandLine); return Promise.resolve(""); }
      default: return Promise.resolve(null);
    }
  };
  // keep the silent update check quiet
  const origFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => /updates\\/alnavi/.test(String(url))
    ? Promise.reject(new Error("e2e: update center blocked"))
    : origFetch(url, opts);
})();
`;

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
let cdp;
async function key(def) {
  await cdp.send("Input.dispatchKeyEvent", { ...def, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode, type: "keyUp" });
}
const CTRL = 2;
// keyDown events carry `text` so the browser performs the char insertion —
// exactly what a physical keypress does, preventDefault included
const minus = () => key({ key: "-", code: "Minus", windowsVirtualKeyCode: 189, text: "-" });
const numpadMinus = () => key({ key: "-", code: "NumpadSubtract", windowsVirtualKeyCode: 109, text: "-" });
const numpadPlus = () => key({ key: "+", code: "NumpadAdd", windowsVirtualKeyCode: 107, text: "+" });
const numpadStar = () => key({ key: "*", code: "NumpadMultiply", windowsVirtualKeyCode: 106, text: "*" });
const ctrlO = () => key({ key: "o", code: "KeyO", windowsVirtualKeyCode: 79, modifiers: CTRL });
const esc = () => key({ key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
const enter = () => key({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });

const lineFacts = () => evalIn(cdp, `(() => {
  const i = document.querySelector(".cmdline input");
  return { value: i?.value ?? null, focused: document.activeElement === i,
    dlg: !!document.querySelector(".dlg"), panelsHidden: !!document.querySelector(".panels.none"),
    maskDefault: document.querySelector(".dlg input")?.value ?? null };
})()`);
const type = (t) => cdp.send("Input.insertText", { text: t });

try {
  const step = (m) => console.log(`-- ${m}`);
  step("waiting vite");
  await waitFor(() => fetch(`${ORIGIN}/`).then((r) => (r.ok ? true : null)), 30000, "vite dev");
  step("waiting edge cdp");
  const targets = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.find((t) => t.type === "page");
  }, 20000, "edge cdp");
  cdp = await connect(targets.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  step("installing pre-boot mock + navigating");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT_MOCK });
  await cdp.send("Page.navigate", { url: `${ORIGIN}/?r=${Math.random().toFixed(8)}` });
  try {
    await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell") && !!document.querySelector(".cmdline input")`), 30000, "app UI");
  } catch (e) {
    const state = await evalIn(cdp, `({ url: location.href, title: document.title, mock: !!window.__TAURI_INTERNALS__?.invoke, body: document.body ? document.body.innerHTML.slice(0, 300) : "NO BODY" })`).catch((err) => String(err));
    console.error("page state:", JSON.stringify(state));
    const errs = cdp.events
      .filter((ev) => ev.method === "Runtime.exceptionThrown" || (ev.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(ev.params?.type)))
      .map((ev) => ev.method === "Runtime.exceptionThrown"
        ? ev.params.exceptionDetails?.exception?.description ?? JSON.stringify(ev.params.exceptionDetails)
        : ev.params.args?.map((a) => a.value ?? a.description ?? a.type).join(" "))
      .slice(0, 8);
    console.error("page errors:", JSON.stringify(errs, null, 1));
    throw e;
  }
  await waitFor(() => evalIn(cdp, `!!window.__TAURI_INTERNALS__.invoke`), 5000, "mock active");
  await sleep(1200); // let the app settle

  await evalIn(cdp, `document.querySelector(".cmdline input").focus(); true`);
  let f = await lineFacts();
  check("line focused and empty at start, panels visible", f.focused === true && f.value === "" && f.panelsHidden === false, JSON.stringify(f));

  step("the reported bug: typing `ping -t 8.8.8.8` (real minus key)");
  await type("ping ");
  await minus(); await sleep(80);
  f = await lineFacts();
  check("minus mid-command TYPES into the line (no mask dialog)", f.value === "ping -" && f.dlg === false, JSON.stringify(f));
  await type("t 8.8.8.8"); await sleep(80);
  f = await lineFacts();
  check("full command assembled: `ping -t 8.8.8.8`", f.value === "ping -t 8.8.8.8", f.value);
  await enter(); await sleep(300);
  const shells1 = await evalIn(cdp, `window.__e2e.shells`);
  f = await lineFacts();
  check("Enter executes `ping -t 8.8.8.8` via the shell", JSON.stringify(shells1) === JSON.stringify(["ping -t 8.8.8.8"]), JSON.stringify(shells1));
  check("line cleared after submit", f.value === "", f.value);

  step("gray spellings with text in the line also type");
  await type("abc"); await numpadMinus(); await sleep(100);
  f = await lineFacts();
  check("Gray- mid-text types (no deselect dialog)", f.value === "abc-" && f.dlg === false, JSON.stringify(f));
  await esc(); await sleep(100);
  await type("abc"); await numpadPlus(); await sleep(100);
  f = await lineFacts();
  check("Gray+ mid-text types (no mask dialog)", f.value === "abc+" && f.dlg === false, JSON.stringify(f));
  await esc(); await sleep(100);
  await type("abc"); await numpadStar(); await sleep(100);
  f = await lineFacts();
  check("Gray* mid-text types (no invert)", f.value === "abc*" && f.dlg === false, JSON.stringify(f));
  await esc(); await sleep(100);

  step("Ctrl+O screen: panels hidden, ALL characters type (even on an empty line)");
  await ctrlO(); await sleep(200);
  f = await lineFacts();
  check("Ctrl+O hides both panels", f.panelsHidden === true, `panelsHidden=${f.panelsHidden}`);
  await numpadPlus(); await sleep(100);
  f = await lineFacts();
  check("Gray+ on EMPTY line in Ctrl+O types +", f.value === "+" && f.dlg === false, JSON.stringify(f));
  await minus(); await sleep(100);
  f = await lineFacts();
  check("main-row minus in Ctrl+O types -", f.value === "+-" && f.dlg === false, JSON.stringify(f));
  await esc(); await sleep(100);
  await type("ping "); await minus(); await type("t 1.1.1.1"); await sleep(100);
  f = await lineFacts();
  check("full command types on the Ctrl+O screen", f.value === "ping -t 1.1.1.1" && f.dlg === false, JSON.stringify(f));
  await enter(); await sleep(300);
  const shells2 = await evalIn(cdp, `window.__e2e.shells`);
  check("Enter on the Ctrl+O screen executes it", JSON.stringify(shells2) === JSON.stringify(["ping -t 8.8.8.8", "ping -t 1.1.1.1"]), JSON.stringify(shells2));

  step("panels back: mask select STILL fires on an empty line (FAR parity)");
  await ctrlO(); await sleep(200);
  f = await lineFacts();
  check("Ctrl+O brings the panels back", f.panelsHidden === false, `panelsHidden=${f.panelsHidden}`);
  await numpadPlus(); await sleep(300);
  f = await lineFacts();
  check("Gray+ on empty line over visible panels opens the mask dialog", f.dlg === true && f.maskDefault === "*", JSON.stringify(f));
  await esc(); await sleep(200);
  await minus(); await sleep(300);
  f = await lineFacts();
  check("main-row minus on empty line opens the deselect dialog", f.dlg === true, `dlg=${f.dlg}`);
  await esc(); await sleep(200);
  await numpadMinus(); await sleep(300);
  f = await lineFacts();
  check("Gray- on empty line opens the deselect dialog", f.dlg === true, `dlg=${f.dlg}`);
  await esc(); await sleep(200);
  f = await lineFacts();
  check("Esc closes the dialogs, line empty, focus back", f.dlg === false && f.value === "" && f.focused === true, JSON.stringify(f));
} catch (e) {
  console.error(e);
} finally {
  edge.kill();
  try { vite?.kill(); } catch {}
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
}
