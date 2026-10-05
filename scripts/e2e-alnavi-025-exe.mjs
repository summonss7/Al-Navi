// exe-level E2E for alnavi-025: in the REAL released exe, Ctrl+Shift+F4 must
// open a memory-only scratchpad in the editor: text can be typed into it, the
// doc never shows as dirty, F2 refuses to save with a toast (no dialog, no
// file), Ctrl+Tab walks editor->panels->back, Esc closes with no save prompt,
// a reopen starts empty, and the F1 help lists the new chord. The app's real
// config (%APPDATA%\al-navi) is backed up and restored.
// Usage: node scripts/e2e-alnavi-025-exe.mjs [path-to-Al-Navi.exe]
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
const CDP_PORT = 9262;
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
const VK = { F1: 112, F2: 113, F4: 115, Tab: 9, Escape: 27 };
const MOD = { ctrl: 2, shift: 8 };
async function key(cdp, k, { ctrl = false, shift = false } = {}) {
  let modifiers = 0;
  if (ctrl) modifiers += MOD.ctrl;
  if (shift) modifiers += MOD.shift;
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k] ?? 0, modifiers };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(150);
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
  await sleep(150);
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

// DOM-only state (production bundle: no store imports)
const state = `(() => {
  const tab = document.querySelector(".doc-tab.on");
  return {
    editor: !!document.querySelector(".editor .cm-editor"),
    panels: !!document.querySelector(".panel, .panels"),
    tabName: tab ? tab.querySelector(".doc-name")?.textContent : null,
    tabDirty: !!document.querySelector(".doc-tab.on .dot"),
    text: document.querySelector(".cm-content") ? document.querySelector(".cm-content").textContent : null,
    toast: document.querySelector(".toast") ? document.querySelector(".toast").textContent : null,
    overlay: !!document.querySelector(".overlay"),
  };
})()`;

try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-025-exe-"));
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
  await cdp.ready;
  await sleep(3500);
  await waitFor(cdp, `!!document.querySelector(".panel, .panels")`, 15000, "app UI");
  // click the panel like a user so the window has the keyboard context (a
  // window spawned in the background may have missed the startup focus dance)
  const p = await evalIn(cdp, `(() => { const el = document.querySelector(".panel"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (p) await clickAt(cdp, p.x, p.y);

  // ---- Ctrl+Shift+F4 opens the scratchpad ----
  await key(cdp, "F4", { ctrl: true, shift: true });
  let s = await waitFor(cdp, `!!document.querySelector(".editor .cm-editor")`, 5000, "editor");
  s = await evalIn(cdp, state);
  check("Ctrl+Shift+F4 opens the editor with a scratchpad", s.editor === true && s.panels === false, JSON.stringify({ editor: s.editor }));
  check("tab is named (localized), not a path", typeof s.tabName === "string" && s.tabName.length > 0 && !s.tabName.includes("\\") && !/[.:]/.test(s.tabName), JSON.stringify(s.tabName));

  // ---- typing works, the doc never shows dirty ----
  await sleep(400); // CodeMirror focuses itself on mount
  await type(cdp, "scratch me");
  s = await evalIn(cdp, state);
  check("typed text lands in the scratchpad", typeof s.text === "string" && s.text.includes("scratch me"), JSON.stringify(s.text));
  check("no dirty dot on the scratch tab (nothing to save)", s.tabDirty === false, `tabDirty=${s.tabDirty}`);

  // ---- F2 refuses to save: toast, no dialog, no file ----
  await key(cdp, "F2");
  await sleep(400);
  s = await evalIn(cdp, state);
  check("F2 shows the memory-only toast", typeof s.toast === "string" && s.toast.length > 0, JSON.stringify(s.toast));
  check("F2 opened no dialog", s.overlay === false, `overlay=${s.overlay}`);

  // ---- Ctrl+Tab ring: editor -> panels -> back ----
  await key(cdp, "Tab", { ctrl: true });
  s = await evalIn(cdp, state);
  check("Ctrl+Tab collapses to the panels", s.panels === true && s.editor === false, JSON.stringify({ panels: s.panels, editor: s.editor }));
  await key(cdp, "Tab", { ctrl: true, shift: true });
  s = await waitFor(cdp, `!!document.querySelector(".editor .cm-editor")`, 5000, "editor back");
  s = await evalIn(cdp, state);
  check("Ctrl+Shift+Tab returns to the scratchpad, text kept", s.editor === true && typeof s.text === "string" && s.text.includes("scratch me"), JSON.stringify(s.text));

  // ---- Esc closes instantly, no save prompt ----
  await key(cdp, "Escape");
  await sleep(400);
  s = await evalIn(cdp, state);
  check("Esc closes the scratchpad with no save prompt", s.panels === true && s.editor === false && s.overlay === false,
    JSON.stringify({ panels: s.panels, editor: s.editor, overlay: s.overlay }));

  // ---- a reopen starts empty ----
  await key(cdp, "F4", { ctrl: true, shift: true });
  await waitFor(cdp, `!!document.querySelector(".editor .cm-editor")`, 5000, "editor reopen");
  await sleep(300);
  s = await evalIn(cdp, state);
  check("a reopened scratchpad starts empty", s.editor === true && (s.text === "" || s.text === null || s.text === "\\u200b"), JSON.stringify(s.text));
  await key(cdp, "Escape");

  // ---- F1 help lists the new chord ----
  await key(cdp, "F1");
  const help = await waitFor(cdp, `(() => {
    const dlg = document.querySelector(".overlay .dlg, .help");
    if (!dlg) return null;
    const t = dlg.textContent || "";
    return { hasChord: t.includes("Ctrl+Shift+F4"), snippet: t.slice(0, 60) };
  })()`, 8000, "help dialog");
  check("F1 help lists the Ctrl+Shift+F4 row", help.hasChord, JSON.stringify(help));
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
