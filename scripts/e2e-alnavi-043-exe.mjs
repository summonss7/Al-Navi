// E2E alnavi-043 (release exe): Ctrl+F7 replace dialog on the real shipped
// exe with REAL files and REAL keys — no mocks:
//   1. exe boots with the pinned version
//   2. `cd <tmp>` in the real command line, cursor onto the file, F4 opens
//      the editor
//   3. Ctrl+F7 opens the modal replace dialog
//   4. «Заменить» steps: 1st Enter selects a match (no change), 2nd replaces
//      it and selects the next, 3rd replaces the last one
//   5. F2 saves the edit — the temp file on disk carries the new content
//   6. Esc closes the dialog, Esc closes the editor back to the panels
// The real config dir is backed up and restored afterwards (like e2e-040).
// Usage: node scripts/e2e-alnavi-043-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.14.9";
const CDP_PORT = 9264;
const CFG = join(process.env.APPDATA, "al-navi");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// real config backup + restore (the typed `cd` lands in cmd-history.json)
const bak = mkdtempSync(join(tmpdir(), "alnavi-043-cfgbak-"));
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

// the real file the editor edits (plain content, no mocks)
const work = mkdtempSync(join(tmpdir(), "alnavi-043-"));
const FILE = join(work, "rep.txt");
writeFileSync(FILE, "one two three\none two three");

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
const ctrlF7 = (cdp) => key(cdp, { key: "F7", code: "F7", windowsVirtualKeyCode: 118, modifiers: CTRL });
const f2 = (cdp) => key(cdp, { key: "F2", code: "F2", windowsVirtualKeyCode: 113 });
const f4 = (cdp) => key(cdp, { key: "F4", code: "F4", windowsVirtualKeyCode: 115 });
const down = (cdp) => key(cdp, { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
const esc = (cdp) => key(cdp, { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
// `text` on keyDown lets the browser perform the default action (implicit
// form submission) — same as a physical Enter
const enter = (cdp) => key(cdp, { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
const tab = (cdp) => key(cdp, { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
const type = (cdp, t) => cdp.send("Input.insertText", { text: t });

// visible editor text: one .cm-line per row (the doc is 2 lines — no virtualization)
const edText = (cdp) => evalIn(cdp, `[...document.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\\n")`);
const facts = (cdp) => evalIn(cdp, `(() => ({
  dlg: !!document.querySelector(".dlg"),
  find: document.querySelector("#rp-f-find")?.value ?? null,
  focusFind: document.activeElement === document.querySelector("#rp-f-find"),
  selection: !!document.querySelector(".cm-selectionBackground"),
  toast: document.querySelector(".toast")?.textContent ?? null,
}))()`);

let child = null;
try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-043-webview-"));
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
  const cursorName = () => evalIn(cdp, `document.querySelector(".row.cursor .name")?.textContent ?? null`);
  for (let i = 0; i < 5 && (await cursorName()) !== "rep.txt"; i++) {
    await down(cdp); await sleep(150);
  }
  check("3. panel lists the temp file under the cursor", (await cursorName()) === "rep.txt", await cursorName());

  await f4(cdp); await sleep(2500); // editor opens and reads the file
  await waitFor(cdp, `!!document.querySelector(".cm-editor")`, 15000, "editor");
  check("4. F4 opens the editor with the file", (await edText(cdp)) === "one two three\none two three", JSON.stringify(await edText(cdp)));

  await ctrlF7(cdp); await sleep(400);
  let f = await facts(cdp);
  check("5. Ctrl+F7 opens the replace dialog, focus in the find field", f.dlg === true && f.focusFind === true, JSON.stringify(f));

  await type(cdp, "one"); await tab(cdp); await type(cdp, "1"); await sleep(150);
  await enter(cdp); await sleep(400); // 1st: select the first match
  f = await facts(cdp);
  check("6. first «Заменить» selects a match, text untouched", f.selection === true && (await edText(cdp)) === "one two three\none two three", JSON.stringify(f));
  await enter(cdp); await sleep(400); // 2nd: replace it, select the next
  check("7. second «Заменить» replaces the first occurrence", (await edText(cdp)) === "1 two three\none two three", JSON.stringify(await edText(cdp)));
  await enter(cdp); await sleep(400); // 3rd: replace the last one
  f = await facts(cdp);
  check("8. third «Заменить» replaces the rest, dialog stays open", (await edText(cdp)) === "1 two three\n1 two three" && f.dlg === true, JSON.stringify(f));

  await esc(cdp); await sleep(400); // close the dialog first — F2 is the editor's
  f = await facts(cdp);
  check("9. Esc closes the dialog", f.dlg === false, JSON.stringify(f));

  await f2(cdp); await sleep(1500); // real save to the temp file
  const onDisk = readFileSync(FILE, "utf8");
  check("10. F2 writes the replaced text to the real file", onDisk === "1 two three\n1 two three", JSON.stringify(onDisk));

  await esc(cdp); await sleep(600); // clean doc — closes without the save prompt
  const panels = await evalIn(cdp, `!!document.querySelector(".cmdline input") && !document.querySelector(".cm-editor")`);
  check("11. Esc closes the editor back to the panels", panels === true, `panels=${panels}`);
} catch (e) {
  console.error(e);
} finally {
  try { child?.kill(); } catch {}
  await sleep(800);
  const restored = restoreCfg();
  try { rmSync(work, { recursive: true, force: true }); } catch {}
  try { rmSync(bak, { recursive: true, force: true }); } catch {}
  if (!restored) console.error("CONFIG RESTORE FAILED");
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
}
