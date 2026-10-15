// Exe-level E2E for alnavi-030: in the REAL released exe (1.14.2) the first
// Ctrl+PageDown pressed right after entering the editor must stick. The bug:
// the position-restore timers kept re-asserting the saved scrollTop
// (120/300/600ms) over the user's scroll, so the view flickered to the end
// and rolled back; the second press worked. Against the real backend:
//   - a tall sandbox file is opened with a seeded remembered position
//     (editor-state.json, backed-up real config) — no input: the position
//     restores and holds (the feature itself stays intact)
//   - re-entering the editor and pressing Ctrl+PageDown immediately lands
//     the caret on the last line AND keeps the view at the bottom
//   - a repeat press keeps the bottom (the old workaround)
//   - re-entering and pressing Ctrl+PageUp immediately jumps to the top
// Usage: node scripts/e2e-alnavi-030-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.14.2";
const CFG = join(process.env.APPDATA, "al-navi");
const CDP_PORT = 9264;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// the tall document, same layout as the dev variant: fixed-width lines
const LINES = 3000;
const SAVED_LINE = 101;
const SAVED_SCROLL = 1200;
const lineAt = (i) => `line ${String(i + 1).padStart(4, "0")} — the quick brown fox jumps over the lazy dog`;
const LINE_LEN = lineAt(0).length + 1;
const ANCHOR = (SAVED_LINE - 1) * LINE_LEN;

