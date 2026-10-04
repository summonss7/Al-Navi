// Dev E2E for alnavi-024: keyboard text selection in the command line.
// With text in the line, Shift+Left/Right must select char by char,
// Ctrl+Shift+Left/Right select word by word (repeated presses reach the
// end/start = whole text), Shift+Home/End select to line start/end,
// Ctrl+Left/Right jump by word — all NATIVE input behavior, so the panel
// cursor must NOT move while these run. With an EMPTY line Shift+arrows
// keep the FAR panel page move, and Up/Down still move the panel row.
// Usage: node scripts/e2e-alnavi-024-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9248;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-024-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return { ready, send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); }, close: () => ws.close() };
}
async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

// real key events through CDP so the input's own default actions (selection!)
// run — synthetic DOM KeyboardEvents never trigger them
const VK = { Enter: 13, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
const MOD = { ctrl: 2, shift: 8 };
async function key(cdp, k, { ctrl = false, shift = false } = {}) {
  let modifiers = 0;
  if (ctrl) modifiers += MOD.ctrl;
  if (shift) modifiers += MOD.shift;
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k] ?? 0, modifiers };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(80);
}
async function type(cdp, text) {
  for (const ch of text) {
    // a proper `code` matters: without it Chromium drops the default insert
    // for some keys (space produced nothing in the first run)
    let code;
    if (/[a-z]/i.test(ch)) code = "Key" + ch.toUpperCase();
    else if (ch === " ") code = "Space";
    const base = { key: ch, code, windowsVirtualKeyCode: ch === " " ? 32 : ch.toUpperCase().charCodeAt(0) };
    await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown", text: ch });
    await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    await sleep(20);
  }
  await sleep(80);
}

