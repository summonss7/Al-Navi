// Dev E2E for 1.10.6 (alnavi-015): the F3 text viewer scrolls with the
// keyboard. The viewer never focused its CodeMirror view, so after F3 the
// keyboard stayed with the page shell — arrows/PgUp/PgDn did nothing (the
// mouse wheel worked). Loads the app from the vite dev server in headless
// Edge, installs a fake read_text backend into window.__TAURI_INTERNALS__ and
// drives the REAL editor store + the mounted CodeMirror view with trusted CDP
// key events. Covers: focus on open, arrow/page scrolling, wheel, Ctrl+PageUp/
// PageDown doc ends, readonly typing, F8 hex round-trip, Esc back to panels
// with the cmdline caret, scroll position memory on reopen, Ctrl+Tab doc ring
// keeping focus, F1 dialog returning focus, and the F4 editor focus regression.
// Usage: node scripts/e2e-1-10-6-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9237;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-1106-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 300 numbered lines: ~14 fit the 314px viewport, so 25 arrows and every
// PageDown visibly move the scroller
const LONG = Array.from({ length: 300 }, (_, i) => "line " + (i + 1)).join("\n");
const OTHER = Array.from({ length: 200 }, (_, i) => "other " + (i + 1)).join("\n");
const EDIT = "editable doc\nsecond line";
const P = {
  long: "D:\\E2E-1106\\long.txt",
  other: "D:\\E2E-1106\\other.txt",
  edit: "D:\\E2E-1106\\edit.txt",
};
const FS = { [P.long]: LONG, [P.other]: OTHER, [P.edit]: EDIT };

const alive = await fetch(`${ORIGIN}/`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
const ours = alive && alive.includes("Al-Navi") ? null : spawn("npm", ["run", "dev"], { shell: true, stdio: "ignore" });
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
    await sleep(250);
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
  return {
    ready,
    send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); },
    close: () => ws.close(),
  };
}
async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails));
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
const arrows = (cdp, n) => { let q = Promise.resolve(); for (let i = 0; i < n; i++) q = q.then(() => key(cdp, "ArrowDown", { keyCode: 40 })).then(() => sleep(30)); return q; };
// ~25 lines fit the 1280x800 viewport, so 40 presses scroll well past it
const ARROWS = 40;

const scrollState = (cdp) => evalIn(cdp, `(() => {
  const sc = document.querySelector(".viewer .cm-scroller");
  return sc ? { top: sc.scrollTop, h: sc.scrollHeight, ch: sc.clientHeight, focus: document.activeElement?.className?.slice(0, 30) ?? document.activeElement?.tagName } : null;
})()`);

