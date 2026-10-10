// Dev E2E for alnavi-032: the bottom F-key hint bar reacts to modifier PAIRS.
// Single modifiers already swapped the bar (Ctrl/Alt/Shift rows); now holding
// two modifiers shows a pair-specific row: Ctrl+Shift lists the chords that
// need both keys (newScratch F4, copyPaths Ins in panels, prevTab, pin 0…9,
// layout L in the editor), Alt+Shift lists the panel history arrows. Pairs
// with no chords (Ctrl+Alt) fall back to the Ctrl row, and modes with no pair
// chords fall through (editor Alt+Shift -> the Shift row). This script drives
// the vite dev build with a mocked Tauri backend and REAL key events
// (Input.dispatchKeyEvent: Control/Shift/Alt keyDown…keyUp held down):
//   - plain bar: F1..F12, no chips
//   - Ctrl row: all chords start with Ctrl+, and the pair chord Ctrl+Shift+Ins
//     is GONE from it (moved to the pair row in this change)
//   - Ctrl+Shift pair row in panels: exact chip set, pin chip info-only (dim)
//   - releasing Shift restores the Ctrl row; Ctrl+Alt stays on the Ctrl row
//   - releasing everything restores the plain F bar
//   - Alt row, then Alt+Shift pair row: exact chips, then clean release
//   - the real Ctrl+Shift+F4 chord opens the scratchpad editor
//   - editor Ctrl+Shift row: F4/L/Tab, no panels-only chips
//   - editor Alt+Shift row: column-selection chips (alnavi-034 — used to
//     fall through to the Shift row before the editor got its own pair row)
//   - locale ru translates the pair-row labels (черновик), no raw keys leak
// Usage: node scripts/e2e-alnavi-032-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9259;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-032-"));
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

