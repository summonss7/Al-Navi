// Dev E2E for alnavi-031: Ctrl+mouse wheel zooms the interface font,
// browser-style — the same stepper/toast/persistence as the Ctrl+± chords
// (alnavi-028). Against the vite dev build with a mocked Tauri backend this
// verifies with REAL trusted wheel events (CDP Input.dispatchMouseEvent):
//   - Ctrl+wheel up grows by 0.5 px, Ctrl+wheel down shrinks (Chrome mapping)
//   - sub-threshold deltas accumulate: two −50 drabs = one step (trackpad
//     pinches arrive as many small ctrl-wheel deltas); a lone −30 does nothing
//   - a direction change drops the accumulated residue of the opposite sign
//   - plain wheel (no Ctrl) neither zooms nor breaks the native scroll of the
//     panel list (capture listener must stay transparent for non-ctrl wheels)
//   - long sweeps clamp at 24 and 10 px; a toast echoes the resulting size
//   - works over the editor and inside the F9 dialog (stepper label follows)
//   - settings.json is persisted (debounced) and the F1 row now lists
//     Ctrl+Wheel next to Ctrl+− / + (still 92 rows)
//   - devicePixelRatio stays 1 — the page zoom default action is prevented
// Usage: node scripts/e2e-alnavi-031-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9259;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-031-"));
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

// CDP mouse modifiers: Alt=1, Ctrl=2, Meta=4, Shift=8
async function wheel(cdp, deltaY, { ctrl = true, x = 640, y = 400 } = {}) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel", x, y, deltaX: 0, deltaY,
    modifiers: ctrl ? 2 : 0,
  });
  await sleep(70);
}

// live font state: store px value + the CSS var the whole UI scales from
const fontState = (cdp) => evalIn(cdp, `(() => ({
  px: window.__e2e.settings.s.fontSize,
  scale: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fs-scale")),
}))()`);
const near = (v, want, eps = 1e-6) => Math.abs(v - want) <= eps;

