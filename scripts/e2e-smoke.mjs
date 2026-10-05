// Smoke E2E for the real Al-Navi exe over CDP (WebView2 remote debugging).
// The stable core of release checks in one script with a pass/fail summary:
//   boot + version in the title bar, panel navigation (cd via the command
//   line, cursor walk, Enter into a dir, Backspace up), F5 copy into the
//   other panel, F8 delete with the confirm dialog, F4 editor with an F2
//   save verified on disk, theme and locale cycling from the title bar.
// File operations run in a temp sandbox; the app's real config
// (%APPDATA%\al-navi) is backed up and restored afterwards.
// Usage: node scripts/e2e-smoke.mjs [path-to-Al-Navi.exe]
//   (npm run test:e2e [-- -- path-to-exe])
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const CFG = join(process.env.APPDATA, "al-navi");
const CDP_PORT = 9261;
const THEMES = ["alnaviDark", "alnaviLight", "midnight", "solarized", "contrast"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// ---- sandbox: two panel dirs, a subdir to walk into, files to copy/delete/edit
const work = mkdtempSync(join(tmpdir(), "alnaviSmoke"));
const left = join(work, "left");
const right = join(work, "right");
mkdirSync(left);
mkdirSync(right);
mkdirSync(join(left, "sub"));
writeFileSync(join(left, "alpha.txt"), "alpha-body");
writeFileSync(join(left, "beta.txt"), "beta-body");
const norm = (p) => p.replace(/\\/g, "/").toLowerCase();

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
const waitFor = async (cdp, expr, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await evalIn(cdp, expr);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
};
// ground truth from Node fs, retried — the op completes asynchronously
async function waitFs(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = fn();
      if (v) return v;
    } catch { /* not there yet */ }
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}

