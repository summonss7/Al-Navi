// Dev E2E for alnavi-027: FAR-style panel split resize via Ctrl+Left/Right.
// Ctrl+Right widens the left panel and shrinks the right one, Ctrl+Left the
// other way (step 2% of the panels row, clamped 20%..80%). This script
// verifies against the vite dev build with a mocked Tauri backend:
//   - both panels start 50/50 (splitRatio 0.5)
//   - real Ctrl+arrow key events (Input.dispatchKeyEvent) move the split in
//     the DOM exactly by the store ratio
//   - the clamp holds at 0.2 / 0.8 over long sweeps
//   - with text in the command line the chords stay the input's word jump:
//     panels don't resize, the caret moves (alnavi-024 regression)
//   - Esc clears the line and the chords resize again
//   - with a single visible panel the split does not move (guard)
//   - the debounced session save carries splitRatio, and a panels.init()
//     replay with the saved session restores the ratio
//   - F1 help shows the new row in the panels section
// Usage: node scripts/e2e-alnavi-027-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9257;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-027-"));
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

// real key events: plain keys by name, arrows with a Ctrl modifier
const VK = { Escape: 27, F1: 112, F2: 113, ArrowLeft: 37, ArrowRight: 39 };
const MOD = { ctrl: 2 };
async function tap(cdp, name) {
  const base = { key: name, code: name, windowsVirtualKeyCode: VK[name] ?? 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(120);
}
async function ctrlArrow(cdp, name) {
  const base = { key: name, code: name, windowsVirtualKeyCode: VK[name], modifiers: MOD.ctrl, location: 0 };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(90);
}
// measured left share of the combined panel width (DOM) and the store ratio
const domRatio = (cdp) => evalIn(cdp, `(() => {
  const w = [...document.querySelectorAll(".panel")].map((p) => p.getBoundingClientRect().width);
  return w.length === 2 ? w[0] / (w[0] + w[1]) : null;
})()`);
const near = (v, want, eps = 0.02) => Math.abs(v - want) <= eps;

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

  step("navigating");
  await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  // cold vite can take a while to compile the module graph — wait for the
  // mounted app, not a fixed sleep (same flake as alnavi-026 on first run)
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell") && !!document.querySelector(".cmdline input")`).catch(() => null), 30000, "app UI");
  // headless pages start without renderer focus; the flag must be set AFTER
  // the navigation (a new document resets it)
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  step("bootstrapping stores + backend mock");
  await evalIn(cdp, `
    (async () => {
      const rows = [];
      for (let i = 1; i <= 10; i++) {
        rows.push({ name: "verylongfilename" + String(i).padStart(2, "0") + ".txt", isDir: false, size: 100 * i, mtime: 0, attrs: "", isSymlink: false, isHidden: false });
      }
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      window.__e2eSaves = [];
      window.__e2eSession = null; // what load_json answers on the next init()
      window.__TAURI_INTERNALS__.transformCallback = () => ++window.__e2eCbSeq;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen": return Promise.resolve(++window.__e2eCbSeq);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": return Promise.resolve({ path: args.path, entries: rows, freeBytes: 0, totalBytes: 0 });
          case "home_path": return Promise.resolve("D:\\\\e2e");
          case "load_json": return Promise.resolve(args.name === "session.json" ? window.__e2eSession : null);
          case "save_json":
            window.__e2eSaves.push({ name: args.name, data: args.data });
            return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          default: return Promise.resolve(null);
        }
      };
      const imp = new Function("u", "return import(u)");
      // full ".svelte.ts" URLs — a bare ".svelte" URL would create a SECOND
      // store instance and the assertions would read a disconnected copy
      const { panels } = await imp("${ORIGIN}/src/lib/stores/panels.svelte.ts");
      const { cmdline } = await imp("${ORIGIN}/src/lib/stores/cmdline.svelte.ts");
      window.__e2e = { panels, cmdline };
      await panels.init();
      return window.__e2e.panels.left.view.length;
    })()
  `);

  step("initial state: two equal panels");
  let ratio = await domRatio(cdp);
  check("two panels render ~50/50", ratio !== null && near(ratio, 0.5), `dom=${ratio}`);
  let store = await evalIn(cdp, `window.__e2e.panels.splitRatio`);
  check("store splitRatio starts at 0.5", store === 0.5, `store=${store}`);

  step("Ctrl+Right widens the left panel");
  for (let i = 0; i < 5; i++) await ctrlArrow(cdp, "ArrowRight");
  store = await evalIn(cdp, `window.__e2e.panels.splitRatio`);
  ratio = await domRatio(cdp);
  check("5x Ctrl+Right -> ratio 0.6 in the store", near(store, 0.6, 1e-9), `store=${store}`);
  check("DOM widths follow (left wider)", near(ratio, 0.6), `dom=${ratio}`);

  step("Ctrl+Left shrinks it back and past the middle");
  for (let i = 0; i < 10; i++) await ctrlArrow(cdp, "ArrowLeft");
  store = await evalIn(cdp, `window.__e2e.panels.splitRatio`);
  ratio = await domRatio(cdp);
  check("10x Ctrl+Left -> ratio 0.4, right panel wider", near(store, 0.4, 1e-9) && near(ratio, 0.4), `store=${store} dom=${ratio}`);

  step("clamps at 0.2 and 0.8");
  for (let i = 0; i < 40; i++) await ctrlArrow(cdp, "ArrowLeft");
  store = await evalIn(cdp, `window.__e2e.panels.splitRatio`);
  ratio = await domRatio(cdp);
  check("long Ctrl+Left sweep stops at 0.2", near(store, 0.2, 1e-9) && near(ratio, 0.2), `store=${store} dom=${ratio}`);
  for (let i = 0; i < 50; i++) await ctrlArrow(cdp, "ArrowRight");
  store = await evalIn(cdp, `window.__e2e.panels.splitRatio`);
  ratio = await domRatio(cdp);
  check("long Ctrl+Right sweep stops at 0.8", near(store, 0.8, 1e-9) && near(ratio, 0.8), `store=${store} dom=${ratio}`);

  step("text in the command line keeps Ctrl+arrows as word jump");
  await evalIn(cdp, `window.__e2e.cmdline.setText("alpha beta gamma")`);
  await evalIn(cdp, `window.__e2e.cmdline.el.setSelectionRange(0, 0)`);
  await sleep(150);
  for (let i = 0; i < 5; i++) await ctrlArrow(cdp, "ArrowRight");
  store = await evalIn(cdp, `window.__e2e.panels.splitRatio`);
  ratio = await domRatio(cdp);
  const caret = await evalIn(cdp, `document.querySelector(".cmdline input").selectionStart`);
  check("panels did not resize while typing", near(store, 0.8, 1e-9) && near(ratio, 0.8), `store=${store} dom=${ratio}`);
  check("caret word-jumped in the input", typeof caret === "number" && caret > 0, `selectionStart=${caret}`);
  await tap(cdp, "Escape");
  const text = await evalIn(cdp, `window.__e2e.cmdline.text`);
  check("Esc cleared the line", text === "", JSON.stringify(text));
  for (let i = 0; i < 5; i++) await ctrlArrow(cdp, "ArrowLeft");
  store = await evalIn(cdp, `window.__e2e.panels.splitRatio`);
  ratio = await domRatio(cdp);
  check("empty line: chords resize again", near(store, 0.7, 1e-9) && near(ratio, 0.7), `store=${store} dom=${ratio}`);

  step("single visible panel: the split does not move");
  await evalIn(cdp, `
    (() => {
      // hide the right panel through the store (same path as the Ctrl+F2 command)
      window.__e2e.panels.toggleSide("right");
      return window.__e2e.panels.showRight;
    })()
  `);
  const nPanels = await evalIn(cdp, `document.querySelectorAll(".panel").length`);
  check("right panel hidden, left full width", nPanels === 1, `panels=${nPanels}`);
  for (let i = 0; i < 10; i++) await ctrlArrow(cdp, "ArrowRight");
  await evalIn(cdp, `window.__e2e.panels.toggleSide("right")`);
  store = await evalIn(cdp, `window.__e2e.panels.splitRatio`);
  ratio = await domRatio(cdp);
  check("split ratio untouched in one-panel mode", near(store, 0.7, 1e-9) && near(ratio, 0.7), `store=${store} dom=${ratio}`);

  step("persistence: debounced save + restore through init()");
  await sleep(1400); // scheduleSessionSave debounce is 1s
  const saved = await evalIn(cdp, `window.__e2eSaves.filter((s) => s.name === "session.json").pop() ?? null`);
  check("session.json saved with splitRatio", !!saved && near(saved.data?.splitRatio ?? -1, 0.7, 1e-9),
    JSON.stringify(saved?.data ?? null));
  // inject the captured session into the mock, then re-run init() on the same
  // store instance — init() must pick splitRatio up and the DOM must follow
  await evalIn(cdp, `window.__e2eSession = ${JSON.stringify(saved ? saved.data : null)}`);
  await evalIn(cdp, `window.__e2e.panels.init()`);
  await sleep(400);
  store = await evalIn(cdp, `window.__e2e.panels.splitRatio`);
  ratio = await domRatio(cdp);
  check("init() restores the saved ratio", near(store, 0.7, 1e-9) && near(ratio, 0.7), `store=${store} dom=${ratio}`);

  step("F1 help documents the chord");
  await tap(cdp, "F1");
  await sleep(400);
  const help = await evalIn(cdp, `
    (() => {
      const rows = [...document.querySelectorAll(".help-dlg .hrow")];
      const hit = rows.find((r) => r.querySelector("kbd")?.textContent.includes("Ctrl+← / →"));
      return { found: !!hit, desc: hit?.textContent ?? "", rows: rows.length };
    })()
  `);
  check("help row 'Ctrl+← / →' present (95 rows, +font zoom)", help.found && help.rows === 95 && /Slide the split/.test(help.desc),
    `rows=${help.rows} desc=${help.desc.slice(0, 60)}`);
  await tap(cdp, "Escape");

  step("reset to equal panels");
  await evalIn(cdp, `window.__e2e.panels.splitRatio = 0.5`);
  await sleep(300);
  ratio = await domRatio(cdp);
  check("back to ~50/50", near(ratio, 0.5), `dom=${ratio}`);

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
