// exe-level E2E for alnavi-023: in the REAL released exe, F8 on the file under
// the cursor opens the delete confirmation — the lime fill must sit on «Да»
// and MOVE to «Нет» when ← takes the focus there, then back with →. Esc cancels
// the delete (nothing is deleted). The app's real config (%APPDATA%\al-navi) is
// backed up and restored.
// Usage: node scripts/e2e-alnavi-023-exe.mjs [path-to-Al-Navi.exe]
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
const CDP_PORT = 9259;
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
const VK = { Enter: 13, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowRight: 39, F8: 119 };
async function key(cdp, k) {
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0) };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  // .btn background transitions in 0.12s — let it settle before measuring
  await sleep(300);
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
async function shot(cdp, path) {
  try {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, Buffer.from(r.data, "base64"));
  } catch {}
}
async function clickAt(cdp, x, y) {
  const base = { x, y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  await sleep(300);
}

const LIME = "rgb(142, 229, 63)";
const snap = `(() => {
  const btns = Array.from(document.querySelectorAll(".overlay .dlg .dlg-actions button"));
  if (!btns.length) return null;
  return {
    n: btns.length,
    bg: btns.map((b) => getComputedStyle(b).backgroundColor),
    text: btns.map((b) => b.textContent.trim()),
    focus: btns.indexOf(document.activeElement),
    hasFocus: document.hasFocus(),
  };
})()`;

try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-023-exe-"));
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
  // trace every key the page actually receives (injected via CDP Input)
  await evalIn(cdp, `window.__keys = []; window.addEventListener("keydown", (e) => window.__keys.push(e.key), true); true`);
  // F8 needs the keyboard context "panel" — click the left panel like a user
  // would before pressing keys (a window spawned in the background may not
  // have run the startup focus dance)
  const p = await evalIn(cdp, `(() => { const el = document.querySelector(".panel"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  check("app UI up, panel found for the click", !!p, JSON.stringify(p));
  if (p) await clickAt(cdp, p.x, p.y);
  // the cmdline input owning the caret is BY DESIGN (FAR model) — panel keys
  // still route through the global capture handler

  // the restored cursor may sit on ".." (targetEntries empty → F8 no-ops):
  // step one row down onto a real entry, like a user would
  await key(cdp, "ArrowDown");
  const cur = await evalIn(cdp, `(() => { const rows = document.querySelectorAll(".panel .row, .panel .li"); const idx = [...rows].findIndex((r) => r.classList.contains("cursor") || r.getAttribute("aria-selected") === "true"); return { idx, total: rows.length, label: rows[idx]?.textContent?.slice(0, 40) ?? null }; })()`);
  check("cursor moved onto a real entry", cur.idx > 0, JSON.stringify(cur));

  // F8 on whatever is under the cursor → delete confirmation
  await key(cdp, "F8");
  let s0 = null;
  try {
    s0 = await waitFor(cdp, snap, 8000, "delete confirm dialog");
  } catch (e) {
    await shot(cdp, join(process.cwd(), "builds", "shot-023-exe-fail.png"));
    const d = await evalIn(cdp, `(() => ({
      keys: window.__keys,
      rows: document.querySelectorAll(".panel .row, .panel .li").length,
      cmdline: document.querySelector(".cmdline input")?.value ?? null,
      overlay: !!document.querySelector(".overlay"),
      dlg: document.querySelector(".dlg")?.className ?? null,
      title: document.querySelector(".dlg-title")?.textContent?.trim() ?? null,
    }))()`);
    check("diagnostics after F8", false, JSON.stringify(d));
    throw e;
  }
  check("confirm: two buttons rendered", s0.n === 2, s0.text.join(" / "));
  check("confirm: initial — default button (Да) is lime and focused",
    s0.bg[1] === LIME && s0.bg[0] !== LIME && s0.focus === 1, `bg=${s0.bg} focus=${s0.focus} winFocus=${s0.hasFocus}`);

  await key(cdp, "ArrowLeft");
  const s1 = await evalIn(cdp, snap);
  check("confirm: ← moves the lime fill onto the other button (Нет) — the user's report",
    s1.bg[0] === LIME && s1.bg[1] !== LIME && s1.focus === 0, `bg=${s1.bg} focus=${s1.focus} winFocus=${s1.hasFocus}`);

  await key(cdp, "ArrowRight");
  const s2 = await evalIn(cdp, snap);
  check("confirm: → moves the fill back onto the default (Да)",
    s2.bg[1] === LIME && s2.bg[0] !== LIME && s2.focus === 1, `bg=${s2.bg} focus=${s2.focus}`);

  // Esc cancels the delete — the dialog must be gone, the file untouched
  await key(cdp, "Escape");
  const closed = await evalIn(cdp, `!document.querySelector(".overlay .dlg")`);
  check("confirm: Esc closes the dialog (delete cancelled)", closed === true);
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
