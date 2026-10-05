// E2E for 1.10.6 (alnavi-015) on the real Al-Navi exe via CDP: the F3 text
// viewer scrolls with the keyboard. The viewer never focused its CodeMirror
// view, so arrows/PgUp/PgDn did nothing after F3 (only the mouse wheel
// worked). Drives the real UI: command line navigation, F3 to view, trusted
// key events, mouse wheel; also checks Esc back to panels, scroll position
// memory on reopen, F8 hex round-trip and the F4 editor focus regression.
// Usage: node scripts/e2e-1-10-6.mjs <path-to-exe>
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: node scripts/e2e-1-10-6.mjs <exe>");
  process.exit(1);
}

const FIXT = join(tmpdir(), "alnavi-1106");
const ROOT = join(FIXT, "root");
const CFG = join(process.env.APPDATA, "al-navi");
const PORT = 9238;
const profile = mkdtempSync(join(tmpdir(), "alnavi-1106-cdp-"));

// the app writes session/window/history/editor state into the real config
// dir — back it up and restore afterwards so the E2E leaves no trace.
// window.json is pre-seeded with a sane 1280x800 geometry (the user's real
// one may hold a minimized-window leftover, see CARDS/016)
const backedUp = [];
for (const f of ["session.json", "window.json", "dir-history.json", "xfer-history.json", "editor-state.json", "view-history.json"]) {
  const p = join(CFG, f);
  if (existsSync(p)) {
    cpSync(p, p + ".e2e-bak");
    backedUp.push(p);
  }
}
writeFileSync(join(CFG, "window.json"), JSON.stringify({ x: 80, y: 60, w: 1280, h: 800, maximized: false }));
function restoreCfg() {
  for (const p of backedUp) cpSync(p + ".e2e-bak", p);
}

// ~25 lines fit the 1280x800 viewport, so 40 arrow presses scroll past it
const LONG = Array.from({ length: 300 }, (_, i) => "line " + (i + 1)).join("\r\n");
const EDIT = "editable doc\r\nsecond line";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

async function launch() {
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
    detached: false,
  });
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && !t.url.startsWith("about:"));
      if (page) {
        const cdp = await connect(page.webSocketDebuggerUrl);
        await cdp.ready;
        await sleep(2500);
        return { child, cdp };
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("CDP target not found");
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
  return {
    ready,
    send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); },
    close: () => ws.close(),
  };
}

async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}

async function key(cdp, k, opts = {}) {
  const base = {
    key: k,
    code: opts.code ?? k,
    windowsVirtualKeyCode: opts.keyCode,
    nativeVirtualKeyCode: opts.keyCode,
    modifiers: (opts.alt ? 1 : 0) | (opts.ctrl ? 2 : 0) | (opts.shift ? 8 : 0),
  };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}
const arrows = (cdp, n) => { let q = Promise.resolve(); for (let i = 0; i < n; i++) q = q.then(() => key(cdp, "ArrowDown", { keyCode: 40 })).then(() => sleep(40)); return q; };

