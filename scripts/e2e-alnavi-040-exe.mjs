// E2E alnavi-040 (release exe): Ctrl+E recalls the PREVIOUS command —
// the walk direction fix (history[0] is the newest, so the walk starts
// there and goes older) verified on the real shipped exe with REAL keys:
//   1. exe boots with the pinned version
//   2. 1st Ctrl+E recalls the LAST typed command (not the ~100th oldest —
//      the old inverted walk, which is why the feature looked broken)
//   3. further Ctrl+E go older, clamped at the oldest
//   4. Ctrl+X walks forward, past the newest back to the half-typed draft
//   5. the recalled command is selected; typing replaces it; Enter runs it
//   6. Esc clears the line and the walk position
//   7. the real cmd-history.json keeps the newest command first
// The real config dir is backed up, a known history is seeded, and
// everything is restored afterwards.
// Usage: node scripts/e2e-alnavi-040-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.14.6";
const CDP_PORT = 9263;
const CFG = join(process.env.APPDATA, "al-navi");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// full backup of the real config dir to a temp place; seeded history in its place
const bak = mkdtempSync(join(tmpdir(), "alnavi-040-cfgbak-"));
for (const f of readdirSync(CFG)) {
  if (f.endsWith(".e2e-bak")) continue;
  cpSync(join(CFG, f), join(bak, f), { recursive: true });
}
// stored the way submit() writes it: NEWEST FIRST
writeFileSync(join(CFG, "cmd-history.json"), JSON.stringify(["newest-040", "mid-040", "old-040"]));
function restoreCfg() {
  for (let i = 0; i < 3; i++) {
    try {
      for (const f of readdirSync(CFG)) {
        if (f.endsWith(".e2e-bak")) continue;
        rmSync(join(CFG, f), { recursive: true, force: true });
      }
      for (const f of readdirSync(bak)) cpSync(join(bak, f), join(CFG, f), { recursive: true });
      return true;
    } catch { sleep(700); }
  }
  return false;
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
  };
}
async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
const waitFor = async (cdp, expr, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await evalIn(cdp, expr).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
};
async function key(cdp, def) {
  await cdp.send("Input.dispatchKeyEvent", { ...def, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...def, type: "keyUp" });
}
const CTRL = 2;
const ctrlE = (cdp) => key(cdp, { key: "e", code: "KeyE", windowsVirtualKeyCode: 69, modifiers: CTRL });
const ctrlX = (cdp) => key(cdp, { key: "x", code: "KeyX", windowsVirtualKeyCode: 88, modifiers: CTRL });
const enter = (cdp) => key(cdp, { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
const esc = (cdp) => key(cdp, { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

let child = null;
try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-040-"));
  child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
    stdio: "ignore",
  });
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => ({ json: async () => [] }))).json();
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    if (wsUrl) break;
    await sleep(500);
  }
  check("1. exe launches (CDP target up)", !!wsUrl);
  if (!wsUrl) throw new Error("no CDP target");
  const cdp = await connect(wsUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await sleep(3500);
  await waitFor(cdp, `!!document.querySelector(".cmdline input")`, 15000, "app UI");
  await sleep(2500); // cmdline.init() loads cmd-history.json

  const version = (await evalIn(cdp, `(document.querySelector(".version")?.textContent ?? "").trim()`));
  check(`2. title bar pins v${VERSION_PIN}`, version.includes(VERSION_PIN), version || "(none)");

  const facts = () => evalIn(cdp, `(() => {
    const i = document.querySelector(".cmdline input");
    return { v: i?.value ?? null, sel: i ? [i.selectionStart, i.selectionEnd] : null };
  })()`);
  await evalIn(cdp, `document.querySelector(".cmdline input").focus(); true`);

  await ctrlE(cdp); await sleep(300);
  let f = await facts();
  check("3. 1st Ctrl+E recalls the LAST command", f.v === "newest-040", JSON.stringify(f));
  check("4. recall is selected (typing replaces, Enter runs)", f.sel?.[0] === 0 && f.sel?.[1] === "newest-040".length, `sel=${JSON.stringify(f.sel)}`);
  await ctrlE(cdp); await sleep(250);
  f = await facts();
  check("5. 2nd Ctrl+E goes one older", f.v === "mid-040", f.v);
  await ctrlE(cdp); await sleep(250);
  await ctrlE(cdp); await sleep(250);
  f = await facts();
  check("6. clamped at the oldest (no wrap)", f.v === "old-040", f.v);
  await ctrlX(cdp); await sleep(250);
  f = await facts();
  check("7. Ctrl+X walks one newer", f.v === "mid-040", f.v);
  await ctrlX(cdp); await sleep(250);
  await ctrlX(cdp); await sleep(250);
  await ctrlX(cdp); await sleep(250);
  f = await facts();
  check("8. Ctrl+X past the newest restores the empty draft", f.v === "", f.v);

  await cdp.send("Input.insertText", { text: "par" }); await sleep(120);
  await ctrlE(cdp); await sleep(250);
  f = await facts();
  check("9. Ctrl+E from a draft recalls the newest", f.v === "newest-040", f.v);
  await ctrlX(cdp); await sleep(250);
  f = await facts();
  check("10. draft preserved through the walk", f.v === "par", f.v);

  await ctrlE(cdp); await sleep(250); // newest, selected
  await cdp.send("Input.insertText", { text: "exe-run-040" }); await sleep(120);
  await enter(cdp); await sleep(500);
  f = await facts();
  check("11. typing replaced the recall, Enter ran + cleared the line", f.v === "", f.v);
  const hist = JSON.parse(readFileSync(join(CFG, "cmd-history.json"), "utf8"));
  check("12. real cmd-history.json keeps the newest first", Array.isArray(hist) && hist[0] === "exe-run-040" && hist.length === 4, JSON.stringify(hist.slice(0, 4)));
  await ctrlE(cdp); await sleep(250);
  f = await facts();
  check("13. after submit Ctrl+E starts from the newest", f.v === "exe-run-040", f.v);
  await esc(cdp); await sleep(200);
  f = await facts();
  check("14. Esc clears the line", f.v === "", f.v);
} finally {
  if (child) child.kill();
  await sleep(1200);
  check("15. real config restored", restoreCfg());
  try { rmSync(bak, { recursive: true, force: true }); } catch {}
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
}
