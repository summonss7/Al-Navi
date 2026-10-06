// Dev E2E for alnavi-030: first Ctrl+PageDown right after entering the editor
// was rolled back — the position-restore timers kept re-asserting the saved
// scrollTop (120/300/600ms) over whatever the user just scrolled to, so the
// view "flickered" down to the end and jumped back; the second press (after
// the timers died out) worked. This script verifies against the vite dev
// build with a mocked Tauri backend:
//   - opening a file with a remembered position restores it (caret line +
//     scroll offset) when the user does nothing — the restore stays intact
//   - Ctrl+PageDown pressed right after entering the editor lands the caret
//     at the last line AND keeps the view scrolled to the bottom (the bug:
//     the scroll used to snap back to the saved offset)
//   - a second Ctrl+PageDown keeps the view at the bottom (the old workaround)
//   - symmetric Ctrl+PageUp right after entering jumps to the top and stays
// Usage: node scripts/e2e-alnavi-030-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9258;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-030-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the tall document: fixed-width lines, remembered position in the middle
const LINES = 3000;
const SAVED_LINE = 101; // caret restored here
const SAVED_SCROLL = 1200; // and the view scrolled here
const lineAt = (i) => `line ${String(i + 1).padStart(4, "0")} — the quick brown fox jumps over the lazy dog`;
const LINE_LEN = lineAt(0).length + 1; // + \n
const ANCHOR = (SAVED_LINE - 1) * LINE_LEN;
const TEXT = JSON.stringify(Array.from({ length: LINES }, (_, i) => lineAt(i)).join("\n") + "\n");

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
    await sleep(100);
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

// real Ctrl+PageDown/PageUp key events
const VK = { PageDown: 34, PageUp: 33 };
const MOD = { ctrl: 2 };
async function ctrlPage(cdp, name) {
  const base = { key: name, code: name, windowsVirtualKeyCode: VK[name], modifiers: MOD.ctrl, location: 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

// live scroll geometry + the caret's line number, straight from the active
// EditorView (the active-line element is only rendered when visible)
const cmState = (cdp) => evalIn(cdp, `(() => {
  const sc = document.querySelector(".cm-scroller");
  const v = window.__e2e?.currentView?.();
  if (!sc || !v) return null;
  return {
    scrollTop: sc.scrollTop,
    maxScroll: sc.scrollHeight - sc.clientHeight,
    caretLine: v.state.doc.lineAt(v.state.selection.main.head).number,
  };
})()`);

async function bootstrap(cdp) {
  // reload to reset editor/docs state between scenarios
  await cdp.send("Page.navigate", { url: `${ORIGIN}/?r=${Math.random().toFixed(8)}` });
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell") && !!document.querySelector(".cmdline input")`).catch(() => null), 30000, "app UI");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(cdp, `
    (async () => {
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      window.__TAURI_INTERNALS__.transformCallback = () => ++window.__e2eCbSeq;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen": return Promise.resolve(++window.__e2eCbSeq);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": return Promise.resolve({ path: args.path, entries: [], freeBytes: 0, totalBytes: 0 });
          case "home_path": return Promise.resolve("D:\\\\e2e");
          case "load_json":
            if (args.name === "editor-state.json") {
              return Promise.resolve({ "D:\\\\e2e\\\\tall.txt": { pos: { anchor: ${ANCHOR}, head: ${ANCHOR}, scrollTop: ${SAVED_SCROLL} }, ts: 1 } });
            }
            return Promise.resolve(null);
          case "save_json": return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          case "read_text":
            if (args.path !== "D:\\\\e2e\\\\tall.txt") return Promise.reject(new Error("no such file"));
            return Promise.resolve({ text: ${TEXT}, encoding: "utf-8", bom: false, eol: "lf", size: 900000, truncated: false });
          default: return Promise.resolve(null);
        }
      };
      const imp = new Function("u", "return import(u)");
      const { editor } = await imp("${ORIGIN}/src/lib/stores/editor.svelte.ts");
      // the app's EditorArea imports cm through whatever URL vite serves it
      // under (an HMR edit appends ?t=…, which is a DIFFERENT module instance
      // with its own module-level view) — fetch the transformed component
      // and import cm by the exact URL it uses
      const comp = await (await fetch("${ORIGIN}/src/components/EditorArea.svelte")).text();
      const cmUrl = comp.match(/from "([^"]*\\/lib\\/editor\\/cm\\.ts[^"]*)"/)[1];
      const { currentView } = await imp(new URL(cmUrl, "${ORIGIN}/").href);
      window.__e2e = { editor, currentView };
      await editor.init();
      return true;
    })()
  `);
  await evalIn(cdp, `window.__e2e.editor.open("D:\\\\e2e\\\\tall.txt")`);
  // editor chunk load + component mount + view focus (rAF) — then act FAST:
  // the press must land inside the 600ms window of the restore timers
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".cm-editor") && document.activeElement?.classList?.contains("cm-content") ? true : null`).catch(() => null), 15000, "editor mounted + focused");
}

// "at the very top" — the saved offset (1200 of 62k) must NOT count as top
const nearTop = (s) => s.scrollTop <= 30;
const nearBottom = (s) => s.maxScroll - s.scrollTop <= s.maxScroll * 0.1;

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

  step("scenario 1: no input — remembered position restores and holds");
  await bootstrap(cdp);
  await sleep(1200); // let every restore timer fire
  let s = await cmState(cdp);
  check("tall document mounted (scroll range >> saved)", s && s.maxScroll > SAVED_SCROLL * 5, `maxScroll=${s?.maxScroll}`);
  check("caret restored to the saved line", s && s.caretLine === SAVED_LINE, `caretLine=${s?.caretLine} want=${SAVED_LINE}`);
  check("scroll restored to the saved offset", s && Math.abs(s.scrollTop - SAVED_SCROLL) <= 150, `scrollTop=${s?.scrollTop} want=${SAVED_SCROLL}`);

  step("scenario 2: Ctrl+PageDown right after entering (the bug)");
  await bootstrap(cdp);
  await ctrlPage(cdp, "PageDown");
  await sleep(1000); // all stale restore timers are dead by now
  s = await cmState(cdp);
  // the text ends with \n, so doc end = line LINES+1 (the empty last line)
  check("caret jumped to the last line", s && s.caretLine === LINES + 1, `caretLine=${s?.caretLine} want=${LINES + 1}`);
  check("view STAYS at the bottom (was yanked back to the saved offset)", nearBottom(s), `scrollTop=${s?.scrollTop} max=${s?.maxScroll}`);

  step("scenario 3: second Ctrl+PageDown keeps the bottom (old workaround)");
  await ctrlPage(cdp, "PageDown");
  await sleep(1000);
  s = await cmState(cdp);
  check("still at the bottom after a repeat press", nearBottom(s), `scrollTop=${s?.scrollTop} max=${s?.maxScroll}`);

  step("scenario 4: symmetric Ctrl+PageUp right after entering");
  await bootstrap(cdp);
  await ctrlPage(cdp, "PageUp");
  await sleep(1000);
  s = await cmState(cdp);
  check("caret jumped to the first line", s && s.caretLine === 1, `caretLine=${s?.caretLine}`);
  check("view jumped to the very top and stays", nearTop(s), `scrollTop=${s?.scrollTop}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error("FAILED:", failed.map((f) => f.name).join("; "));
    process.exitCode = 1;
  }
} finally {
  edge.kill();
  if (ours) ours.kill();
}
