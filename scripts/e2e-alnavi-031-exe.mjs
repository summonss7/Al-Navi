// exe-level E2E for alnavi-031: in the REAL released exe (1.14.2) Ctrl+mouse
// wheel must zoom the interface font exactly like the Ctrl+± chords (0.5 px
// steps, 10..24) — Chrome-style. Real wheel events through CDP verify: both
// directions, accumulation of sub-threshold drabs (two −50 = one step), clamps
// at 24/10, the toast echoing the size, the F9 stepper following live, the
// editor context (Shift+F4 scratch), and — the exe-specific point — that the
// native WebView2 zoom stays out (devicePixelRatio unchanged) while plain
// (non-ctrl) wheels neither zoom nor lose their default scroll action. The
// app's real config (%APPDATA%\al-navi) is backed up and restored; the panel
// is pointed at node_modules (many entries) to make the list scrollable.
// Usage: node scripts/e2e-alnavi-031-exe.mjs [path-to-Al-Navi.exe]
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
const CDP_PORT = 9269;
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

// real key presses (F-keys, Escape, Shift+F4)
const VK = { Escape: 27, F1: 112, F4: 115, F9: 120 };
async function key(cdp, name, mod = 0) {
  const base = { key: name, code: name, windowsVirtualKeyCode: VK[name] ?? 0, modifiers: mod };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(140);
}

