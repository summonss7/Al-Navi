// exe-level E2E for alnavi-028: in the REAL released exe (1.12.10) Ctrl+"+" /
// Ctrl+"−" must zoom the interface font exactly like the F9 stepper does
// (0.5 px steps, 10..24). Real key presses through CDP verify every spelling:
// Ctrl+= (main row without Shift), Ctrl+Shift+= (a real "+"), Ctrl+- and the
// numpad Ctrl+Gray+/-; sweeps clamp at 24/10 px; the zoom must NOT leak into
// the native WebView2 zoom (devicePixelRatio stays put); the toast echoes the
// size; the F9 dialog stepper follows live; plain Gray+ still opens the FAR
// select-group dialog; F1 documents the row. The app's real config
// (%APPDATA%\al-navi) is backed up and restored, and the initial font size is
// returned by key presses at the end.
// Usage: node scripts/e2e-alnavi-028-exe.mjs [path-to-Al-Navi.exe]
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
const CDP_PORT = 9268;
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
// real key presses; zoom chords carry their physical codes so chordOf sees
// Equal/Minus/NumpadAdd/NumpadSubtract exactly like a real keyboard does
const VK = { Escape: 27, F1: 112, F9: 120, Equal: 187, Minus: 189, Add: 107, Subtract: 109 };
const MOD_CTRL = 2, MOD_CTRL_SHIFT = 2 + 8;
async function key(cdp, k, mod = 0) {
  const base = {
    key: k.key ?? k,
    code: k.code ?? k,
    windowsVirtualKeyCode: k.vk ?? (VK[k] ?? 0),
    modifiers: mod,
  };
  await cdp.send("Input.dispatchKeyEvent", { ...base, ...(k.text ? { text: k.text } : {}), type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(130);
}
const K_EQUAL = { key: "=", code: "Equal", vk: VK.Equal };
const K_PLUS = { key: "+", code: "Equal", vk: VK.Equal };
const K_MINUS = { key: "-", code: "Minus", vk: VK.Minus };
const K_NUM_ADD = { key: "+", code: "NumpadAdd", vk: VK.Add };
const K_NUM_SUB = { key: "-", code: "NumpadSubtract", vk: VK.Subtract };
const ctrlEqual = (cdp) => key(cdp, K_EQUAL, MOD_CTRL);
const ctrlShiftPlus = (cdp) => key(cdp, K_PLUS, MOD_CTRL_SHIFT);
const ctrlMinus = (cdp) => key(cdp, K_MINUS, MOD_CTRL);
const ctrlNumAdd = (cdp) => key(cdp, K_NUM_ADD, MOD_CTRL);
const ctrlNumSub = (cdp) => key(cdp, K_NUM_SUB, MOD_CTRL);

// live px value derived from the --fs-scale CSS var (no store imports in exe)
const fontPx = async (cdp) => {
  const s = await evalIn(cdp, `parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fs-scale"))`);
  // the saved size is a 0.5 grid — kill the float noise of scale*13.5
  return Math.round(s * 13.5 * 2) / 2;
};
const step = (px, dir, n) => Math.min(24, Math.max(10, Math.round((px + dir * 0.5 * n) * 2) / 2));
const near = (v, want, eps = 0.01) => Number.isFinite(v) && Math.abs(v - want) <= eps;
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

try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-028-exe-"));
  spawn(EXE, [], {
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
  const ver = await evalIn(cdp, `document.querySelector(".titlebar .version")?.textContent ?? ""`);
  check("title bar chip carries v1.12.10", ver.includes("1.12.10"), JSON.stringify(ver));
  // click the panel like a user so the window has the keyboard context
  const p = await evalIn(cdp, `(() => { const el = document.querySelector(".panel"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (p) await clickAt(cdp, p.x, p.y);

  // ---- every spelling steps the same 0.5 px ----
  const px0 = await fontPx(cdp);
  check("initial font size read from --fs-scale (0.5 grid)", px0 >= 10 && px0 <= 24, `px=${px0}`);
  const dpr0 = await evalIn(cdp, `window.devicePixelRatio`);

  await ctrlEqual(cdp);
  let px = await fontPx(cdp);
  check("Ctrl+= grows by 0.5 px", near(px, step(px0, 1, 1)), `px=${px} (from ${px0})`);
  await ctrlShiftPlus(cdp);
  px = await fontPx(cdp);
  check("Ctrl+Shift+= (real '+') grows too", near(px, step(px0, 1, 2)), `px=${px}`);
  await ctrlMinus(cdp);
  px = await fontPx(cdp);
  check("Ctrl+- shrinks", near(px, step(px0, 1, 1)), `px=${px}`);
  await ctrlNumAdd(cdp);
  px = await fontPx(cdp);
  check("Ctrl+Gray+ (numpad) grows", near(px, step(px0, 1, 2)), `px=${px}`);
  await ctrlNumSub(cdp);
  px = await fontPx(cdp);
  check("Ctrl+Gray- shrinks", near(px, step(px0, 1, 1)), `px=${px}`);

  // ---- toast echoes the size (locale-independent shape) ----
  await ctrlEqual(cdp);
  px = await fontPx(cdp);
  const toast = await evalIn(cdp, `document.querySelector(".toast")?.textContent ?? ""`);
  check("toast echoes the size in px", new RegExp(px.toFixed(1).replace(".", "\\.") + "\\s*px").test(toast), JSON.stringify(toast));
  await ctrlMinus(cdp);

  // ---- clamps + native WebView2 zoom must stay out ----
  for (let i = 0; i < 40; i++) await ctrlEqual(cdp);
  px = await fontPx(cdp);
  const dpr1 = await evalIn(cdp, `window.devicePixelRatio`);
  check("long Ctrl+= sweep stops at 24 px", near(px, 24), `px=${px}`);
  check("native WebView2 zoom not triggered (dPR unchanged)", dpr1 === dpr0, `dpr ${dpr0} -> ${dpr1}`);
  for (let i = 0; i < 50; i++) await ctrlMinus(cdp);
  px = await fontPx(cdp);
  check("long Ctrl+- sweep stops at 10 px", near(px, 10), `px=${px}`);
  const dpr2 = await evalIn(cdp, `window.devicePixelRatio`);
  check("dPR still unchanged after the down sweep", dpr2 === dpr0, `dpr ${dpr0} -> ${dpr2}`);

  // ---- F9 dialog stepper follows live ----
  await key(cdp, "F9");
  await waitFor(cdp, `!!document.querySelector(".fs-val")`, 8000, "F9 dialog");
  await ctrlEqual(cdp);
  px = await fontPx(cdp);
  const fsVal = await evalIn(cdp, `document.querySelector(".fs-val")?.textContent ?? ""`);
  check("zoom inside the F9 dialog updates the stepper label", new RegExp(px.toFixed(1).replace(".", "\\.")).test(fsVal), `px=${px} label=${JSON.stringify(fsVal)}`);
  await key(cdp, "Escape");

  // ---- plain Gray+ still opens the FAR select dialog ----
  await key(cdp, K_NUM_ADD, 0);
  const selDlg = await evalIn(cdp, `!!document.querySelector(".overlay input")`);
  check("plain numpad + opens the select-group dialog", selDlg === true);
  await key(cdp, "Escape");
  const closed = await evalIn(cdp, `!document.querySelector(".overlay")`);
  check("Esc closes the select dialog", closed === true);

  // ---- F1 documents the row ----
  await key(cdp, "F1");
  await waitFor(cdp, `!!document.querySelector(".dlg.help-dlg")`, 8000, "help dialog");
  const help = await evalIn(cdp, `
    (() => {
      const rows = [...document.querySelectorAll(".help-dlg .hrow")];
      const hit = rows.find((x) => x.querySelector("kbd")?.textContent.includes("Ctrl+− / +"));
      return { found: !!hit, rows: rows.length };
    })()
  `);
  check("help row 'Ctrl+− / +' present (92 rows)", help.found && help.rows === 92, `rows=${help.rows}`);
  await key(cdp, "Escape");

  // ---- return the user's original size by key presses ----
  let cur = await fontPx(cdp);
  while (cur < px0 - 0.01) { await ctrlEqual(cdp); cur = await fontPx(cdp); }
  while (cur > px0 + 0.01) { await ctrlMinus(cdp); cur = await fontPx(cdp); }
  check("initial font size restored", near(cur, px0), `px=${cur} (want ${px0})`);
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
