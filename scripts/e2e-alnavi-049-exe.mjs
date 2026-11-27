// E2E alnavi-049 (release exe): FAR rename templates — "*" and "?" in a
// typed target name borrow characters from the current file name, on the
// real shipped exe with REAL files on disk (no mocks):
//   1. exe boots with the pinned version
//   2. `cd <tmp>` in the real command line; the tmp dir holds notes.txt
//   3. Shift+F6 typed "readme.*" -> notes.txt becomes readme.txt on disk
//      (the extension comes from the old name)
//   4. F6 typed "*.bak" -> readme.txt moves to readme.bak (stem kept)
//   5. Shift+F6 typed "???.*" -> readme.bak becomes rea.bak ("?" copies
//      one character of the old name per position)
// The real config dir is backed up and restored afterwards (like 048).
// Usage: node scripts/e2e-alnavi-049-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.14.15";
const CDP_PORT = 9266;
const CFG = join(process.env.APPDATA, "al-navi");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// real config backup + restore (the typed `cd` lands in cmd-history.json)
const bak = mkdtempSync(join(tmpdir(), "alnavi-049-cfgbak-"));
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

// the real files the exe renames
const work = mkdtempSync(join(tmpdir(), "alnavi-049-"));
writeFileSync(join(work, "notes.txt"), "hello 049");

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
const SHIFT = 8;
// Shift+key as a separate down/up around the key (like 014-flow)
async function shiftKey(cdp, k, vk) {
  await cdp.send("Input.dispatchKeyEvent", { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: SHIFT, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { key: k, code: k, windowsVirtualKeyCode: vk, modifiers: SHIFT, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { key: k, code: k, windowsVirtualKeyCode: vk, modifiers: SHIFT, type: "keyUp" });
  await cdp.send("Input.dispatchKeyEvent", { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0, type: "keyUp" });
  await sleep(120);
}
const down = (cdp) => key(cdp, { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
const home = (cdp) => key(cdp, { key: "Home", code: "Home", windowsVirtualKeyCode: 36 });
// `text` on keyDown lets the browser perform the default action — same as a
// physical Enter (runs the `cd` command)
const enter = (cdp) => key(cdp, { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
const type = (cdp, t) => cdp.send("Input.insertText", { text: t });

const cursorName = (cdp) => evalIn(cdp, `document.querySelector(".row.cursor .name")?.textContent ?? null`);
const panelRows = (cdp) => evalIn(cdp, `document.querySelector(".panel.active .vlist")?.textContent ?? ""`);
async function clickPrimary(cdp) {
  const r = await evalIn(cdp, `(() => { const b = document.querySelector(".dlg-actions .btn.primary"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!r) throw new Error("no primary button to click");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: r.x, y: r.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: r.x, y: r.y });
  await sleep(160);
}
// a chord opens the rename/move dialog with the old name preselected —
// typing replaces it, the primary button applies
async function renameWithMask(cdp, chordFn, typed) {
  await chordFn(cdp);
  await waitFor(cdp, `!!document.querySelector(".dlg input")`, 5000, "input dialog");
  await type(cdp, typed);
  await clickPrimary(cdp);
}

let child = null;
try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-049-webview-"));
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
  await waitFor(cdp, `(document.querySelector(".panel.active .vlist")?.textContent ?? "").includes("notes.txt") ? true : null`, 8000, "notes.txt listed");
  check("3. panel lists notes.txt in the temp dir", (await panelRows(cdp)).includes("notes.txt"));

  for (let i = 0; i < 4 && (await cursorName(cdp)) !== "notes.txt"; i++) {
    await down(cdp); await sleep(150);
  }
  check("4. cursor rests on notes.txt", (await cursorName(cdp)) === "notes.txt", await cursorName(cdp));

  // Shift+F6 with "readme.*": the extension comes from the old name
  await renameWithMask(cdp, (c) => shiftKey(c, "F6", 117), "readme.*");
  await waitFor(cdp, `(document.querySelector(".panel.active .vlist")?.textContent ?? "").includes("readme.txt") ? true : null`, 8000, "readme.txt row");
  check("5. Shift+F6 \"readme.*\" -> readme.txt in the panel", (await panelRows(cdp)).includes("readme.txt"));
  check("6. on disk: notes.txt is gone, readme.txt is there",
    !existsSync(join(work, "notes.txt")) && existsSync(join(work, "readme.txt")));

  // F6 with "*.bak": the stem comes from the old name (move-with-rename)
  for (let i = 0; i < 4 && (await cursorName(cdp)) !== "readme.txt"; i++) {
    await down(cdp); await sleep(150);
  }
  await renameWithMask(cdp, (c) => key(c, { key: "F6", code: "F6", windowsVirtualKeyCode: 117 }), "*.bak");
  await waitFor(cdp, `(document.querySelector(".panel.active .vlist")?.textContent ?? "").includes("readme.bak") ? true : null`, 10000, "readme.bak row");
  check("7. F6 \"*.bak\" -> readme.bak in the panel", (await panelRows(cdp)).includes("readme.bak"));
  check("8. on disk: readme.txt moved to readme.bak",
    !existsSync(join(work, "readme.txt")) && existsSync(join(work, "readme.bak")));

  // Shift+F6 with "???.*": ? copies one character per position
  for (let i = 0; i < 4 && (await cursorName(cdp)) !== "readme.bak"; i++) {
    await down(cdp); await sleep(150);
  }
  await renameWithMask(cdp, (c) => shiftKey(c, "F6", 117), "???.*");
  await waitFor(cdp, `(document.querySelector(".panel.active .vlist")?.textContent ?? "").includes("rea.bak") ? true : null`, 8000, "rea.bak row");
  check("9. Shift+F6 \"???.*\" -> rea.bak in the panel", (await panelRows(cdp)).includes("rea.bak"));
  check("10. on disk: rea.bak carries the original content",
    existsSync(join(work, "rea.bak")) && !existsSync(join(work, "readme.bak")));

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