// sandbox + seeded editor-state.json (real config is backed up / restored)
const work = mkdtempSync(join(tmpdir(), "alnavi030exe"));
const tall = join(work, "tall.txt");
writeFileSync(tall, Array.from({ length: LINES }, (_, i) => lineAt(i)).join("\n") + "\n");
const stateEntry = { [tall]: { pos: { anchor: ANCHOR, head: ANCHOR, scrollTop: SAVED_SCROLL }, ts: 1 } };
mkdirSync(CFG, { recursive: true });
const backedUp = [];
for (const f of readdirSync(CFG)) {
  if (f.endsWith(".e2e-bak")) continue;
  const p = join(CFG, f);
  cpSync(p, p + ".e2e-bak", { recursive: true });
  backedUp.push(p);
}
function restoreCfg() {
  for (let i = 0; i < 3; i++) {
    try {
      for (const p of backedUp) cpSync(p + ".e2e-bak", p, { recursive: true });
      // files the run created (e.g. a fresh editor-state.json) go away
      for (const f of readdirSync(CFG)) {
        const p = join(CFG, f);
        if (!f.endsWith(".e2e-bak") && !backedUp.some((b) => b === p)) rmSync(p, { recursive: true, force: true });
      }
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
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
const waitFor = async (cdp, expr, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await evalIn(cdp, expr);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(120);
  }
};

const VK = { Enter: 13, Escape: 27, Home: 36, ArrowDown: 40, F4: 115, PageDown: 34, PageUp: 33 };
const MOD = { ctrl: 2 };
async function key(cdp, k, { ctrl = false } = {}) {
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k] ?? 0, modifiers: ctrl ? MOD.ctrl : 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(100);
}
async function typeLine(cdp, text) {
  await cdp.send("Input.insertText", { text });
  await sleep(120);
  await key(cdp, "Enter");
}

// scroll geometry + the caret line parsed off the status bar (locale-agnostic:
// the first integer in the first .mono chip is the line number)
const cmState = (cdp) => evalIn(cdp, `(() => {
  const sc = document.querySelector(".cm-scroller");
  const chip = document.querySelectorAll(".ed-status:not(.top) .mono")[0]?.textContent ?? "";
  const m = chip.match(/\\d+/);
  if (!sc) return null;
  return { scrollTop: sc.scrollTop, maxScroll: sc.scrollHeight - sc.clientHeight, caretLine: m ? Number(m[0]) : -1 };
})()`);
const nearBottom = (s) => s.maxScroll - s.scrollTop <= s.maxScroll * 0.1;
const nearTop = (s) => s.scrollTop <= 30;

async function enterEditor(cdp) {
  // from the panels: the cursor sits on the tall file — F4 opens it, then act
  // FAST: the press must land inside the 600ms window of the restore timers
  await key(cdp, "F4");
  await waitFor(cdp, `!!document.querySelector(".cm-editor") && document.activeElement?.classList?.contains("cm-content") ? 1 : ""`, 15000, "editor focused");
}

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: mkdtempSync(join(tmpdir(), "alnavi-030-exe-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "ignore",
});
try {
  // seed the remembered position BEFORE the app reads editor-state.json
  writeFileSync(join(CFG, "editor-state.json"), JSON.stringify(stateEntry));

  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => ({ json: async () => [] }))).json();
    wsUrl = list.find(t => t.type === "page")?.webSocketDebuggerUrl ?? null;
    if (wsUrl) break;
    await sleep(500);
  }
  check("1. exe launches (CDP target up)", !!wsUrl);
  if (!wsUrl) throw new Error("no CDP target");
  const cdp = connect(wsUrl);
  await cdp.ready;
  await sleep(3000);
  await waitFor(cdp, `!!document.querySelector(".panel")`, 15000, "app UI");
  await evalIn(cdp, `document.querySelector(".panel")?.scrollIntoView(); document.querySelector(".cmdline input")?.focus(); true`);

  const ver = await evalIn(cdp, `(document.querySelector(".version")?.textContent ?? "").trim()`);
  check("2. title bar chip carries v" + VERSION_PIN, ver.includes(VERSION_PIN), ver);

  await typeLine(cdp, `cd ${work}`);
  const crumbs = await waitFor(cdp, `(document.querySelector(".panel.active .crumbs")?.textContent ?? "").toLowerCase().includes("alnavi030exe") ? 1 : ""`, 8000, "sandbox cd");
  check("3. cd into the sandbox", !!crumbs);

  // cursor onto the tall file (Home -> ".." is row 0, the file is row 1)
  await key(cdp, "Home");
  await key(cdp, "ArrowDown");

  await enterEditor(cdp);
  await sleep(1200); // let every restore timer fire — no user input at all
  let s = await cmState(cdp);
  check("4. remembered position restores and holds", s && Math.abs(s.scrollTop - SAVED_SCROLL) <= 150 && s.caretLine === SAVED_LINE,
    `scrollTop=${s?.scrollTop} want=${SAVED_SCROLL} line=${s?.caretLine} want=${SAVED_LINE}`);

  await key(cdp, "Escape"); // back to the panels (doc keeps its position)
  await enterEditor(cdp);
  await key(cdp, "PageDown", { ctrl: true });
  await sleep(1200);
  s = await cmState(cdp);
  // the text ends with \n, so doc end = line LINES+1 (the empty last line)
  check("5. first Ctrl+PageDown after entry: caret at the last line", s && s.caretLine === LINES + 1, `line=${s?.caretLine} want=${LINES + 1}`);
  check("6. …and the view STAYS at the bottom (was rolled back to the saved offset)", nearBottom(s), `scrollTop=${s?.scrollTop} max=${s?.maxScroll}`);

  await key(cdp, "PageDown", { ctrl: true });
  await sleep(1200);
  s = await cmState(cdp);
  check("7. repeat press keeps the bottom", nearBottom(s), `scrollTop=${s?.scrollTop} max=${s?.maxScroll}`);

  await key(cdp, "Escape");
  await enterEditor(cdp);
  await key(cdp, "PageUp", { ctrl: true });
  await sleep(1200);
  s = await cmState(cdp);
  check("8. first Ctrl+PageUp after entry: caret at line 1, view stays at the top", s && s.caretLine === 1 && nearTop(s), `line=${s?.caretLine} scrollTop=${s?.scrollTop}`);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error("FAILED:", failed.map(f => f.name).join("; "));
    process.exitCode = 1;
  }
} finally {
  child.kill();
  await sleep(500);
  restoreCfg();
  rmSync(work, { recursive: true, force: true });
}