const VK = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, F2: 113, F4: 115, F5: 116, F8: 119 };
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
// type a whole line into the focused cmdline input (IME-style insert — real
// key events are unnecessary and dash/plus chars would trip the panel keymap)
async function typeLine(cdp, text) {
  await cdp.send("Input.insertText", { text });
  await sleep(120);
  await key(cdp, "Enter");
}
async function clickAt(cdp, x, y) {
  const base = { x, y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  await sleep(300);
}
async function clickEl(cdp, expr) {
  const r = await evalIn(cdp, `(() => { const el = ${expr}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
  if (!r) return false;
  await clickAt(cdp, r.x, r.y);
  return true;
}

// DOM probes
const activeCrumbs = `document.querySelector(".panel.active .crumbs")?.textContent ?? ""`;
const passiveCrumbs = `document.querySelector(".panel:not(.active) .crumbs")?.textContent ?? ""`;
const cursorRow = `document.querySelector(".panel.active .row.cursor")?.textContent ?? ""`;
const overlayGone = `!document.querySelector(".overlay")`;

try {
  // ---- start + connect
  const profile = mkdtempSync(join(tmpdir(), "alnavi-smoke-"));
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
  check("1. exe launches (CDP target up)", !!wsUrl);
  if (!wsUrl) throw new Error("no CDP target");
  const cdp = connect(wsUrl);
  await cdp.ready;
  await sleep(3500);
  await waitFor(cdp, `!!document.querySelector(".panel, .panels")`, 15000, "app UI");

  // click the active panel like a user so the window has the keyboard context
  // (a window spawned in the background may have missed the startup focus dance)
  await clickEl(cdp, `document.querySelector(".panel")`);

  // ---- boot + version
  const boot = await evalIn(cdp, `(() => ({
    tauri: !!window.__TAURI_INTERNALS__,
    version: (document.querySelector(".version")?.textContent ?? "").trim(),
    panels: document.querySelectorAll(".panel").length,
  }))()`);
  check("2. booted with the real backend, two panels", boot?.tauri && boot?.panels === 2, JSON.stringify(boot));
  check("3. version + build time in the title bar", /v\d+\.\d+\.\d+\s*·/.test(boot?.version ?? ""), boot?.version ?? "(none)");

  // ---- navigation: cd both panels into the sandbox via the command line
  await evalIn(cdp, `document.querySelector(".cmdline input")?.focus(); true`);
  await typeLine(cdp, `cd ${left}`);
  let crumbs = await waitFor(cdp, `(${activeCrumbs}).toLowerCase().includes("left") ? ${activeCrumbs} : ""`, 8000, "left panel cd");
  check("4. cd the active panel to the sandbox (cmdline cd + Enter)", /left/i.test(crumbs), crumbs.replace(/\s+/g, " ").slice(0, 70));

  await key(cdp, "Tab");
  await typeLine(cdp, `cd ${right}`);
  // after Tab+cd the ACTIVE panel sits on right/, the passive one keeps left/
  crumbs = await waitFor(cdp, `(${activeCrumbs}).toLowerCase().includes("right") && (${passiveCrumbs}).toLowerCase().includes("left") ? ${activeCrumbs} : ""`, 8000, "right panel cd");
  check("5. Tab + cd parks the other panel on right/", /right/i.test(crumbs), crumbs.replace(/\s+/g, " ").slice(0, 70));
  await key(cdp, "Tab"); // back to the left panel

  // ---- cursor walk: Home to "..", down to sub, Enter into it, Backspace up
  await key(cdp, "Home");
  let row = await evalIn(cdp, cursorRow);
  check("6. Home parks the cursor on ..", /\.\./.test(row), row.replace(/\s+/g, " ").slice(0, 40));
  await key(cdp, "ArrowDown");
  row = await evalIn(cdp, cursorRow);
  check("7. ArrowDown walks onto sub/", /(^|\s)sub(\s|$)/i.test(row), row.replace(/\s+/g, " ").slice(0, 40));
  await key(cdp, "Enter");
  crumbs = await waitFor(cdp, `(${activeCrumbs}).toLowerCase().includes("sub") ? ${activeCrumbs} : ""`, 8000, "enter sub");
  check("8. Enter opens sub/ (crumbs follow)", /sub/i.test(crumbs), crumbs.replace(/\s+/g, " ").slice(0, 70));
  await key(cdp, "Backspace"); // empty cmdline: up one level
  crumbs = await waitFor(cdp, `(${activeCrumbs}).toLowerCase().includes("left") && !(${activeCrumbs}).toLowerCase().includes("sub") ? ${activeCrumbs} : ""`, 8000, "back to left");
  row = await evalIn(cdp, cursorRow);
  check("9. Backspace goes up, cursor lands back on sub/", /left/i.test(crumbs) && /(^|\s)sub(\s|$)/i.test(row), `${crumbs.replace(/\s+/g, " ").slice(0, 40)} | cursor: ${row.replace(/\s+/g, " ").slice(0, 30)}`);

  // ---- F5 copy into the other panel
  await key(cdp, "ArrowDown"); // onto alpha.txt
  row = await evalIn(cdp, cursorRow);
  check("10. cursor on alpha.txt", /alpha\.txt/i.test(row), row.replace(/\s+/g, " ").slice(0, 40));
  await key(cdp, "F5");
  const dlg = await waitFor(cdp, `(() => { const i = document.querySelector(".overlay .dlg input"); return i ? { v: i.value } : null; })()`, 8000, "copy dialog");
  check("11. F5 opens the copy dialog prefilled with the other panel", /right/i.test(dlg.v) && /alpha\.txt/i.test(dlg.v), dlg.v);
  // NB: a CDP-synthesized Enter does not run the browser's default button/
  // form-submit action in WebView2 (same lesson as alnavi-023) — confirm
  // with a real mouse click on the dialog's primary button
  await clickEl(cdp, `document.querySelector(".overlay .dlg .btn.primary")`);
  const copied = await waitFs(() => existsSync(join(right, "alpha.txt")) && readFileSync(join(right, "alpha.txt"), "utf8") === "alpha-body", 10000, "copy to land on disk");
  check("12. copy lands on disk in right/", copied ? "content ok" : "missing");
  await waitFor(cdp, overlayGone, 8000, "progress overlay to close");
  const rightRow = await waitFor(cdp, `[...document.querySelectorAll(".panel:not(.active) .row")].some(r => /alpha\\.txt/i.test(r.textContent)) ? true : ""`, 10000, "right panel to show the copy");
  check("13. the passive panel re-renders the new file", rightRow === true);

  // ---- F8 delete via the confirm dialog
  await key(cdp, "F8");
  const confirmDlg = await waitFor(cdp, `(() => { const b = [...document.querySelectorAll(".overlay .dlg .dlg-actions button")]; return b.length ? { n: b.length, focus: b.indexOf(document.activeElement) } : null; })()`, 8000, "delete confirm");
  check("14. F8 opens the delete confirm with a focused default", confirmDlg.n === 2 && confirmDlg.focus >= 0, JSON.stringify(confirmDlg));
  // Enter default-action is not synthesized over CDP (see the F5 note) —
  // click the focused «Да» like a user would
  await clickEl(cdp, `document.activeElement.matches(".overlay .dlg .dlg-actions button") ? document.activeElement : document.querySelector(".overlay .dlg .btn.primary")`);
  await waitFs(() => !existsSync(join(left, "alpha.txt")), 10000, "delete to land on disk");
  check("15. «Да» confirms, alpha.txt gone from left/", "deleted");
  await waitFor(cdp, overlayGone, 8000, "progress overlay to close after delete");

  // ---- F4 editor + F2 save
  // after the delete the refreshed view resets the cursor — park it on
  // beta.txt deterministically (Home, then count ArrowDowns), with a retry
  // for a watcher reload landing mid-walk
  let beta = "";
  for (let attempt = 0; attempt < 4 && !/beta\.txt/i.test(beta); attempt++) {
    await key(cdp, "Home");
    await key(cdp, "ArrowDown");
    await key(cdp, "ArrowDown");
    await sleep(300);
    beta = await evalIn(cdp, cursorRow);
  }
  check("16. cursor on beta.txt", /beta\.txt/i.test(beta), beta.replace(/\s+/g, " ").slice(0, 40));
  await key(cdp, "F4");
  await waitFor(cdp, `!!document.querySelector(".editor .cm-editor")`, 10000, "editor to open");
  const edPath = await evalIn(cdp, `document.querySelector(".editor .ed-status .path")?.textContent ?? ""`);
  check("17. F4 opens beta.txt in the editor", norm(edPath).endsWith("beta.txt"), edPath);
  await evalIn(cdp, `document.querySelector(".cm-content")?.focus(); true`);
  await key(cdp, "End", { ctrl: true }); // caret to the end of the doc
  await cdp.send("Input.insertText", { text: " SMOKE" });
  await sleep(300);
  const dirty = await evalIn(cdp, `!!document.querySelector(".editor .ed-status .dirty, .editor .doc-tab .dot")`);
  check("18. typing marks the tab dirty", dirty === true);
  await key(cdp, "F2");
  const saved = await waitFs(() => {
    if (!existsSync(join(left, "beta.txt"))) return false;
    return readFileSync(join(left, "beta.txt"), "utf8").endsWith("beta-body SMOKE");
  }, 10000, "F2 save to reach the disk");
  check("19. F2 saves the edit to disk", saved ? "content ok" : "missing");
  await sleep(500);
  const clean = await evalIn(cdp, `!document.querySelector(".editor .ed-status .dirty")`);
  check("20. the dirty mark clears after the save", clean === true);
  await key(cdp, "Escape");
  const edClosed = await waitFor(cdp, `!document.querySelector(".editor") && !!document.querySelector(".panel")`, 8000, "editor to close");
  check("21. Esc closes the editor back to the panels", edClosed === true);

  // ---- theme + locale cycling from the title bar
  let theme0 = await evalIn(cdp, `document.documentElement.dataset.theme ?? ""`);
  await clickEl(cdp, `[...document.querySelectorAll(".titlebar .tb-btn")].find(b => !b.classList.contains("op-indicator") && !b.textContent.trim() && b.querySelector("i"))`);
  await sleep(400);
  let theme1 = await evalIn(cdp, `document.documentElement.dataset.theme ?? ""`);
  if (theme1 === theme0) {
    // settings may sit on "auto" which resolves to the same visual theme as
    // the first click's target — one more click lands on a visibly new one
    await clickEl(cdp, `[...document.querySelectorAll(".titlebar .tb-btn")].find(b => !b.classList.contains("op-indicator") && !b.textContent.trim() && b.querySelector("i"))`);
    await sleep(400);
    theme1 = await evalIn(cdp, `document.documentElement.dataset.theme ?? ""`);
  }
  check("22. the theme button cycles data-theme", theme1 !== theme0 && THEMES.includes(theme1), `${theme0} -> ${theme1}`);

  const locBtn = `[...document.querySelectorAll(".titlebar .tb-btn")].find(b => !b.classList.contains("op-indicator") && b.textContent.trim())`;
  const fkeys0 = await evalIn(cdp, `document.querySelector(".fkeys")?.textContent ?? ""`);
  const label0 = await evalIn(cdp, `(${locBtn})?.textContent.trim() ?? ""`);
  await clickEl(cdp, locBtn);
  await sleep(400);
  const label1 = await evalIn(cdp, `(${locBtn})?.textContent.trim() ?? ""`);
  const fkeys1 = await evalIn(cdp, `document.querySelector(".fkeys")?.textContent ?? ""`);
  check("23. the locale button cycles the UI language", label0 !== label1 && fkeys0 !== fkeys1, `${label0} -> ${label1}`);
} catch (e) {
  check("script crashed", false, String(e));
} finally {
  const fails = results.filter((x) => !x.ok).length;
  console.log(`\n${fails ? fails + " FAILED" : "ALL " + results.length + " PASSED"}`);
  try { spawn("taskkill", ["/IM", "Al-Navi.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1200);
  restoreCfg();
  try { rmSync(work, { recursive: true, force: true }); } catch {}
  process.exit(fails ? 1 : 0);
}