try {
  const step = (m) => console.log(`-- ${m}`);
  step("waiting vite");
  await waitFor(() => fetch(`${ORIGIN}/`).then((r) => (r.ok ? true : null)), 30000, "vite dev");
  step("waiting edge cdp");
  const targets = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.find((t) => t.type === "page");
  }, 20000, "edge cdp");
  const cdp = await connect(targets.webSocketDebuggerUrl);
  await cdp.ready;

  // a pre-load mock via Page.addScriptToEvaluateOnNewDocument never ran in
  // this Edge build (hasInvoke stayed undefined), so the mock is installed
  // after load 023-style and the panels are re-initialized manually — the
  // store instances come from the URLs the app itself uses
  step("navigating");
  await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  await sleep(2500);
  // headless pages start without renderer focus; the flag must be set AFTER
  // the navigation (a new document resets it)
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  step("bootstrapping stores + backend mock");
  await evalIn(cdp, `
    (async () => {
      const rows = [];
      for (let i = 1; i <= 40; i++) {
        rows.push({ name: "file" + String(i).padStart(2, "0") + ".txt", isDir: false, size: 1000 * i, mtime: 0, attrs: "", isSymlink: false, isHidden: false });
      }
      window.__e2eListCalls = 0;
      window.__e2eCbSeq = 0;
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      // listen() from @tauri-apps/api/event needs transformCallback and the
      // plugin:event|listen invoke — without them panels.init() rejects
      window.__TAURI_INTERNALS__.transformCallback = () => ++window.__e2eCbSeq;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen": return Promise.resolve(++window.__e2eCbSeq);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": window.__e2eListCalls++; return Promise.resolve({ path: args.path, entries: rows, freeBytes: 0, totalBytes: 0 });
          case "home_path": return Promise.resolve("D:\\\\e2e");
          case "drives_list": return Promise.resolve([
            { name: "Local (C:)", mountPoint: "C:\\\\", kind: "fixed", totalBytes: 500000000000, freeBytes: 100000000000 },
          ]);
          case "load_json": return Promise.resolve(null);
          case "save_json": return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          default: return Promise.resolve(null);
        }
      };
      const imp = new Function("u", "return import(u)");
      const src = await (await fetch("${ORIGIN}/src/lib/register-commands.ts")).text();
      const urlOf = (re) => {
        const m = src.match(re);
        if (!m) throw new Error("specifier not found: " + re);
        return new URL(m[1], "${ORIGIN}/src/lib/").href;
      };
      const { panels } = await imp(urlOf(/from\\s+"([^"]*stores\\/panels\\.svelte[^"]*)"/));
      const { cmdline } = await imp(urlOf(/from\\s+"([^"]*stores\\/cmdline\\.svelte[^"]*)"/));
      window.__e2e = { panels, cmdline, seen: [] };
      // re-run the panel init against the mock — the boot-time init ran in
      // the browser preview where no backend exists yet
      await panels.init();
      // record every keydown reaching the input, with defaultPrevented as the
      // INPUT sees it (the global window-capture handler already ran)
      cmdline.el.addEventListener("keydown", (e) => {
        window.__e2e.seen.push([e.key, e.ctrlKey, e.shiftKey, e.defaultPrevented]);
      });
      return window.__e2e.panels.left.view.length;
    })()
  `);

  // snapshots: cmdline input selection + panel cursor of the active panel
  const sel = () => evalIn(cdp, `
    (() => {
      const i = window.__e2e.cmdline.el;
      return { v: i.value, s: i.selectionStart, e: i.selectionEnd, focused: document.activeElement === i };
    })()
  `);
  const cursor = () => evalIn(cdp, `window.__e2e.panels.active.cursor`);
  const seen = () => evalIn(cdp, `window.__e2e.seen.splice(0)`);
  const setSel = (s, e) => evalIn(cdp, `
    (() => { const i = window.__e2e.cmdline.el; i.setSelectionRange(${s}, ${e}); return true; })()
  `);

  step("boot state");
  // why is the panel empty? path/error/raw expose the failing stage
  const diag = await evalIn(cdp, `
    (() => {
      const p = window.__e2e.panels.left;
      return {
        listCalls: window.__e2eListCalls ?? -1,
        hasInvoke: typeof window.__TAURI_INTERNALS__?.invoke,
        path: p.path, error: p.error, raw: p.raw.length, view: p.view.length,
      };
    })()
  `);
  console.log("   diag:", JSON.stringify(diag));
  let s = await sel();
  const rows = await evalIn(cdp, `window.__e2e.panels.active.view.length`);
  check("boot: panel has rows (mock list_dir)", rows >= 41, `rows=${rows}`);
  check("boot: cmdline input is focused (owns the caret)", s.focused, `value="${s.v}"`);
  if (!s.focused) await evalIn(cdp, `window.__e2e.cmdline.el.focus(); true`);

  step("typing the test command");
  await type(cdp, "hello world foo"); // len 15
  s = await sel();
  check("typed: value + caret at end, no selection", s.v === "hello world foo" && s.s === 15 && s.e === 15, JSON.stringify(s));

  // ---- Shift+Left / Shift+Right: char selection ----
  step("Shift+arrows: char selection");
  await key(cdp, "ArrowLeft", { shift: true });
  await key(cdp, "ArrowLeft", { shift: true });
  await key(cdp, "ArrowLeft", { shift: true });
  s = await sel();
  check("Shift+Left ×3 selects 3 chars to the left", s.v === "hello world foo" && s.s === 12 && s.e === 15, JSON.stringify(s));
  await key(cdp, "ArrowRight", { shift: true });
  s = await sel();
  check("Shift+Right shrinks the selection by 1", s.s === 13 && s.e === 15, JSON.stringify(s));

  // ---- Ctrl+Shift+arrows: word selection ----
  // Chromium word steps are "word + trailing space": 0 -> 6 -> 12 -> 15
  step("Ctrl+Shift+arrows: word selection");
  await setSel(0, 0);
  await key(cdp, "ArrowRight", { ctrl: true, shift: true });
  s = await sel();
  check("Ctrl+Shift+Right selects the first word", s.s === 0 && s.e === 6, JSON.stringify(s));
  await key(cdp, "ArrowRight", { ctrl: true, shift: true });
  s = await sel();
  check("Ctrl+Shift+Right again extends over the second word", s.s === 0 && s.e === 12, JSON.stringify(s));
  await key(cdp, "ArrowRight", { ctrl: true, shift: true });
  s = await sel();
  check("Ctrl+Shift+Right ×3 reaches the end = whole text selected", s.s === 0 && s.e === 15, JSON.stringify(s));
  // anchor at the END: Ctrl+Shift+Left extends backward, covering everything
  // on the way to the start
  await setSel(15, 15);
  await key(cdp, "ArrowLeft", { ctrl: true, shift: true });
  s = await sel();
  check("Ctrl+Shift+Left extends back over the last word", s.s === 12 && s.e === 15, JSON.stringify(s));
  await key(cdp, "ArrowLeft", { ctrl: true, shift: true });
  s = await sel();
  check("Ctrl+Shift+Left again covers the previous word", s.s === 6 && s.e === 15, JSON.stringify(s));
  await key(cdp, "ArrowLeft", { ctrl: true, shift: true });
  s = await sel();
  check("Ctrl+Shift+Left ×3 reaches the start = whole text selected", s.s === 0 && s.e === 15, JSON.stringify(s));

  // ---- Shift+Home / Shift+End: whole-tail selection ----
  step("Shift+Home/End");
  await setSel(7, 7);
  await key(cdp, "Home", { shift: true });
  s = await sel();
  check("Shift+Home selects to line start", s.s === 0 && s.e === 7, JSON.stringify(s));
  await setSel(7, 7);
  await key(cdp, "End", { shift: true });
  s = await sel();
  check("Shift+End selects to line end", s.s === 7 && s.e === 15, JSON.stringify(s));

  // ---- Ctrl+Left/Right: word jump without selection ----
  step("Ctrl+arrows: word jump");
  await setSel(0, 0);
  await key(cdp, "ArrowRight", { ctrl: true });
  s = await sel();
  check("Ctrl+Right jumps one word, no selection", s.s === 6 && s.e === 6, JSON.stringify(s));
  await key(cdp, "ArrowLeft", { ctrl: true });
  s = await sel();
  check("Ctrl+Left jumps back a word", s.s === 0 && s.e === 0, JSON.stringify(s));

  // ---- plain arrows still native with text ----
  step("plain arrows still native");
  await setSel(15, 15);
  await key(cdp, "ArrowLeft");
  s = await sel();
  check("plain Left moves caret by 1", s.s === 14 && s.e === 14, JSON.stringify(s));
  await key(cdp, "ArrowRight");
  s = await sel();
  check("plain Right moves caret by 1", s.s === 15 && s.e === 15, JSON.stringify(s));

  // ---- the panel never moved through all of the above ----
  step("panel untouched");
  const cur = await cursor();
  check("panel cursor stayed at 0 through the whole selection dance", cur === 0, `cursor=${cur}`);
  const evs = await seen();
  const routed = evs.filter(([k, , , pd]) => ["ArrowLeft", "ArrowRight", "Home", "End"].includes(k));
  check("selection keydowns reached the input un-prevented", routed.length >= 12 && routed.every(([, c, sh, pd]) => pd === false),
    `${routed.length} events, all defaultPrevented=false`);

  // ---- Up/Down with text still drive the panel (FAR row navigation) ----
  step("Up/Down still move the panel while typing");
  await key(cdp, "ArrowDown");
  await key(cdp, "ArrowDown");
  let c2 = await cursor();
  check("ArrowDown with text moves the panel cursor by a row", c2 === 2, `cursor=${c2}`);
  await key(cdp, "ArrowUp");
  c2 = await cursor();
  check("ArrowUp moves it back", c2 === 1, `cursor=${c2}`);

  // ---- empty line: Shift+arrows keep the FAR panel page move ----
  step("empty line: Shift+arrows still page the panel");
  // Enter with text submits through the mock shell and submit() clears the
  // line — also a regression check that the Enter path is untouched
  await key(cdp, "Enter");
  s = await sel();
  check("Enter submitted and cleared the line", s.v === "" && s.s === 0 && s.e === 0, JSON.stringify(s));
  const before = await cursor();
  const viewportRows = await evalIn(cdp, `window.__e2e.panels.active.viewportRows`);
  await key(cdp, "ArrowLeft", { shift: true });
  const afterShiftLeft = await cursor();
  check("empty line: Shift+Left page-moves the panel (FAR Left)", afterShiftLeft !== before, `${before} -> ${afterShiftLeft}`);
  await key(cdp, "ArrowRight", { shift: true });
  const afterShiftRight = await cursor();
  check("empty line: Shift+Right page-moves forward again", afterShiftRight === afterShiftLeft + viewportRows, `${afterShiftLeft} + ${viewportRows} -> ${afterShiftRight}`);
  const evs2 = await seen();
  const emptyRouted = evs2.filter(([k, , sh]) => (k === "ArrowLeft" || k === "ArrowRight") && sh);
  check("empty line: Shift+arrows are prevented at the input (panel owns them)", emptyRouted.length === 2 && emptyRouted.every(([, , , pd]) => pd === true),
    JSON.stringify(emptyRouted));

  step("done");
} catch (e) {
  check("script crashed", false, String(e));
} finally {
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
  edge.kill();
  if (ours) ours.kill();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
