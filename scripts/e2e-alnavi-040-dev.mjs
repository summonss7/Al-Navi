// Dev E2E for alnavi-040: Ctrl+E recalls the PREVIOUS command line command.
// The walk direction was inverted since 0.2.7 — submit() stores the newest
// command FIRST (history[0]), but stepHistory started the walk at the array
// end, so the first Ctrl+E recalled the OLDEST of the ~100 stored commands
// (looked like a random ancient command, i.e. "the feature doesn't work").
// Fixed walk: Ctrl+E = newest → older (clamped at the oldest), Ctrl+X = the
// FAR companion walking back toward the newest, past it — the half-typed
// draft; the recalled command lands SELECTED (typing replaces, Enter runs);
// Esc clears the line AND the walk position.
// The Tauri backend is mocked via Page.addScriptToEvaluateOnNewDocument —
// BEFORE the app boots, so the app's own cmdline.init() loads the seeded
// history (a post-load mock leaves the app-side history empty and the
// chords recall nothing). REAL keys are driven through CDP.
// Usage: node scripts/e2e-alnavi-040-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9275;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-040-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// stored the way submit() writes it: NEWEST FIRST (the real file order)
const HIST = ["newest-040", "mid-040", "old-040"];

// installed before any app script runs: the app's own init() must see it
const INIT_MOCK = `
(() => {
  const mk = (name, isDir, size, mtime) => ({ name, isDir, size, mtime, attrs: "", isSymlink: false, isHidden: false });
  const rows = [mk("notes.txt", false, 100, 1000)];
  window.__e2eCbSeq = 0;
  window.__cbs = {};
  window.__e2e = { shells: [], saves: [], booted: false };
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  // windowState.ts calls getCurrentWindow() at module load when internals exist
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
      case "load_json": return Promise.resolve(args.name === "cmd-history.json" ? ${JSON.stringify(HIST)} : null);
      case "save_json": { window.__e2e.saves.push({ name: args.name, data: args.data }); return Promise.resolve(null); }
      case "free_space": return Promise.resolve([0, 0]);
      case "run_shell": { window.__e2e.shells.push(args.commandLine); return Promise.resolve(""); }
      default: return Promise.resolve(null);
    }
  };
  // keep the silent update check quiet: an unreachable center degrades silently
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
  await cdp.send("Input.dispatchKeyEvent", { ...def, type: "keyUp" });
}
const CTRL = 2, ALT = 1;
const ctrlE = () => key({ key: "e", code: "KeyE", windowsVirtualKeyCode: 69, modifiers: CTRL });
const ctrlX = () => key({ key: "x", code: "KeyX", windowsVirtualKeyCode: 88, modifiers: CTRL });
const esc = () => key({ key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
const enter = () => key({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });

const lineFacts = () => evalIn(cdp, `(() => {
  const i = document.querySelector(".cmdline input");
  return { value: i?.value ?? null, focused: document.activeElement === i,
    sel: i ? [i.selectionStart, i.selectionEnd] : null, dlg: !!document.querySelector(".dlg") };
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
  await sleep(1200); // let the app's own cmdline.init() settle

  await evalIn(cdp, `document.querySelector(".cmdline input").focus(); true`);
  let f = await lineFacts();
  check("line focused and empty at start", f.focused === true && f.value === "", JSON.stringify(f));

  step("Ctrl+E walks newest -> older, clamped at the oldest");
  await ctrlE(); await sleep(120);
  f = await lineFacts();
  check("1st Ctrl+E recalls the LAST command (newest)", f.value === "newest-040", JSON.stringify(f));
  check("recalled command is selected (typing replaces, Enter runs)", f.sel?.[0] === 0 && f.sel?.[1] === "newest-040".length, `sel=${JSON.stringify(f.sel)}`);
  await ctrlE(); await sleep(120);
  f = await lineFacts();
  check("2nd Ctrl+E goes one older", f.value === "mid-040", f.value);
  await ctrlE(); await sleep(120);
  f = await lineFacts();
  check("3rd Ctrl+E reaches the oldest", f.value === "old-040", f.value);
  await ctrlE(); await sleep(120);
  f = await lineFacts();
  check("4th Ctrl+E clamps at the oldest (no wrap)", f.value === "old-040", f.value);

  step("Ctrl+X walks forward, past the newest back to the draft");
  await ctrlX(); await sleep(120);
  f = await lineFacts();
  check("Ctrl+X goes one newer", f.value === "mid-040", f.value);
  await ctrlX(); await sleep(120);
  f = await lineFacts();
  check("Ctrl+X reaches the newest", f.value === "newest-040", f.value);
  await ctrlX(); await sleep(120);
  f = await lineFacts();
  check("Ctrl+X past the newest restores the empty draft", f.value === "", f.value);

  step("half-typed draft survives the walk");
  await cdp.send("Input.insertText", { text: "par" });
  await sleep(80);
  await ctrlE(); await sleep(120);
  f = await lineFacts();
  check("Ctrl+E from a draft recalls the newest", f.value === "newest-040", f.value);
  await ctrlX(); await sleep(120);
  f = await lineFacts();
  check("Ctrl+X returns the half-typed draft intact", f.value === "par", f.value);

  step("Esc clears the line AND the walk position");
  await ctrlE(); await sleep(120); // newest
  await esc(); await sleep(120);
  f = await lineFacts();
  check("Esc empties the line", f.value === "", f.value);
  await ctrlE(); await sleep(120);
  f = await lineFacts();
  check("after Esc the next Ctrl+E starts from the newest again", f.value === "newest-040", f.value);

  step("typing over the selected recall replaces it, Enter runs it");
  await cdp.send("Input.insertText", { text: "renamed-040" });
  await sleep(80);
  f = await lineFacts();
  check("typing replaced the selected recall", f.value === "renamed-040", f.value);
  await enter(); await sleep(300);
  const shells = await evalIn(cdp, `window.__e2e.shells`);
  const saves = await evalIn(cdp, `window.__e2e.saves`);
  check("Enter executed the edited recall", JSON.stringify(shells) === JSON.stringify(["renamed-040"]), JSON.stringify(shells));
  const save = saves?.find((s) => s.name === "cmd-history.json");
  check("submit put the command on top of the saved history",
    !!save && save.data?.[0] === "renamed-040" && Object.keys(save.data ?? {}).length === 4,
    JSON.stringify(save?.data));
  f = await lineFacts();
  check("line cleared after submit", f.value === "", f.value);

  step("Russian layout: physical Ctrl+E (key 'у') still recalls");
  await key({ key: "у", code: "KeyE", windowsVirtualKeyCode: 69, modifiers: CTRL }); await sleep(120);
  f = await lineFacts();
  check("Ctrl+у (RU layout, physical E) recalls the newest", f.value === "renamed-040", f.value);
  await esc(); await sleep(100);

  step("Alt+F8 history dialog still opens (regression)");
  await key({ key: "F8", code: "F8", windowsVirtualKeyCode: 119, modifiers: ALT }); await sleep(300);
  f = await lineFacts();
  check("Alt+F8 opens a dialog", f.dlg === true, `dlg=${f.dlg}`);
  const histRows = await evalIn(cdp, `[...document.querySelectorAll(".dlg .li, .dlg [class*=row], .dlg .list > *")].map((r) => r.textContent.trim()).slice(0, 5)`);
  check("history dialog lists the newest command first", Array.isArray(histRows) && histRows.some((t) => /renamed-040/.test(t)), JSON.stringify(histRows));
  await esc(); await sleep(200);

  step("F1 help lists the Ctrl+X row (i18n + help.ts regression)");
  await key({ key: "F1", code: "F1", windowsVirtualKeyCode: 112 }); await sleep(400);
  const helpHas = await evalIn(cdp, `(() => {
    const t = document.body.textContent;
    return { ctrlX: /Ctrl\\+X/.test(t), ctrlE: /Ctrl\\+E/.test(t) };
  })()`);
  check("F1 help shows both Ctrl+E and Ctrl+X chords", helpHas?.ctrlE === true && helpHas?.ctrlX === true, JSON.stringify(helpHas));
  await esc(); await sleep(150);
} catch (e) {
  console.error(e);
} finally {
  edge.kill();
  try { vite?.kill(); } catch {}
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
}
