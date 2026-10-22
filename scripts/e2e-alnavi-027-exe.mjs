// exe-level E2E for alnavi-027: in the REAL released exe Ctrl+Left/
// Ctrl+Right must slide the split between the file panels like FAR: Ctrl+Right
// widens the left panel, Ctrl+Left widens the right one, sweeps clamp at
// 20%/80%. While the command line holds text the chords stay the input's word
// jump (panels must not move — alnavi-024 regression), Esc re-enables
// resizing, in one-panel mode the split is guarded, and F1 documents the new
// row. The app's real config (%APPDATA%\al-navi) is backed up and restored.
// Usage: node scripts/e2e-alnavi-027-exe.mjs [path-to-Al-Navi.exe]
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
const CDP_PORT = 9267;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const near = (v, want, eps = 0.02) => Number.isFinite(v) && Math.abs(v - want) <= eps;

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
// real key presses: plain keys, Ctrl+chords, printable characters into the
// command line (space needs code "Space" to register its default action)
async function key(cdp, k, mod = 0) {
  const base = {
    key: k.key ?? k,
    code: k.code ?? k,
    windowsVirtualKeyCode: k.vk ?? (typeof k === "string" ? (VK[k] ?? k.charCodeAt(0)) : 0),
    modifiers: mod,
  };
  await cdp.send("Input.dispatchKeyEvent", { ...base, ...(k.text ? { text: k.text } : {}), type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(130);
}
const VK = { Escape: 27, F1: 112, F2: 113, ArrowLeft: 37, ArrowRight: 39 };
const MOD_CTRL = 2;
const ctrlArrow = (cdp, name) => key(cdp, { key: name, code: name, vk: VK[name] }, MOD_CTRL);
async function typeText(cdp, s) {
  for (const ch of s) {
    const code = ch === " " ? "Space" : ch === "." ? "Period" : "Key" + ch.toUpperCase();
    await key(cdp, { key: ch, code, text: ch, vk: ch.toUpperCase().charCodeAt(0) });
  }
}
// left panel share of the combined width of the two panels
const domRatio = (cdp) => evalIn(cdp, `(() => {
  const w = [...document.querySelectorAll(".panel")].map((p) => p.getBoundingClientRect().width);
  return w.length === 2 ? w[0] / (w[0] + w[1]) : null;
})()`);
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
  const profile = mkdtempSync(join(tmpdir(), "alnavi-027-exe-"));
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
  check("title bar chip carries v1.14.4", ver.includes("1.14.4"), JSON.stringify(ver));
  // click the panel like a user so the window has the keyboard context (a
  // window spawned in the background may have missed the startup focus dance)
  const p = await evalIn(cdp, `(() => { const el = document.querySelector(".panel"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (p) await clickAt(cdp, p.x, p.y);

  // ---- the split slides ----
  const r0 = await domRatio(cdp);
  check("two panels start ~50/50", near(r0, 0.5), `dom=${r0}`);
  for (let i = 0; i < 5; i++) await ctrlArrow(cdp, "ArrowRight");
  let r = await domRatio(cdp);
  check("5x Ctrl+Right widens the left panel", near(r, r0 + 0.1), `dom=${r}`);
  for (let i = 0; i < 10; i++) await ctrlArrow(cdp, "ArrowLeft");
  r = await domRatio(cdp);
  check("10x Ctrl+Left widens the right panel", near(r, r0 - 0.1), `dom=${r}`);

  // ---- clamps ----
  for (let i = 0; i < 40; i++) await ctrlArrow(cdp, "ArrowLeft");
  r = await domRatio(cdp);
  check("long Ctrl+Left sweep stops at 0.2", near(r, 0.2), `dom=${r}`);
  for (let i = 0; i < 50; i++) await ctrlArrow(cdp, "ArrowRight");
  r = await domRatio(cdp);
  check("long Ctrl+Right sweep stops at 0.8", near(r, 0.8), `dom=${r}`);

  // ---- text in the line: word jump, no resize (alnavi-024 regression) ----
  await typeText(cdp, "one two");
  const typed = await evalIn(cdp, `document.querySelector(".cmdline input").value`);
  check("typed text landed in the command line", typed === "one two", JSON.stringify(typed));
  for (let i = 0; i < 3; i++) await ctrlArrow(cdp, "ArrowRight");
  r = await domRatio(cdp);
  const caret = await evalIn(cdp, `document.querySelector(".cmdline input").selectionStart`);
  check("panels did not move while the line had text", near(r, 0.8), `dom=${r}`);
  check("caret word-jumped inside the line", typeof caret === "number" && caret > 0, `selectionStart=${caret}`);
  await key(cdp, "Escape");
  const cleared = await evalIn(cdp, `document.querySelector(".cmdline input").value === ""`);
  check("Esc cleared the line", cleared === true);
  for (let i = 0; i < 5; i++) await ctrlArrow(cdp, "ArrowLeft");
  r = await domRatio(cdp);
  check("empty line: the chords resize again", near(r, 0.7), `dom=${r}`);

  // ---- one visible panel: the split is guarded ----
  await key(cdp, { key: "F2", code: "F2", vk: VK.F2 }, MOD_CTRL); // Ctrl+F2 hides the right panel
  await sleep(300);
  const onePanel = await evalIn(cdp, `document.querySelectorAll(".panel").length`);
  check("Ctrl+F2 hid the right panel", onePanel === 1, `panels=${onePanel}`);
  for (let i = 0; i < 6; i++) await ctrlArrow(cdp, "ArrowRight");
  await key(cdp, { key: "F2", code: "F2", vk: VK.F2 }, MOD_CTRL); // and back
  await sleep(300);
  r = await domRatio(cdp);
  check("split untouched in one-panel mode", near(r, 0.7), `dom=${r}`);

  // ---- F1 documents the chord ----
  await key(cdp, "F1");
  await waitFor(cdp, `!!document.querySelector(".dlg.help-dlg")`, 8000, "help dialog");
  const help = await evalIn(cdp, `
    (() => {
      const rows = [...document.querySelectorAll(".help-dlg .hrow")];
      const hit = rows.find((x) => x.querySelector("kbd")?.textContent.includes("Ctrl+← / →"));
      return { found: !!hit, desc: hit?.textContent ?? "", rows: rows.length };
    })()
  `);
  check("help row 'Ctrl+← / →' present (96 rows, +font zoom)", help.found && help.rows === 96, `rows=${help.rows}`);
  check("help row localized (no raw key leak)", !/help\.sel/.test(help.desc), help.desc.slice(0, 60));
  await key(cdp, "Escape");
  const closed = await evalIn(cdp, `!document.querySelector(".dlg.help-dlg")`);
  check("Esc closes the help", closed === true);
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