// modifier hold/release via REAL key events; the bar tracks e.key on window
const VK = { Control: 17, Shift: 16, Alt: 18, F4: 115 };
const MODBIT = { Control: 2, Shift: 8, Alt: 1 };
async function holdMods(cdp, mods) {
  let bits = 0;
  for (const m of mods) {
    await cdp.send("Input.dispatchKeyEvent", { key: m, code: m, windowsVirtualKeyCode: VK[m], location: 1, modifiers: bits, type: "keyDown" });
    bits |= MODBIT[m];
    await sleep(80);
  }
  await sleep(150);
}
async function releaseMods(cdp, mods) {
  // release in reverse; bits start from ALL mods currently down
  let bits = mods.reduce((b, m) => b | MODBIT[m], 0);
  for (const m of [...mods].reverse()) {
    bits &= ~MODBIT[m];
    await cdp.send("Input.dispatchKeyEvent", { key: m, code: m, windowsVirtualKeyCode: VK[m], location: 1, modifiers: bits, type: "keyUp" });
    await sleep(80);
  }
  await sleep(150);
}
async function chord(cdp, mods, key) {
  await holdMods(cdp, mods);
  const bits = mods.reduce((b, m) => b | MODBIT[m], 0);
  await cdp.send("Input.dispatchKeyEvent", { key, code: key, windowsVirtualKeyCode: VK[key], modifiers: bits, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { key, code: key, windowsVirtualKeyCode: VK[key], modifiers: bits, type: "keyUp" });
  await sleep(150);
  await releaseMods(cdp, mods);
}
const barOf = `(() => [...document.querySelectorAll("footer.fkeys .fkey")].map((b) => ({
  kbd: b.querySelector("kbd").textContent,
  label: b.querySelector(".lbl")?.textContent ?? "",
  chip: b.classList.contains("chip"),
  dim: b.classList.contains("dim"),
  disabled: b.disabled,
})))()`;

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
  await sleep(2500);
  // headless pages start without renderer focus; the flag must be set AFTER
  // the navigation (a new document resets it)
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
      window.__TAURI_INTERNALS__.transformCallback = () => ++window.__e2eCbSeq;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen": return Promise.resolve(++window.__e2eCbSeq);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": return Promise.resolve({ path: args.path, entries: rows, freeBytes: 0, totalBytes: 0 });
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
      // full ".svelte.ts" URLs — a bare ".svelte" URL would create a SECOND
      // store instance and the assertions would read a disconnected copy
      const { panels } = await imp("${ORIGIN}/src/lib/stores/panels.svelte.ts");
      const { ui } = await imp("${ORIGIN}/src/lib/stores/ui.svelte.ts");
      const { settings } = await imp("${ORIGIN}/src/lib/stores/settings.svelte.ts");
      window.__e2e = { panels, ui, settings };
      await panels.init();
      return window.__e2e.panels.left.view.length;
    })()
  `);

  step("plain bar: F1..F12, no chips");
  let bar = await evalIn(cdp, barOf);
  check("plain F bar (12 keys F1..F12)", bar.length === 12 && bar[0].kbd === "F1" && bar[11].kbd === "F12" && bar.every((b) => !b.chip),
    `n=${bar.length} first=${bar[0]?.kbd} last=${bar[11]?.kbd}`);

  step("hold Ctrl -> Ctrl row, pair chord evicted from it");
  await holdMods(cdp, ["Control"]);
  bar = await evalIn(cdp, barOf);
  check("Ctrl row: chips, all Ctrl+ chords", bar.length > 0 && bar.every((b) => b.chip && b.kbd.startsWith("Ctrl+") && !b.kbd.startsWith("Ctrl+Shift")),
    `n=${bar.length} kbds=${bar.map((b) => b.kbd).slice(0, 6).join(",")}…`);
  check("Ctrl row no longer lists Ctrl+Shift+Ins (moved to the pair row)", !bar.some((b) => b.kbd === "Ctrl+Shift+Ins"),
    bar.some((b) => b.kbd === "Ctrl+Shift+Ins") ? "still there" : "gone");

  step("add Shift -> the Ctrl+Shift pair row (panels)");
  await holdMods(cdp, ["Shift"]);
  bar = await evalIn(cdp, barOf);
  const pairKbds = bar.map((b) => b.kbd);
  const wantPair = ["Ctrl+Shift+F4", "Ctrl+Shift+Ins", "Ctrl+Shift+Tab", "Ctrl+Shift+0…9"];
  check("Ctrl+Shift pair row: exact chip set", JSON.stringify(pairKbds) === JSON.stringify(wantPair), JSON.stringify(pairKbds));
  const pin = bar.find((b) => b.kbd === "Ctrl+Shift+0…9");
  check("pin chip is info-only (dim + disabled), others run commands", !!pin && pin.dim && pin.disabled && bar.filter((b) => b.disabled).length === 1,
    `pin=${JSON.stringify(pin)}`);

  step("release Shift -> back to the Ctrl row");
  await releaseMods(cdp, ["Shift"]);
  bar = await evalIn(cdp, barOf);
  check("back to the Ctrl row", bar.every((b) => b.kbd.startsWith("Ctrl+") && !b.kbd.startsWith("Ctrl+Shift")) && bar.some((b) => b.kbd === "Ctrl+O"),
    bar.map((b) => b.kbd).slice(0, 4).join(","));

  step("Ctrl+Alt (no chords) stays on the Ctrl row");
  await holdMods(cdp, ["Alt"]);
  bar = await evalIn(cdp, barOf);
  check("Ctrl+Alt falls back to the Ctrl row", bar.every((b) => b.kbd.startsWith("Ctrl+")) && !bar.some((b) => b.kbd.startsWith("Alt")),
    bar.map((b) => b.kbd).slice(0, 3).join(","));
  await releaseMods(cdp, ["Alt", "Control"]);

  step("everything released -> plain F bar again");
  bar = await evalIn(cdp, barOf);
  check("plain F bar restored", bar.length === 12 && bar.every((b) => !b.chip) && bar[0].kbd === "F1",
    `n=${bar.length} first=${bar[0]?.kbd}`);

  step("Alt row, then Alt+Shift pair row");
  await holdMods(cdp, ["Alt"]);
  bar = await evalIn(cdp, barOf);
  check("Alt row: Alt+ chords", bar.length > 0 && bar.every((b) => b.kbd.startsWith("Alt+")) && bar.some((b) => b.kbd === "Alt+F1"),
    `n=${bar.length}`);
  await holdMods(cdp, ["Shift"]);
  bar = await evalIn(cdp, barOf);
  check("Alt+Shift pair row: exact chips", JSON.stringify(bar.map((b) => b.kbd)) === JSON.stringify(["Alt+Shift+←", "Alt+Shift+→"]),
    JSON.stringify(bar.map((b) => b.kbd)));
  await releaseMods(cdp, ["Shift", "Alt"]);
  bar = await evalIn(cdp, barOf);
  check("released -> plain F bar", bar.length === 12 && bar[0].kbd === "F1", `n=${bar.length}`);

  step("the real Ctrl+Shift+F4 chord opens the scratchpad");
  await chord(cdp, ["Control", "Shift"], "F4");
  const mode = await evalIn(cdp, `window.__e2e.ui.mode`);
  check("scratch editor opened by the real chord", mode === "editor", `mode=${mode}`);
  bar = await evalIn(cdp, barOf);
  check("plain F bar in the editor after the chord", bar.length === 12 && bar[0].kbd === "F1" && bar.every((b) => !b.chip), `n=${bar.length}`);

  step("editor: Ctrl+Shift row has F4/L/Tab, no panels-only chips");
  await holdMods(cdp, ["Control", "Shift"]);
  bar = await evalIn(cdp, barOf);
  check("editor Ctrl+Shift row: exact chip set", JSON.stringify(bar.map((b) => b.kbd)) === JSON.stringify(["Ctrl+Shift+F4", "Ctrl+Shift+L", "Ctrl+Shift+Tab"]),
    JSON.stringify(bar.map((b) => b.kbd)));

  step("editor: Alt+Shift pair row shows the column-selection chips (alnavi-034)");
  await releaseMods(cdp, ["Control"]);
  await holdMods(cdp, ["Alt"]);
  bar = await evalIn(cdp, barOf);
  check("editor Alt+Shift row: column chips, info-only", JSON.stringify(bar.map((b) => b.kbd)) === JSON.stringify(["Alt+Shift+↑↓←→", "Alt+Shift+Home/End", "Alt+Shift+PgUp/PgDn"]) && bar.every((b) => b.dim),
    JSON.stringify(bar.map((b) => b.kbd)));
  await releaseMods(cdp, ["Alt", "Shift"]);

  step("chip click runs the pair command");
  await holdMods(cdp, ["Control", "Shift"]);
  // scratch is already open; clicking its chip must keep the editor focused
  const clicked = await evalIn(cdp, `
    (() => {
      const chip = [...document.querySelectorAll("footer.fkeys .fkey")].find((b) => b.querySelector("kbd").textContent === "Ctrl+Shift+L");
      if (!chip) return false;
      chip.click();
      return true;
    })()
  `);
  await sleep(400);
  const afterClick = await evalIn(cdp, `window.__e2e.ui.mode`);
  check("chip click did not break the mode (editor stays)", clicked === true && afterClick === "editor", `clicked=${clicked} mode=${afterClick}`);
  await releaseMods(cdp, ["Control", "Shift"]);

  step("locale ru translates the pair-row labels");
  await evalIn(cdp, `window.__e2e.settings.set({ locale: "ru" })`);
  await sleep(300);
  await holdMods(cdp, ["Control", "Shift"]);
  bar = await evalIn(cdp, barOf);
  check("ru: pair labels translated (черновик/раскладка/пред. вкладка — editor row)",
    bar.map((b) => b.label).join("|") === "черновик|раскладка|пред. вкладка",
    bar.map((b) => b.label).join("|"));
  check("ru: no raw i18n keys leak into the bar", !bar.some((b) => /^(hint|help|fkeys)\./.test(b.label) || /^(hint|help|fkeys)\./.test(b.kbd)),
    JSON.stringify(bar.filter((b) => /^(hint|help|fkeys)\./.test(b.label))));
  await releaseMods(cdp, ["Control", "Shift"]);
  await evalIn(cdp, `window.__e2e.settings.set({ locale: "en" })`);

  step("Esc closes the scratch -> panels");
  await cdp.send("Input.dispatchKeyEvent", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, type: "keyUp" });
  await sleep(300);
  const mode2 = await evalIn(cdp, `window.__e2e.ui.mode`);
  check("Esc closed the scratch back to panels", mode2 === "panels", `mode=${mode2}`);

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
