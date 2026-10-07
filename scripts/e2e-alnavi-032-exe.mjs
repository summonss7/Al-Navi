// Exe-level E2E for alnavi-032: in the REAL released exe (1.13.0) the bottom
// F-key hint bar reacts to PAIRS of held modifiers. Real key events via CDP
// (Control/Shift/Alt keyDown held, then keyUp) against the real backend:
//   - plain bar F1..F12; Ctrl row has no Ctrl+Shift+Ins anymore
//   - Ctrl+Shift pair row in panels: exact chips, pin chip info-only
//   - Ctrl+Alt stays on the Ctrl row; full release restores the F bar
//   - Alt row, Alt+Shift pair row, clean release
//   - the real Ctrl+Shift+F4 chord opens the in-memory scratchpad editor
//   - editor pair row: F4 / L / Tab; editor Alt+Shift falls back to Shift row
//   - Esc returns to the panels
// Usage: node scripts/e2e-alnavi-032-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.13.0";
const CFG = join(process.env.APPDATA, "al-navi");
const CDP_PORT = 9266;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// the run must not dirty the real config (locale etc.) — backup / restore
const backedUp = [];
for (const f of (existsSync(CFG) ? readdirSync(CFG) : [])) {
  if (f.endsWith(".e2e-bak")) continue;
  const p = join(CFG, f);
  cpSync(p, p + ".e2e-bak", { recursive: true });
  backedUp.push(p);
}
function restoreCfg() {
  for (let i = 0; i < 3; i++) {
    try {
      for (const p of backedUp) cpSync(p + ".e2e-bak", p, { recursive: true });
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
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result?.exceptionDetails).slice(0, 400));
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

// modifier hold/release via REAL key events (the bar tracks e.key on window)
const VK = { Control: 17, Shift: 16, Alt: 18, F4: 115, Escape: 27 };
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
  let bits = mods.reduce((b, m) => b | MODBIT[m], 0);
  for (const m of [...mods].reverse()) {
    bits &= ~MODBIT[m];
    await cdp.send("Input.dispatchKeyEvent", { key: m, code: m, windowsVirtualKeyCode: VK[m], location: 1, modifiers: bits, type: "keyUp" });
    await sleep(80);
  }
  await sleep(150);
}
const barOf = `(() => [...document.querySelectorAll("footer.fkeys .fkey")].map((b) => ({
  kbd: b.querySelector("kbd").textContent,
  chip: b.classList.contains("chip"),
  dim: b.classList.contains("dim"),
  disabled: b.disabled,
})))()`;

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: mkdtempSync(join(tmpdir(), "alnavi-032-exe-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "ignore",
});
try {
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
  await evalIn(cdp, `document.querySelector(".cmdline input")?.focus(); true`);

  const ver = await evalIn(cdp, `(document.querySelector(".version")?.textContent ?? "").trim()`);
  check("2. title bar chip carries v" + VERSION_PIN, ver.includes(VERSION_PIN), ver);

  let bar = await evalIn(cdp, barOf);
  check("3. plain F bar (12 keys F1..F12)", bar.length === 12 && bar[0].kbd === "F1" && bar[11].kbd === "F12" && bar.every((b) => !b.chip),
    `n=${bar.length} first=${bar[0]?.kbd} last=${bar[11]?.kbd}`);

  await holdMods(cdp, ["Control"]);
  bar = await evalIn(cdp, barOf);
  check("4. Ctrl row: chips, single-modifier chords only", bar.length > 0 && bar.every((b) => b.chip && b.kbd.startsWith("Ctrl+") && !b.kbd.startsWith("Ctrl+Shift")) && !bar.some((b) => b.kbd === "Ctrl+Shift+Ins"),
    `n=${bar.length} kbds=${bar.map((b) => b.kbd).slice(0, 4).join(",")}…`);

  await holdMods(cdp, ["Shift"]);
  bar = await evalIn(cdp, barOf);
  check("5. Ctrl+Shift pair row: exact chip set", JSON.stringify(bar.map((b) => b.kbd)) === JSON.stringify(["Ctrl+Shift+F4", "Ctrl+Shift+Ins", "Ctrl+Shift+Tab", "Ctrl+Shift+0…9"]),
    JSON.stringify(bar.map((b) => b.kbd)));
  const pin = bar.find((b) => b.kbd === "Ctrl+Shift+0…9");
  check("6. pin chip info-only, the rest run commands", !!pin && pin.dim && pin.disabled && bar.filter((b) => b.disabled).length === 1, "");

  await releaseMods(cdp, ["Shift"]);
  bar = await evalIn(cdp, barOf);
  check("7. Shift released -> Ctrl row again", bar.every((b) => b.kbd.startsWith("Ctrl+") && !b.kbd.startsWith("Ctrl+Shift")), "");

  await holdMods(cdp, ["Alt"]);
  bar = await evalIn(cdp, barOf);
  check("8. Ctrl+Alt (no such chords) stays on the Ctrl row", bar.every((b) => b.kbd.startsWith("Ctrl+")) && !bar.some((b) => b.kbd.startsWith("Alt")), "");
  await releaseMods(cdp, ["Alt", "Control"]);
  bar = await evalIn(cdp, barOf);
  check("9. all released -> plain F bar", bar.length === 12 && bar[0].kbd === "F1" && bar.every((b) => !b.chip), `n=${bar.length}`);

  await holdMods(cdp, ["Alt"]);
  bar = await evalIn(cdp, barOf);
  check("10. Alt row: Alt+ chords", bar.length > 0 && bar.every((b) => b.kbd.startsWith("Alt+")) && bar.some((b) => b.kbd === "Alt+F1"), `n=${bar.length}`);
  await holdMods(cdp, ["Shift"]);
  bar = await evalIn(cdp, barOf);
  check("11. Alt+Shift pair row: history arrows", JSON.stringify(bar.map((b) => b.kbd)) === JSON.stringify(["Alt+Shift+←", "Alt+Shift+→"]),
    JSON.stringify(bar.map((b) => b.kbd)));
  await releaseMods(cdp, ["Shift", "Alt"]);
  bar = await evalIn(cdp, barOf);
  check("12. released -> plain F bar", bar.length === 12 && bar[0].kbd === "F1", `n=${bar.length}`);

  // the real chord: Ctrl+Shift+F4 opens the in-memory scratchpad
  await holdMods(cdp, ["Control", "Shift"]);
  const bits = MODBIT.Control | MODBIT.Shift;
  await cdp.send("Input.dispatchKeyEvent", { key: "F4", code: "F4", windowsVirtualKeyCode: VK.F4, modifiers: bits, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { key: "F4", code: "F4", windowsVirtualKeyCode: VK.F4, modifiers: bits, type: "keyUp" });
  await sleep(200);
  const editorUp = await waitFor(cdp, `!!document.querySelector(".cm-editor") ? 1 : ""`, 15000, "scratch editor");
  check("13. real Ctrl+Shift+F4 opens the scratchpad editor", editorUp === 1, "");
  await releaseMods(cdp, ["Control", "Shift"]);

  await holdMods(cdp, ["Control", "Shift"]);
  bar = await evalIn(cdp, barOf);
  check("14. editor Ctrl+Shift row: F4/L/Tab exactly", JSON.stringify(bar.map((b) => b.kbd)) === JSON.stringify(["Ctrl+Shift+F4", "Ctrl+Shift+L", "Ctrl+Shift+Tab"]),
    JSON.stringify(bar.map((b) => b.kbd)));

  await releaseMods(cdp, ["Control"]);
  await holdMods(cdp, ["Alt"]);
  bar = await evalIn(cdp, barOf);
  check("15. editor Alt+Shift falls back to the Shift row", bar.length === 2 && bar.every((b) => b.kbd.startsWith("Shift+") && !b.kbd.startsWith("Alt")),
    JSON.stringify(bar.map((b) => b.kbd)));
  await releaseMods(cdp, ["Alt", "Shift"]);

  await cdp.send("Input.dispatchKeyEvent", { key: "Escape", code: "Escape", windowsVirtualKeyCode: VK.Escape, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { key: "Escape", code: "Escape", windowsVirtualKeyCode: VK.Escape, type: "keyUp" });
  await sleep(400);
  const back = await evalIn(cdp, `!!document.querySelector(".panel") && !document.querySelector(".cm-editor")`);
  check("16. Esc closes the scratch back to the panels", back === true, "");

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
}
