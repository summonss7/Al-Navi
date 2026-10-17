// Dev E2E for alnavi-028: Ctrl+"+" / Ctrl+"−" zoom the interface font — the
// same setting the F9 dialog's stepper touches (10..24 px, 0.5 steps). Against
// the vite dev build with a mocked Tauri backend this verifies:
//   - every spelling of the chord works via REAL key events: Ctrl+= (browser
//     convention), Ctrl+Shift+= (a shifted "+"), Ctrl+Gray+/- from the numpad
//     (modifiers used to be dropped there — Ctrl+Gray+ acted as group select)
//   - the store value, the --fs-scale CSS var and the DOM all move together
//   - long sweeps clamp at 24 and 10 px
//   - a toast echoes the resulting size
//   - the chord works with text in the command line (chords always drive the
//     app, unlike the caret keys), in the editor and inside the F9 dialog
//     (whose stepper label follows the change live)
//   - plain Gray+ still opens the select-group dialog (regression: the
//     numpad modifiers split must not swallow the FAR behavior)
//   - settings.json is persisted (debounced) and F1 documents the row
// Usage: node scripts/e2e-alnavi-028-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9258;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-028-"));
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

// real key events: zoom chords with their physical codes, plain keys by name
const VK = { Escape: 27, F1: 112, F9: 120, Equal: 187, Minus: 189, Add: 107, Subtract: 109 };
const MOD = { ctrl: 2, ctrlShift: 2 + 8 };
async function press(cdp, k, mod = 0) {
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers: mod };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(110);
}
async function tap(cdp, name) {
  await press(cdp, { key: name, code: name, vk: VK[name] ?? 0 });
}
const K_EQUAL = { key: "=", code: "Equal", vk: VK.Equal };
const K_PLUS = { key: "+", code: "Equal", vk: VK.Equal }; // Shift+= produces "+"
const K_MINUS = { key: "-", code: "Minus", vk: VK.Minus };
const K_NUM_ADD = { key: "+", code: "NumpadAdd", vk: VK.Add };
const K_NUM_SUB = { key: "-", code: "NumpadSubtract", vk: VK.Subtract };

