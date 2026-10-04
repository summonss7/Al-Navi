// exe-level E2E for alnavi-024: in the REAL released exe, the command line
// must support keyboard text selection — Shift+←/→ by char, Ctrl+Shift+←/→ by
// word (repeated presses select the whole line), Shift+Home/End to the line
// start/end — while the panel cursor does NOT move. Up/Down with text keep
// driving the panel, Esc clears the line, and the F1 help lists the new keys
// (i18n shipped in the build). Enter is never pressed: no real command runs.
// The app's real config (%APPDATA%\al-navi) is backed up and restored.
// Usage: node scripts/e2e-alnavi-024-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const CFG = join(process.env.APPDATA, "al-navi");
const CDP_PORT = 9260;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// the app writes settings/window state into the real config dir — back it up
const backedUp = [];
for (const f of readdirSync(CFG)) {
  if (f.endsWith(".e2e-bak")) continue;
  const p = join(CFG, f);
  cpSync(p, p + ".e2e-bak", { recursive: true });
  backedUp.push(p);
}
function restoreCfg() {
  // best-effort: the dying WebView2 holds EPERM locks on its profile a moment
  for (let i = 0; i < 3; i++) {
    try {
      for (const p of backedUp) cpSync(p + ".e2e-bak", p, { recursive: true });
      return;
    } catch { sleep(700); }
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
const VK = { Enter: 13, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Escape: 27, F1: 112 };
const MOD = { ctrl: 2, shift: 8 };
async function key(cdp, k, { ctrl = false, shift = false } = {}) {
  let modifiers = 0;
  if (ctrl) modifiers += MOD.ctrl;
  if (shift) modifiers += MOD.shift;
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k] ?? 0, modifiers };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(120);
}
async function type(cdp, text) {
  for (const ch of text) {
    let code;
    if (/[a-z]/i.test(ch)) code = "Key" + ch.toUpperCase();
    else if (ch === " ") code = "Space";
    const base = { key: ch, code, windowsVirtualKeyCode: ch === " " ? 32 : ch.toUpperCase().charCodeAt(0) };
    await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown", text: ch });
    await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    await sleep(20);
  }
  await sleep(120);
}
const waitFor = async (cdp, expr, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await evalIn(cdp, expr);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
};
async function clickAt(cdp, x, y) {
  const base = { x, y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  await sleep(300);
}

const sel = `(() => {
  const i = document.querySelector(".cmdline input");
  if (!i) return null;
  return { v: i.value, s: i.selectionStart, e: i.selectionEnd, focused: document.activeElement === i };
})()`;
// the panel cursor row index, read from the DOM (production bundle: no store
// imports — the cursor row carries the "cursor" class)
const cursorRow = `(() => {
  const panel = document.querySelector(".panel");
  if (!panel) return -1;
  const rows = panel.querySelectorAll(".row, .li");
  return [...rows].findIndex((r) => r.classList.contains("cursor") || r.getAttribute("aria-selected") === "true");
})()`;
const setSel = (s, e) => evalIn(cdp0, `
  (() => { const i = document.querySelector(".cmdline input"); i.setSelectionRange(${s}, ${e}); return true; })()
`);
let cdp0 = null;

try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-024-exe-"));
  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
    stdio: "ignore",
  });
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => ({ json: async () => [] }))).json();
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    if (wsUrl) break;
    await sleep(500);
  }
  check("exe launches (CDP target up)", !!wsUrl);
  if (!wsUrl) throw new Error("no CDP target");
  const cdp = connect(wsUrl);
  cdp0 = cdp;
  await cdp.ready;
  await sleep(3500);
  await waitFor(cdp, `!!document.querySelector(".panel, .panels")`, 15000, "app UI");
  // click the panel like a user so the window has the keyboard context (a
  // window spawned in the background may have missed the startup focus dance)
  const p = await evalIn(cdp, `(() => { const el = document.querySelector(".panel"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (p) await clickAt(cdp, p.x, p.y);

  // the cmdline owns the caret by design — focus it and type like a user
  await evalIn(cdp, `document.querySelector(".cmdline input").focus(); true`);
  await type(cdp, "hello world foo");
  let s = await evalIn(cdp, sel);
  check("typed into the cmdline: value + caret at end, no selection",
    s && s.v === "hello world foo" && s.s === 15 && s.e === 15, JSON.stringify(s));

  const rowBefore = await evalIn(cdp, cursorRow);

  // ---- Shift+arrows: char selection, panel must not move ----
  await key(cdp, "ArrowLeft", { shift: true });
  await key(cdp, "ArrowLeft", { shift: true });
  await key(cdp, "ArrowLeft", { shift: true });
  s = await evalIn(cdp, sel);
  check("Shift+Left ×3 selects 3 chars to the left", s.s === 12 && s.e === 15, JSON.stringify(s));
  await key(cdp, "ArrowRight", { shift: true });
  s = await evalIn(cdp, sel);
  check("Shift+Right shrinks the selection by 1", s.s === 13 && s.e === 15, JSON.stringify(s));

  // ---- Ctrl+Shift+arrows: word selection to the end / whole line ----
  await setSel(0, 0);
  await key(cdp, "ArrowRight", { ctrl: true, shift: true });
  s = await evalIn(cdp, sel);
  check("Ctrl+Shift+Right selects the first word", s.s === 0 && s.e === 6, JSON.stringify(s));
  await key(cdp, "ArrowRight", { ctrl: true, shift: true });
  await key(cdp, "ArrowRight", { ctrl: true, shift: true });
  s = await evalIn(cdp, sel);
  check("Ctrl+Shift+Right ×3 reaches the end = whole text selected", s.s === 0 && s.e === 15, JSON.stringify(s));
  await setSel(15, 15);
  await key(cdp, "ArrowLeft", { ctrl: true, shift: true });
  await key(cdp, "ArrowLeft", { ctrl: true, shift: true });
  await key(cdp, "ArrowLeft", { ctrl: true, shift: true });
  s = await evalIn(cdp, sel);
  check("Ctrl+Shift+Left ×3 covers the whole line back to the start", s.s === 0 && s.e === 15, JSON.stringify(s));

  // ---- Shift+Home/End in one press ----
  await setSel(7, 7);
  await key(cdp, "Home", { shift: true });
  s = await evalIn(cdp, sel);
  check("Shift+Home selects to line start", s.s === 0 && s.e === 7, JSON.stringify(s));
  await key(cdp, "End", { shift: true });
  s = await evalIn(cdp, sel);
  // after Shift+Home the selection is backward (anchor = the pre-Home caret 7):
  // Shift+End extends from that anchor to the end — standard Windows edit
  check("Shift+End selects from the pre-Home caret to line end", s.s === 7 && s.e === 15, JSON.stringify(s));

  const rowAfter = await evalIn(cdp, cursorRow);
  check("panel cursor row did NOT move during the selection", rowAfter === rowBefore, `${rowBefore} -> ${rowAfter}`);

  // ---- Up/Down with text still drive the panel (FAR rows) ----
  await key(cdp, "ArrowDown");
  const rowDown = await evalIn(cdp, cursorRow);
  check("ArrowDown with text moves the panel cursor a row down", rowDown === rowBefore + 1, `${rowBefore} -> ${rowDown}`);

  // ---- Esc clears the line (Enter is NOT pressed: no real command runs) ----
  await key(cdp, "Escape");
  s = await evalIn(cdp, sel);
  check("Esc clears the line", s.v === "" && s.s === 0 && s.e === 0, JSON.stringify(s));

  // ---- F1 help lists the new selection keys (i18n shipped in the build) ----
  await key(cdp, "F1");
  const help = await waitFor(cdp, `(() => {
    const dlg = document.querySelector(".overlay .dlg, .help");
    if (!dlg) return null;
    const t = dlg.textContent || "";
    return { hasWord: t.includes("Ctrl+Shift+"), hasHome: t.includes("Shift+Home"), snippet: t.slice(0, 80) };
  })()`, 8000, "help dialog");
  check("F1 help lists Ctrl+Shift+←/→ and Shift+Home/End rows", help.hasWord && help.hasHome, JSON.stringify(help));
  await key(cdp, "Escape");
  const helpClosed = await evalIn(cdp, `!document.querySelector(".overlay .dlg, .help")`);
  check("Esc closes the help", helpClosed === true);
} catch (e) {
  check("script crashed", false, String(e));
} finally {
  const fails = results.filter((x) => !x.ok).length;
  console.log(`\n${fails ? fails + " FAILED" : "ALL " + results.length + " PASSED"}`);
  try { spawn("taskkill", ["/IM", "Al-Navi.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1200);
  restoreCfg();
  process.exit(fails ? 1 : 0);
}