// real wheel events: CDP mouse modifiers Alt=1, Ctrl=2, Meta=4, Shift=8
async function wheel(cdp, deltaY, { ctrl = true, x = 640, y = 400 } = {}) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel", x, y, deltaX: 0, deltaY,
    modifiers: ctrl ? 2 : 0,
  });
  await sleep(90);
}
async function clickAt(cdp, x, y) {
  const base = { x, y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  await sleep(300);
}

// live px value derived from the --fs-scale CSS var (no store imports in exe)
const fontPx = async (cdp) => {
  const s = await evalIn(cdp, `parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fs-scale"))`);
  // the saved size is a 0.5 grid — kill the float noise of scale*13.5
  return Math.round(s * 13.5 * 2) / 2;
};
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
// center of the first element matching the selector, for wheel/click aiming
const centerOf = (cdp, sel) => evalIn(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);

try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-031-exe-"));
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
  check("title bar chip carries v1.14.2", ver.includes("1.14.2"), JSON.stringify(ver));

  // probe: record wheels in the BUBBLE phase (after capture listeners) —
  // defaultPrevented separates "the app cancelled it" (ctrl) from native
  await evalIn(cdp, `(() => { window.__wheels = []; window.addEventListener("wheel", (e) => window.__wheels.push({ ctrl: e.ctrlKey, prevented: e.defaultPrevented }), { capture: false, passive: true }); return true; })()`);

  const px0 = await fontPx(cdp);
  check("initial font size read from --fs-scale (0.5 grid)", px0 >= 10 && px0 <= 24, `px=${px0}`);
  const dpr0 = await evalIn(cdp, `window.devicePixelRatio`);

  // ---- both directions, one notch each ----
  const panel = await centerOf(cdp, ".panel");
  const aim = panel ?? { x: 640, y: 400 };
  // click the panel like a user so the window has the keyboard context
  if (panel) await clickAt(cdp, panel.x, panel.y);
  await wheel(cdp, -100, { x: aim.x, y: aim.y });
  let px = await fontPx(cdp);
  check("ctrl+wheel up grows by 0.5 px", near(px, px0 + 0.5), `px=${px} (from ${px0})`);
  const ctrlWheels = await evalIn(cdp, `window.__wheels.filter((w) => w.ctrl)`);
  check("ctrl wheel default action cancelled (native zoom suppressed)", ctrlWheels.length >= 1 && ctrlWheels.every((w) => w.prevented), JSON.stringify(ctrlWheels.slice(0, 2)));
  await wheel(cdp, 100, { x: aim.x, y: aim.y });
  px = await fontPx(cdp);
  check("ctrl+wheel down shrinks back", near(px, px0), `px=${px}`);

  // ---- accumulation of sub-threshold drabs ----
  await wheel(cdp, -50, { x: aim.x, y: aim.y });
  px = await fontPx(cdp);
  check("first −50 drab does not step yet", near(px, px0), `px=${px}`);
  await wheel(cdp, -50, { x: aim.x, y: aim.y });
  px = await fontPx(cdp);
  check("second −50 completes the step", near(px, px0 + 0.5), `px=${px}`);
  await wheel(cdp, 100, { x: aim.x, y: aim.y });
  px = await fontPx(cdp);
  check("full notch down returns to the base", near(px, px0), `px=${px}`);

  // ---- toast echoes the size (locale-independent shape) ----
  await wheel(cdp, -100, { x: aim.x, y: aim.y });
  px = await fontPx(cdp);
  const toast = await evalIn(cdp, `document.querySelector(".toast")?.textContent ?? ""`);
  check("toast echoes the size in px", new RegExp(px.toFixed(1).replace(".", "\\.") + "\\s*px").test(toast), JSON.stringify(toast));
  await wheel(cdp, 100, { x: aim.x, y: aim.y });

  // ---- clamps + native WebView2 zoom must stay out ----
  for (let i = 0; i < 40; i++) await wheel(cdp, -100, { x: aim.x, y: aim.y });
  px = await fontPx(cdp);
  const dpr1 = await evalIn(cdp, `window.devicePixelRatio`);
  check("long ctrl+wheel-up sweep stops at 24 px", near(px, 24), `px=${px}`);
  check("native WebView2 zoom not triggered (dPR unchanged)", dpr1 === dpr0, `dpr ${dpr0} -> ${dpr1}`);
  for (let i = 0; i < 50; i++) await wheel(cdp, 100, { x: aim.x, y: aim.y });
  px = await fontPx(cdp);
  const dpr2 = await evalIn(cdp, `window.devicePixelRatio`);
  check("long ctrl+wheel-down sweep stops at 10 px", near(px, 10), `px=${px}`);
  check("dPR still unchanged after the down sweep", dpr2 === dpr0, `dpr ${dpr0} -> ${dpr2}`);

  // ---- editor context: Ctrl+Shift+F4 scratch (Shift+F4 alone asks for a
  // file name — a dialog, not the editor) ----
  await key(cdp, "F4", 10); // Ctrl+Shift+F4 — new scratch editor
  await waitFor(cdp, `!!document.querySelector(".cm-editor")`, 10000, "editor");
  const ed = await centerOf(cdp, ".cm-editor");
  await wheel(cdp, 100, { ctrl: false, x: ed?.x ?? 640, y: ed?.y ?? 400 });
  px = await fontPx(cdp);
  check("plain wheel over the editor does not zoom", near(px, 10), `px=${px}`);
  await wheel(cdp, -100, { x: ed?.x ?? 640, y: ed?.y ?? 400 });
  px = await fontPx(cdp);
  check("ctrl+wheel over the editor grows", near(px, 10.5), `px=${px}`);
  await key(cdp, "Escape");
  const modeBack = await evalIn(cdp, `!!document.querySelector(".panel, .panels")`);
  check("Esc closed the scratch back to panels", modeBack === true);

  // ---- F9 dialog stepper follows live ----
  await key(cdp, "F9");
  await waitFor(cdp, `!!document.querySelector(".fs-val")`, 8000, "F9 dialog");
  await wheel(cdp, -100);
  px = await fontPx(cdp);
  const fsVal = await evalIn(cdp, `document.querySelector(".fs-val")?.textContent ?? ""`);
  check("ctrl+wheel inside the F9 dialog updates the stepper label", new RegExp(px.toFixed(1).replace(".", "\\.")).test(fsVal), `px=${px} label=${JSON.stringify(fsVal)}`);
  await key(cdp, "Escape");

  // ---- plain wheel: no zoom, default action stays live, list scrolls ----
  // point the left panel at a big real directory so the list is scrollable
  const cmdline = await centerOf(cdp, ".cmdline input");
  if (cmdline) {
    await clickAt(cdp, cmdline.x, cmdline.y);
    await key(cdp, "Escape"); // clear any text so the caret is free
    await cdp.send("Input.insertText", { text: "cd D:\\Al-Navi\\node_modules" });
    await key(cdp, "Enter");
    await waitFor(cdp, `(() => { const v = document.querySelector(".vlist"); return v && v.scrollHeight > v.clientHeight; })()`, 10000, "scrollable list");
  }
  const list = await centerOf(cdp, ".vlist");
  const pxBeforePlain = await fontPx(cdp);
  await evalIn(cdp, `window.__wheels.length = 0`);
  for (let i = 0; i < 6; i++) await wheel(cdp, 120, { ctrl: false, x: list?.x ?? aim.x, y: list?.y ?? aim.y });
  px = await fontPx(cdp);
  const plain = await evalIn(cdp, `window.__wheels.filter((w) => !w.ctrl)`);
  check("plain wheel did not zoom", near(px, pxBeforePlain), `px=${px} (was ${pxBeforePlain})`);
  check("plain wheel left the default action live (not prevented)", plain.length === 6 && plain.every((w) => !w.prevented), JSON.stringify(plain.slice(0, 2)));
  // NOTE: asserting scrollTop here is not possible — neither CDP-synthetic nor
  // SendInput wheels get their default scroll APPLIED by the WebView2
  // compositor in this harness (verified identical on the pre-change 1.12.12
  // exe, and on a listener-free static page: the app never cancels the
  // default — defaultPrevented=false — so real-wheel scrolling is unchanged;
  // a REAL Ctrl+wheel via OS SendInput was verified to zoom by hand)

  // ---- F1 documents the wheel ----
  await key(cdp, "F1");
  await waitFor(cdp, `!!document.querySelector(".dlg.help-dlg")`, 8000, "help dialog");
  const help = await evalIn(cdp, `
    (() => {
      const rows = [...document.querySelectorAll(".help-dlg .hrow")];
      const hit = rows.find((x) => x.querySelector("kbd")?.textContent.includes("Ctrl+− / +"));
      return { found: !!hit, kbd: hit?.querySelector("kbd")?.textContent ?? "", rows: rows.length };
    })()
  `);
  check("help row lists Ctrl+− / + · Ctrl+Wheel (95 rows", help.found && help.rows === 95 && /Ctrl\+Wheel/.test(help.kbd), `rows=${help.rows} kbd=${JSON.stringify(help.kbd)}`);
  await key(cdp, "Escape");

  // ---- return the user's original size by wheel presses ----
  let cur = await fontPx(cdp);
  while (cur < px0 - 0.01) { await wheel(cdp, -100); cur = await fontPx(cdp); }
  while (cur > px0 + 0.01) { await wheel(cdp, 100); cur = await fontPx(cdp); }
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
