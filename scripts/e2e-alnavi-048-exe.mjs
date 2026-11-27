// E2E alnavi-048 (release exe): Alt+F3 re-reads the occupied size of the
// folder under the cursor on the real shipped exe — REAL keys, REAL dirsize
// walks, no mocks:
//   1. exe boots with the pinned version
//   2. `cd <tmp>` in the real command line; the tmp dir holds a folder with
//      two known files (3345 bytes total) and a top-level file
//   3. Alt+F3 on the folder: a toast names the target and the row's size
//      column fills with the real walked "≈" value
//   4. Alt+F3 on a file: no walk, the local-folders hint toast
//   5. Alt+F3 on "..": the toast names the viewed folder itself
// The real config dir is backed up and restored afterwards (like e2e-043).
// Usage: node scripts/e2e-alnavi-048-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.14.15";
const CDP_PORT = 9265;
const CFG = join(process.env.APPDATA, "al-navi");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// real config backup + restore (the typed `cd` lands in cmd-history.json,
// walked sizes land in dir-sizes.json)
const bak = mkdtempSync(join(tmpdir(), "alnavi-048-cfgbak-"));
for (const f of readdirSync(CFG)) {
  if (f.endsWith(".e2e-bak")) continue;
  cpSync(join(CFG, f), join(bak, f), { recursive: true });
}
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

// the real folders the exe walks: target/ holds exactly 3345 bytes of files
const work = mkdtempSync(join(tmpdir(), "alnavi-048-"));
const dir = join(work, "target");
mkdirSync(dir);
writeFileSync(join(dir, "a.bin"), Buffer.alloc(1000, 1));
writeFileSync(join(dir, "b.bin"), Buffer.alloc(2345, 1));
writeFileSync(join(work, "note.txt"), "note");

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
const ALT = 1;
const altF3 = (cdp) => key(cdp, { key: "F3", code: "F3", windowsVirtualKeyCode: 114, modifiers: ALT });
const down = (cdp) => key(cdp, { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
// `text` on keyDown lets the browser perform the default action — same as a
// physical Enter (runs the `cd` command)
const enter = (cdp) => key(cdp, { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
const type = (cdp, t) => cdp.send("Input.insertText", { text: t });

const cursorName = (cdp) => evalIn(cdp, `document.querySelector(".row.cursor .name")?.textContent ?? null`);
const cursorSize = (cdp) => evalIn(cdp, `document.querySelector(".row.cursor .size")?.textContent ?? null`);
const toastText = (cdp) => evalIn(cdp, `document.querySelector(".toast")?.textContent ?? null`);

let child = null;
try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-048-webview-"));
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
  await sleep(1500); // settle: panels load, settings apply

  const version = (await evalIn(cdp, `(document.querySelector(".version")?.textContent ?? "").trim()`));
  check(`2. title bar pins v${VERSION_PIN}`, version.includes(VERSION_PIN), version || "(none)");

  // real navigation: cd to the temp dir through the real command line
  await evalIn(cdp, `document.querySelector(".cmdline input").focus(); true`);
  await type(cdp, `cd "${work}"`);
  await enter(cdp); await sleep(1200);
  for (let i = 0; i < 5 && (await cursorName(cdp)) !== "target"; i++) {
    await down(cdp); await sleep(150);
  }
  check("3. panel lists the temp folder under the cursor", (await cursorName(cdp)) === "target", await cursorName(cdp));

  await altF3(cdp); await sleep(300);
  const t1 = await toastText(cdp);
  check("4. Alt+F3 on a folder: toast names the target", (t1 ?? "").includes("target"), `toast="${t1}"`);

  const cell = await waitFor(cdp, `(document.querySelector(".row.cursor .size")?.textContent ?? "").startsWith("≈") ? document.querySelector(".row.cursor .size").textContent : null`, 20000, "walked ≈ size");
  check("5. the walked size lands in the row: ≈3.27 KB (1000+2345 bytes)", cell === "≈3.27 KB", `cell="${cell}"`);

  // cursor onto the top-level file
  for (let i = 0; i < 6 && (await cursorName(cdp)) !== "note.txt"; i++) {
    await down(cdp); await sleep(150);
  }
  await altF3(cdp); await sleep(300);
  const t2 = await toastText(cdp);
  check("6. Alt+F3 on a file: the local-folders hint toast", (t2 ?? "").includes("Alt+F3"), `toast="${t2}"`);

  // cursor back onto "..": the target is the viewed folder itself
  await key(cdp, { key: "Home", code: "Home", windowsVirtualKeyCode: 36 }); await sleep(200);
  check("7. cursor rests on \"..\"", (await cursorName(cdp)) === "..", await cursorName(cdp));
  await altF3(cdp); await sleep(300);
  const t3 = await toastText(cdp);
  check("8. Alt+F3 on \"..\": toast names the viewed folder", (t3 ?? "").includes("alnavi-048"), `toast="${t3}"`);

  child.kill();
} catch (e) {
  console.error("SUITE ERROR:", e.message);
  if (child) child.kill();
} finally {
  await sleep(500);
  child?.kill();
  try { child?.kill(); } catch { /* already gone */ }
  restoreCfg();
  rmSync(work, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