// real key events for the dialog/editor hops
const VK = { Escape: 27, F1: 112, F9: 120 };
async function tap(cdp, name) {
  const base = { key: name, code: name, windowsVirtualKeyCode: VK[name] ?? 0, modifiers: 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(110);
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

  step("navigating");
  await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  // cold vite can take a while — wait for the mounted app, not a fixed sleep
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell") && !!document.querySelector(".cmdline input")`).catch(() => null), 30000, "app UI");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  step("bootstrapping stores + backend mock (150 files to make the list scrollable)");
  await evalIn(cdp, `
    (async () => {
      const rows = [];
      for (let i = 1; i <= 150; i++) {
        rows.push({ name: "file" + String(i).padStart(3, "0") + ".txt", isDir: false, size: 100 * i, mtime: 0, attrs: "", isSymlink: false, isHidden: false });
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
      // probe: record every wheel seen in the BUBBLE phase on window (after
      // all capture listeners): defaultPrevented tells who cancelled the
      // default action — ctrl wheels must be cancelled (page-zoom off), plain
      // wheels must stay native (the panel list keeps its scroll). Headless
      // chromium doesn't APPLY compositor scrolls in this layout, so the
      // defaultPrevented flag is the observable here, not scrollTop.
      window.__wheels = [];
      window.addEventListener("wheel", (e) => {
        window.__wheels.push({ ctrl: e.ctrlKey, prevented: e.defaultPrevented });
      }, { capture: false, passive: true });
      return window.__e2e.panels.left.view.length;
    })()
  `);

  step("initial state: default 13.5 px, scale 1");
  let f = await fontState(cdp);
  check("starts at the default 13.5 px", f.px === 13.5, JSON.stringify(f));
  check("--fs-scale is 1", near(f.scale, 1), `scale=${f.scale}`);

  step("Ctrl+wheel up grows by 0.5 px, Ctrl+wheel down shrinks");
  await wheel(cdp, -100); // up = zoom in (Chrome mapping)
  f = await fontState(cdp);
  check("ctrl+wheel up -> 14.0 px", f.px === 14 && near(f.scale, 14 / 13.5, 1e-3), JSON.stringify(f));
  const ctrlWheels = await evalIn(cdp, `window.__wheels.filter((w) => w.ctrl)`);
  check("ctrl wheel default action cancelled (page zoom suppressed)", ctrlWheels.length >= 1 && ctrlWheels.every((w) => w.prevented), JSON.stringify(ctrlWheels.slice(0, 2)));
  await wheel(cdp, 100); // down = zoom out
  f = await fontState(cdp);
  check("ctrl+wheel down -> 13.5 px", f.px === 13.5, `px=${f.px}`);

  step("accumulation: two −50 drabs = one step, a lone −30 is sub-threshold");
  await wheel(cdp, -50);
  f = await fontState(cdp);
  check("first −50 drab does not step yet", f.px === 13.5, `px=${f.px}`);
  await wheel(cdp, -50);
  f = await fontState(cdp);
  check("second −50 completes the step -> 14.0 px", f.px === 14, `px=${f.px}`);
  await wheel(cdp, -30);
  f = await fontState(cdp);
  check("lone −30 stays below the threshold (14.0 px)", f.px === 14, `px=${f.px}`);
  await wheel(cdp, 100); // drain the −30 residue with a full step down
  f = await fontState(cdp);
  check("wheel down after residue -> 13.5 px", f.px === 13.5, `px=${f.px}`);

  step("direction change drops the opposite residue");
  await wheel(cdp, 60); // +60 accumulated, no step
  await wheel(cdp, -100); // opposite sign: reset then a full −100 -> one step up
  f = await fontState(cdp);
  check("+60 then −100 -> one step up (14.0 px), not cancelled out", f.px === 14, `px=${f.px}`);

  step("plain wheel (no Ctrl) stays native and does not zoom");
  await evalIn(cdp, `window.__wheels.length = 0`);
  for (let i = 0; i < 3; i++) await wheel(cdp, 100, { ctrl: false, x: 300, y: 300 });
  f = await fontState(cdp);
  const plain = await evalIn(cdp, `window.__wheels.filter((w) => !w.ctrl)`);
  check("plain wheel did not zoom", f.px === 14, `px=${f.px}`);
  check("plain wheel left the default action live (scroll keeps working)", plain.length === 3 && plain.every((w) => !w.prevented), JSON.stringify(plain));

  step("clamps at 24 and 10");
  for (let i = 0; i < 30; i++) await wheel(cdp, -100);
  f = await fontState(cdp);
  check("long ctrl+wheel-up sweep stops at 24 px", f.px === 24 && near(f.scale, 24 / 13.5, 1e-3), JSON.stringify(f));
  for (let i = 0; i < 45; i++) await wheel(cdp, 100);
  f = await fontState(cdp);
  check("long ctrl+wheel-down sweep stops at 10 px", f.px === 10, `px=${f.px}`);
  for (let i = 0; i < 7; i++) await wheel(cdp, -100); // back to 13.5

  step("toast echoes the resulting size");
  await wheel(cdp, -100);
  const toast = await evalIn(cdp, `document.querySelector(".toast")?.textContent ?? ""`);
  check("toast shows 'Font size: 14.0 px'", /14\.0\s*px/.test(toast), JSON.stringify(toast));
  await wheel(cdp, 100); // back to 13.5

  step("editor context: zoom works over CodeMirror, plain wheel doesn't zoom");
  await evalIn(cdp, `(() => { window.__e2e.editor.newScratch(); return window.__e2e.ui.mode; })()`);
  await sleep(300);
  await wheel(cdp, 100, { ctrl: false, x: 640, y: 400 });
  f = await fontState(cdp);
  check("plain wheel in the editor did not zoom", f.px === 13.5, `px=${f.px}`);
  await wheel(cdp, -100, { x: 640, y: 400 });
  f = await fontState(cdp);
  check("ctrl+wheel over the editor -> 14.0 px", f.px === 14, `px=${f.px}`);
  await tap(cdp, "Escape");
  const mode = await evalIn(cdp, `window.__e2e.ui.mode`);
  check("Esc closed the scratch back to panels", mode === "panels", mode);
  await wheel(cdp, 100); // back to 13.5

  step("dialog context: F9 stepper follows the live zoom");
  await tap(cdp, "F9");
  await sleep(300);
  let fsVal = await evalIn(cdp, `document.querySelector(".fs-val")?.textContent ?? ""`);
  check("F9 stepper shows 13.5 px", /13\.5/.test(fsVal), JSON.stringify(fsVal));
  await wheel(cdp, -100);
  f = await fontState(cdp);
  fsVal = await evalIn(cdp, `document.querySelector(".fs-val")?.textContent ?? ""`);
  check("ctrl+wheel inside the dialog -> 14.0 px, label follows", f.px === 14 && /14\.0/.test(fsVal), `px=${f.px} label=${JSON.stringify(fsVal)}`);
  await tap(cdp, "Escape");

  step("page zoom suppressed: devicePixelRatio stays 1 through a sweep");
  const dpr = await evalIn(cdp, `window.devicePixelRatio`);
  await wheel(cdp, -100);
  await wheel(cdp, 100);
  const dpr2 = await evalIn(cdp, `window.devicePixelRatio`);
  check("devicePixelRatio unchanged by ctrl+wheel", dpr === dpr2 && dpr === 1, `dpr=${dpr}->${dpr2}`);

  step("persistence: settings.json carries fontSize (debounced)");
  await sleep(700); // settings persist debounce is 300ms
  const saved = await evalIn(cdp, `window.__e2eSaves.filter((s) => s.name === "settings.json").pop() ?? null`);
  check("settings.json saved with fontSize 14", saved?.data?.fontSize === 14, JSON.stringify(saved?.data?.fontSize ?? null));

  step("F1 help documents the wheel next to the chords");
  await tap(cdp, "F1");
  await sleep(400);
  const help = await evalIn(cdp, `
    (() => {
      const rows = [...document.querySelectorAll(".help-dlg .hrow")];
      const hit = rows.find((r) => r.querySelector("kbd")?.textContent.includes("Ctrl+− / +"));
      return { found: !!hit, kbd: hit?.querySelector("kbd")?.textContent ?? "", desc: hit?.textContent ?? "", rows: rows.length };
    })()
  `);
  check("help row lists Ctrl+− / + · Ctrl+Wheel (92 rows)", help.found && help.rows === 92 && /Ctrl\+Wheel/.test(help.kbd) && /interface font/.test(help.desc),
    `rows=${help.rows} kbd=${JSON.stringify(help.kbd)}`);
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