try {
  await waitFor(() => fetch(`${ORIGIN}/`).then((r) => (r.ok ? true : null)), 30000, "vite dev");
  const targets = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.find((t) => t.type === "page");
  }, 20000, "edge cdp");
  const cdp = await connect(targets.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  await sleep(2500);

  // bootstrap: mock backend, stores via the exact URLs register-commands.ts
  // uses (HMR-instance lesson), init the editor store (positions), open long.txt
  const booted = await evalIn(cdp, `
    (async () => {
      const imp = new Function("u", "return import(u)");
      const base = "${ORIGIN}/src/lib/";
      const src = await (await fetch(base + "register-commands.ts")).text();
      const u = (re) => new URL(src.match(re)[1], base).href;
      const { editor } = await imp(u(/from\\s+"([^"]*editor\\.svelte\\.ts[^"]*)"/));
      window.__e2e = { editor };
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        if (cmd === "read_text") {
          const text = ${JSON.stringify(FS)}[args.path];
          if (text === undefined) return Promise.reject(new Error("no such file: " + args.path));
          return Promise.resolve({ text, encoding: "utf-8", eol: "lf", truncated: false });
        }
        if (cmd === "load_json") return Promise.resolve(null);
        if (cmd === "save_json") return Promise.resolve(null);
        return Promise.resolve(null);
      };
      await editor.init();
      await editor.view(${JSON.stringify(P.long)});
      return editor.activeViewer?.mode ?? "none";
    })()
  `);
  check("bootstrap: long.txt opens in the text viewer", booted === "text", String(booted));
  await sleep(800);

  // 1) focus moves into the text, not the command line
  let st = await scrollState(cdp);
  check("1: focus is in the viewer text (cm-content)", (st.focus ?? "").includes("cm-content"), JSON.stringify(st));

  // 2) arrows scroll (viewport ~25 lines, 40 presses cross it)
  await arrows(cdp, ARROWS);
  st = await scrollState(cdp);
  check("2: 40x ArrowDown scrolls the text", st.top > 100, "top=" + st.top);

  // 3) PageDown / PageUp page by a viewport
  const before = st.top;
  await key(cdp, "PageDown", { keyCode: 34 });
  await sleep(300);
  st = await scrollState(cdp);
  check("3a: PageDown pages down", st.top - before >= st.ch - 50, `${before} -> ${st.top} (vh ${st.ch})`);
  await key(cdp, "PageUp", { keyCode: 33 });
  await sleep(300);
  const stBack = await scrollState(cdp);
  check("3b: PageUp pages back up", Math.abs(stBack.top - before) < 5, `${st.top} -> ${stBack.top}`);

  // 4) Ctrl+PageDown goes to the very end (1.5.1 binding regression)
  await key(cdp, "PageDown", { keyCode: 34, ctrl: true });
  await sleep(500);
  st = await scrollState(cdp);
  check("4: Ctrl+PageDown jumps to the document end", st.top >= st.h - st.ch - 5, `top=${st.top} max=${st.h - st.ch}`);
  await key(cdp, "PageUp", { keyCode: 33, ctrl: true });
  await sleep(500);
  st = await scrollState(cdp);
  check("4b: Ctrl+PageUp returns to the document start", st.top === 0, "top=" + st.top);

  // 5) mouse wheel keeps scrolling
  const box = await evalIn(cdp, `(() => {
    const r = document.querySelector(".viewer .cm-scroller").getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  const w0 = st.top;
  for (let i = 0; i < 3; i++) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 120 });
    await sleep(120);
  }
  st = await scrollState(cdp);
  check("5: mouse wheel scrolls", st.top > w0, `${w0} -> ${st.top}`);

  // 6) readonly: typing changes nothing
  const len0 = await evalIn(cdp, `window.__e2e.editor.activeViewer.text.length`);
  await key(cdp, "x");
  await key(cdp, "Enter", { keyCode: 13 });
  await sleep(300);
  const len1 = await evalIn(cdp, `window.__e2e.editor.activeViewer.text.length`);
  check("6: viewer stays readonly under typing", len0 === len1, `${len0} vs ${len1}`);

  // 7) F8 hex round-trip: view released, then rebuilt AND refocused
  await evalIn(cdp, `window.__e2e.editor.toggleHexActive()`);
  await sleep(400);
  const hexUp = await evalIn(cdp, `!!document.querySelector(".viewer .hex") && !document.querySelector(".viewer .cm-scroller")`);
  check("7a: F8 switches to hex, text view released", hexUp === true);
  await evalIn(cdp, `window.__e2e.editor.toggleHexActive()`);
  await sleep(900); // text reload + restorePos retries
  st = await scrollState(cdp);
  check("7b: F8 back to text rebuilds the view", st !== null, JSON.stringify(st));
  check("7c: focus back in the text after the round-trip", (st.focus ?? "").includes("cm-content"), JSON.stringify(st.focus));
  const t7 = st.top;
  await arrows(cdp, ARROWS);
  st = await scrollState(cdp);
  check("7d: arrows scroll again after hex round-trip", st.top !== t7 && st.top > 0, `${t7} -> ${st.top}`);

  // 8) scroll position memory: close (Esc) -> panels + cmdline caret, reopen -> same scroll
  await sleep(600); // let the 300ms tracker pick the offset up
  const posBefore = (await scrollState(cdp)).top;
  await key(cdp, "Escape", { keyCode: 27, code: "Escape" });
  await sleep(600);
  const panelsState = await evalIn(cdp, `(() => ({
    viewerGone: !document.querySelector(".viewer"),
    focus: document.activeElement?.tagName,
    isCmd: document.activeElement === document.querySelector(".cmdline input"),
  }))()`);
  check("8a: Esc closes the viewer back to panels", panelsState.viewerGone === true, JSON.stringify(panelsState));
  check("8b: the command line owns the caret again", panelsState.isCmd === true, JSON.stringify(panelsState));
  await evalIn(cdp, `window.__e2e.editor.view(${JSON.stringify(P.long)})`);
  await sleep(900);
  st = await scrollState(cdp);
  check("8c: reopen restores the scroll position", Math.abs(st.top - posBefore) < 40, `was ${posBefore}, now ${st.top}`);
  check("8d: reopen refocuses the text", (st.focus ?? "").includes("cm-content"), JSON.stringify(st.focus));

  // 9) two viewer docs + Ctrl+Tab ring keeps focus and per-doc scroll
  await evalIn(cdp, `window.__e2e.editor.view(${JSON.stringify(P.other)})`);
  await sleep(700);
  await arrows(cdp, ARROWS);
  const otherTop = (await scrollState(cdp)).top;
  check("9a: second doc scrolled", otherTop > 100, "top=" + otherTop);
  // ring is [long, other, panels]: Shift-step back to long
  await key(cdp, "Tab", { keyCode: 9, ctrl: true, shift: true });
  await sleep(700);
  st = await scrollState(cdp);
  check("9b: Ctrl+Shift+Tab switches back to the first viewer doc", st !== null, JSON.stringify(st));
  check("9c: focus stays in the text after the switch", (st.focus ?? "").includes("cm-content"), JSON.stringify(st.focus));
  check("9d: first doc keeps its own scroll", Math.abs(st.top - posBefore) < 40, `top=${st.top}, was ${posBefore}`);
  await key(cdp, "Tab", { keyCode: 9, ctrl: true }); // ring: forward to other
  await sleep(700);
  const otherBack = await scrollState(cdp);
  // tolerance 100px: CM re-aligns the viewport to the caret line after the
  // restore timers end, so the offset can settle a few lines off the saved
  // one — what matters is it's near the remembered place, not back at 0
  check("9e: Ctrl+Tab returns to the second doc with its scroll", otherBack !== null && Math.abs(otherBack.top - otherTop) < 100, `top=${otherBack?.top}, was ${otherTop}`);
  await key(cdp, "Tab", { keyCode: 9, ctrl: true }); // ring: panels
  await sleep(500);
  const onPanels = await evalIn(cdp, `!document.querySelector(".viewer")`);
  check("9f: Ctrl+Tab from the last doc goes to panels", onPanels === true);

  // 10) dialog round-trip: F1 help -> Esc -> focus and scrolling back
  await evalIn(cdp, `window.__e2e.editor.view(${JSON.stringify(P.long)})`);
  await sleep(700);
  await key(cdp, "F1", { keyCode: 112, code: "F1" });
  await sleep(500);
  const helpUp = await evalIn(cdp, `!!document.querySelector(".dlg.help-dlg")`);
  check("10-pre: F1 opens the help dialog", helpUp === true);
  await key(cdp, "Escape", { keyCode: 27, code: "Escape" });
  await sleep(600);
  st = await scrollState(cdp);
  check("10: after the help dialog closes, focus returns to the text", st !== null && (st.focus ?? "").includes("cm-content"), JSON.stringify(st));
  const t10 = st?.top ?? 0;
  await arrows(cdp, ARROWS);
  st = await scrollState(cdp);
  check("10b: scrolling still works after the dialog", st.top > t10, `${t10} -> ${st.top}`);

  // 11) F4 editor regression: its view still takes focus
  await key(cdp, "Escape", { keyCode: 27, code: "Escape" });
  await sleep(500);
  await evalIn(cdp, `window.__e2e.editor.open(${JSON.stringify(P.edit)})`);
  await sleep(700);
  const edFocus = await evalIn(cdp, `(() => {
    const el = document.activeElement;
    return { cls: el?.className ?? el?.tagName ?? "", viewerGone: !document.querySelector(".viewer") };
  })()`);
  check("11: F4 editor keeps its focus behavior", edFocus.cls.includes("cm-content") && edFocus.viewerGone, JSON.stringify(edFocus));

  cdp.close();
} finally {
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  edge.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  if (ours) ours.kill();
  process.exit(fails ? 1 : 0);
}