// live font state: store px value + the CSS var the whole UI scales from
const fontState = (cdp) => evalIn(cdp, `(() => ({
  px: window.__e2e.settings.s.fontSize,
  scale: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fs-scale")),
}))()`);
const near = (v, want, eps = 1e-6) => Math.abs(v - want) <= eps;

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
  // cold vite can take a while — wait for the mounted app, not a fixed sleep
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell") && !!document.querySelector(".cmdline input")`).catch(() => null), 30000, "app UI");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  step("bootstrapping stores + backend mock");
  await evalIn(cdp, `
    (async () => {
      const rows = [];
      for (let i = 1; i <= 10; i++) {
        rows.push({ name: "file" + String(i).padStart(2, "0") + ".txt", isDir: false, size: 100 * i, mtime: 0, attrs: "", isSymlink: false, isHidden: false });
      }
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      window.__e2eSaves = [];
      window.__TAURI_INTERNALS__.transformCallback = () => ++window.__e2eCbSeq;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen": return Promise.resolve(++window.__e2eCbSeq);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": return Promise.resolve({ path: args.path, entries: rows, freeBytes: 0, totalBytes: 0 });
          case "home_path": return Promise.resolve("D:\\\\e2e");
          case "load_json": return Promise.resolve(null);
          case "save_json":
            // args.data can be a Svelte $state proxy — clone it, CDP's
            // returnByValue would otherwise serialize the proxy as {}
            window.__e2eSaves.push({ name: args.name, data: JSON.parse(JSON.stringify(args.data ?? null)) });
            return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          default: return Promise.resolve(null);
        }
      };
      const imp = new Function("u", "return import(u)");
      // full ".svelte.ts" URLs — a bare ".svelte" URL would create a SECOND
      // store instance and the assertions would read a disconnected copy
      const { panels } = await imp("${ORIGIN}/src/lib/stores/panels.svelte.ts");
      const { settings } = await imp("${ORIGIN}/src/lib/stores/settings.svelte.ts");
      const { cmdline } = await imp("${ORIGIN}/src/lib/stores/cmdline.svelte.ts");
      const { editor } = await imp("${ORIGIN}/src/lib/stores/editor.svelte.ts");
      const { ui } = await imp("${ORIGIN}/src/lib/stores/ui.svelte.ts");
      window.__e2e = { panels, settings, cmdline, editor, ui };
      await panels.init();
      return window.__e2e.panels.left.view.length;
    })()
  `);

  step("initial state: default 13.5 px, scale 1");
  let f = await fontState(cdp);
  check("starts at the default 13.5 px", f.px === 13.5, JSON.stringify(f));
  check("--fs-scale is 1", near(f.scale, 1), `scale=${f.scale}`);

  step("Ctrl+= grows by 0.5 px (browser-convention spelling)");
  await press(cdp, K_EQUAL, MOD.ctrl);
  f = await fontState(cdp);
  check("Ctrl+= -> 14.0 px", f.px === 14 && near(f.scale, 14 / 13.5, 1e-3), JSON.stringify(f));

  step("Ctrl+Shift+= (a real '+') grows too");
  await press(cdp, K_PLUS, MOD.ctrlShift);
  f = await fontState(cdp);
  check("Ctrl+Shift+= -> 14.5 px", f.px === 14.5, `px=${f.px}`);

  step("Ctrl+- shrinks");
  await press(cdp, K_MINUS, MOD.ctrl);
  f = await fontState(cdp);
  check("Ctrl+- -> 14.0 px", f.px === 14, `px=${f.px}`);

  step("numpad: Ctrl+Gray+/- (modifiers were dropped before)");
  await press(cdp, K_NUM_ADD, MOD.ctrl);
  f = await fontState(cdp);
  check("Ctrl+Gray+ -> 14.5 px", f.px === 14.5, `px=${f.px}`);
  await press(cdp, K_NUM_SUB, MOD.ctrl);
  f = await fontState(cdp);
  check("Ctrl+Gray- -> 14.0 px", f.px === 14, `px=${f.px}`);

  step("toast echoes the resulting size");
  await press(cdp, K_EQUAL, MOD.ctrl);
  const toast = await evalIn(cdp, `document.querySelector(".toast")?.textContent ?? ""`);
  check("toast shows 'Font size: 14.5 px'", /14\.5\s*px/.test(toast), JSON.stringify(toast));
  await press(cdp, K_MINUS, MOD.ctrl); // back to 14.0

  step("clamps at 24 and 10");
  for (let i = 0; i < 30; i++) await press(cdp, K_EQUAL, MOD.ctrl);
  f = await fontState(cdp);
  check("long Ctrl+= sweep stops at 24 px", f.px === 24 && near(f.scale, 24 / 13.5, 1e-3), JSON.stringify(f));
  for (let i = 0; i < 40; i++) await press(cdp, K_MINUS, MOD.ctrl);
  f = await fontState(cdp);
  check("long Ctrl+- sweep stops at 10 px", f.px === 10, `px=${f.px}`);
  for (let i = 0; i < 8; i++) await press(cdp, K_EQUAL, MOD.ctrl); // back to 14.0

  step("chord keeps working with text in the command line");
  await evalIn(cdp, `window.__e2e.cmdline.setText("alpha beta")`);
  await press(cdp, K_MINUS, MOD.ctrl);
  f = await fontState(cdp);
  const lineText = await evalIn(cdp, `window.__e2e.cmdline.text`);
  check("Ctrl+- zoomed while the line had text", f.px === 13.5 && lineText === "alpha beta", `px=${f.px} line=${JSON.stringify(lineText)}`);
  await tap(cdp, "Escape");
  await press(cdp, K_EQUAL, MOD.ctrl); // back to 14.0

  step("plain Gray+ still opens the select-group dialog (FAR behavior)");
  await press(cdp, K_NUM_ADD, 0);
  const selDlg = await evalIn(cdp, `!!document.querySelector(".overlay input") ? "open" : "none"`);
  check("plain numpad + opened the mask dialog", selDlg === "open", selDlg);
  await tap(cdp, "Escape");
  const closed = await evalIn(cdp, `!document.querySelector(".overlay")`);
  check("Esc closed the mask dialog", closed === true);

  step("editor context: chord works there too");
  await evalIn(cdp, `(() => { window.__e2e.editor.newScratch(); return window.__e2e.ui.mode; })()`);
  await press(cdp, K_EQUAL, MOD.ctrl);
  f = await fontState(cdp);
  check("Ctrl+= in the editor -> 14.5 px", f.px === 14.5, `px=${f.px}`);
  await tap(cdp, "Escape");
  const mode = await evalIn(cdp, `window.__e2e.ui.mode`);
  check("Esc closed the scratch back to panels", mode === "panels", mode);
  await press(cdp, K_MINUS, MOD.ctrl); // back to 14.0

  step("dialog context: F9 stepper follows the live zoom");
  await tap(cdp, "F9");
  await sleep(300);
  let fsVal = await evalIn(cdp, `document.querySelector(".fs-val")?.textContent ?? ""`);
  check("F9 stepper shows 14.0 px", /14\.0/.test(fsVal), JSON.stringify(fsVal));
  await press(cdp, K_EQUAL, MOD.ctrl);
  f = await fontState(cdp);
  fsVal = await evalIn(cdp, `document.querySelector(".fs-val")?.textContent ?? ""`);
  check("Ctrl+= inside the dialog -> 14.5 px, label follows", f.px === 14.5 && /14\.5/.test(fsVal), `px=${f.px} label=${JSON.stringify(fsVal)}`);
  await tap(cdp, "Escape");

  step("persistence: settings.json carries fontSize (debounced)");
  await sleep(700); // settings persist debounce is 300ms
  const saved = await evalIn(cdp, `window.__e2eSaves.filter((s) => s.name === "settings.json").pop() ?? null`);
  check("settings.json saved with fontSize 14.5", saved?.data?.fontSize === 14.5, JSON.stringify(saved?.data?.fontSize ?? null));

  step("F1 help documents the chord");
  await tap(cdp, "F1");
  await sleep(400);
  const help = await evalIn(cdp, `
    (() => {
      const rows = [...document.querySelectorAll(".help-dlg .hrow")];
      const hit = rows.find((r) => r.querySelector("kbd")?.textContent.includes("Ctrl+− / +"));
      return { found: !!hit, desc: hit?.textContent ?? "", rows: rows.length };
    })()
  `);
  check("help row 'Ctrl+− / +' present (96 rows", help.found && help.rows === 96 && /interface font/.test(help.desc),
    `rows=${help.rows} desc=${help.desc.slice(0, 60)}`);
  await tap(cdp, "Escape");

  step("reset to the default size");
  await evalIn(cdp, `window.__e2e.settings.set({ fontSize: 13.5 })`);
  f = await fontState(cdp);
  check("back to 13.5 px", f.px === 13.5 && near(f.scale, 1, 1e-3), JSON.stringify(f));

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