// navigate the active panel through the command line
async function cd(cdp, dir) {
  await evalIn(cdp, `(() => {
    const inp = document.querySelector(".cmdline input");
    inp.focus();
    inp.value = ${JSON.stringify("cd " + dir)};
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await key(cdp, "Enter", { keyCode: 13 });
  await sleep(700);
}
async function cursorName(cdp) {
  return evalIn(cdp, `document.querySelector(".panel.active .vlist .row.cursor .name")?.getAttribute("title") ?? null`);
}
async function cursorTo(cdp, name, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const cur = await cursorName(cdp);
    if (cur === name) return true;
    await key(cdp, "ArrowDown", { keyCode: 40 });
    await sleep(60);
  }
  return false;
}

const scrollState = (cdp) => evalIn(cdp, `(() => {
  const sc = document.querySelector(".viewer .cm-scroller");
  return sc ? { top: sc.scrollTop, h: sc.scrollHeight, ch: sc.clientHeight, focus: (document.activeElement?.className ?? document.activeElement?.tagName ?? "").slice(0, 30) } : null;
})()`);

let child = null;
let cdp = null;
try {
  rmSync(FIXT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "long.txt"), LONG, "utf8");
  writeFileSync(join(ROOT, "edit.txt"), EDIT, "utf8");

  ({ child, cdp } = await launch());
  console.log("connected");

  // ---- 1. boot + version ----
  const ver = await evalIn(cdp, `document.querySelector(".version")?.textContent ?? ""`);
  check("1: version 1.10.6 in UI", /1\.10\.6/.test(ver ?? ""), ver);

  // ---- 2. F3 opens long.txt in the viewer ----
  await cd(cdp, ROOT);
  if (!(await cursorTo(cdp, "long.txt"))) throw new Error("cursor not on long.txt");
  await key(cdp, "F3", { keyCode: 114, code: "F3" });
  await sleep(1000);
  let st = await scrollState(cdp);
  check("2: F3 opens the text viewer", st !== null && st.h > st.ch, JSON.stringify(st));

  // ---- 3. focus is in the text, not the command line ----
  check("3: focus is in the viewer text (cm-content)", (st.focus ?? "").includes("cm-content"), JSON.stringify(st.focus));

  // ---- 4. arrows scroll ----
  await arrows(cdp, 40);
  st = await scrollState(cdp);
  check("4: 40x ArrowDown scrolls the text", st.top > 100, "top=" + st.top);

  // ---- 5. PageDown / PageUp ----
  const before = st.top;
  await key(cdp, "PageDown", { keyCode: 34 });
  await sleep(350);
  st = await scrollState(cdp);
  check("5a: PageDown pages down", st.top - before >= st.ch - 60, `${before} -> ${st.top} (vh ${st.ch})`);
  await key(cdp, "PageUp", { keyCode: 33 });
  await sleep(350);
  const stBack = await scrollState(cdp);
  check("5b: PageUp pages back up", Math.abs(stBack.top - before) < 10, `${st.top} -> ${stBack.top}`);

  // ---- 6. Ctrl+PageDown to the end ----
  await key(cdp, "PageDown", { keyCode: 34, ctrl: true });
  await sleep(600);
  st = await scrollState(cdp);
  check("6: Ctrl+PageDown jumps to the document end", st.top >= st.h - st.ch - 10, `top=${st.top} max=${st.h - st.ch}`);

  // ---- 7. mouse wheel ----
  const box = await evalIn(cdp, `(() => {
    const r = document.querySelector(".viewer .cm-scroller").getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  const w0 = st.top;
  for (let i = 0; i < 3; i++) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -120 });
    await sleep(150);
  }
  st = await scrollState(cdp);
  check("7: mouse wheel scrolls (up, away from the end)", st.top < w0, `${w0} -> ${st.top}`);

  // ---- 8. readonly under typing (checked against the file after closing,
  //         because CM virtualizes: .cm-content holds only the visible lines)
  await key(cdp, "x");
  await key(cdp, "Enter", { keyCode: 13 });
  await sleep(300);
  const rowsOk = await evalIn(cdp, `(document.querySelector(".viewer .cm-content")?.textContent ?? "").match(/line \\d+/g)?.length ?? 0`);
  check("8: typing in the viewer leaves the visible rows intact", rowsOk >= 10, "rows=" + rowsOk);

  // ---- 9. F8 hex round-trip ----
  await key(cdp, "F8", { keyCode: 119, code: "F8" });
  await sleep(500);
  const hexUp = await evalIn(cdp, `!!document.querySelector(".viewer .hex") && !document.querySelector(".viewer .cm-scroller")`);
  check("9a: F8 switches to hex, text view released", hexUp === true);
  await key(cdp, "F8", { keyCode: 119, code: "F8" });
  await sleep(1200); // text reload + position restore retries
  st = await scrollState(cdp);
  check("9b: F8 back to text rebuilds the view", st !== null, JSON.stringify(st));
  check("9c: focus back in the text after the round-trip", (st.focus ?? "").includes("cm-content"), JSON.stringify(st.focus));
  const t9 = st.top;
  await arrows(cdp, 40);
  st = await scrollState(cdp);
  check("9d: arrows scroll again after hex round-trip", st.top !== t9 && st.top > 0, `${t9} -> ${st.top}`);

  // ---- 10. Esc -> panels + cmdline caret; F3 again restores the scroll ----
  await sleep(700); // let the 300ms tracker pick the position up
  const posBefore = (await scrollState(cdp)).top;
  await key(cdp, "Escape", { keyCode: 27, code: "Escape" });
  await sleep(700);
  const panelsState = await evalIn(cdp, `(() => ({
    viewerGone: !document.querySelector(".viewer"),
    isCmd: document.activeElement === document.querySelector(".cmdline input"),
  }))()`);
  check("10a: Esc closes the viewer back to panels", panelsState.viewerGone === true, JSON.stringify(panelsState));
  check("10b: the command line owns the caret again", panelsState.isCmd === true, JSON.stringify(panelsState));
  // the end-to-end readonly proof: after typing 'x'/Enter in the viewer the
  // file on disk must be byte-identical
  const { readFileSync } = await import("node:fs");
  check("10b2: file on disk unchanged after typing in the viewer", readFileSync(join(ROOT, "long.txt"), "utf8") === LONG);
  await key(cdp, "F3", { keyCode: 114, code: "F3" });
  await sleep(1400); // reload + restore retries
  st = await scrollState(cdp);
  check("10c: F3 reopen restores the scroll position", Math.abs(st.top - posBefore) < 100, `was ${posBefore}, now ${st.top}`);
  check("10d: reopen refocuses the text", (st.focus ?? "").includes("cm-content"), JSON.stringify(st.focus));

  // ---- 11. F4 editor regression ----
  await key(cdp, "Escape", { keyCode: 27, code: "Escape" });
  await sleep(600);
  if (!(await cursorTo(cdp, "edit.txt"))) throw new Error("cursor not on edit.txt");
  await key(cdp, "F4", { keyCode: 115, code: "F4" });
  await sleep(1000);
  const ed = await evalIn(cdp, `(() => ({
    viewerGone: !document.querySelector(".viewer"),
    cls: document.activeElement?.className ?? "",
  }))()`);
  check("11: F4 editor keeps its focus behavior", ed.viewerGone && ed.cls.includes("cm-content"), JSON.stringify(ed));

  cdp.close();
} catch (e) {
  console.error("E2E error:", e);
  results.push({ name: "script completed", ok: false, info: String(e) });
} finally {
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  try { if (child) child.kill(); } catch { /* already gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { rmSync(FIXT, { recursive: true, force: true }); } catch {}
  restoreCfg();
  process.exit(fails ? 1 : 0);
}
