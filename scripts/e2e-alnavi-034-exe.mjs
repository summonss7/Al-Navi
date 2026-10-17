// Exe-level E2E for alnavi-034: in the REAL released exe (1.14.3) the editor
// supports column (rectangular) selection on Shift+Alt+arrows. Against the
// real backend with a sandbox of two files:
//   - F4 opens block.txt; real Shift+Alt+Down/Right presses paint one cursor
//     per line (CodeMirror draws one .cm-cursor per range and one
//     .cm-selectionBackground per non-empty range — the DOM is the only
//     access to the view state in the bundled exe)
//   - the copy DOM event yields the block joined with newlines, empty rows
//     in place; a REAL Ctrl+C puts the same text on the OS clipboard
//   - pasting the block into paste.txt and saving lands it in the file on disk
//   - Delete removes each row's fragment, an empty row does not merge lines
//     (saved to disk and re-read)
//   - the read-only viewer F3 column-selects and copies too
//   - F1 help carries the new column rows
// Usage: node scripts/e2e-alnavi-034-exe.mjs [path-to-Al-Navi.exe]
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.14.3";
const CFG = join(process.env.APPDATA, "al-navi");
const CDP_PORT = 9271;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// the sandbox document: fixed offsets, a short second line for clamping
const ROWS = ["abcdefghij", "kl", "mnopqrstuv", "wxyz", "0123456789"];
const BOX = mkdtempSync(join(tmpdir(), "alnavi-034-exe-"));
const BLOCK = join(BOX, "block.txt");
const PASTE = join(BOX, "paste.txt");
writeFileSync(BLOCK, ROWS.join("\n"));
writeFileSync(PASTE, "tail");

// the app writes editor-state/settings into the real config dir — back it up
const backedUp = [];
for (const f of readdirSync(CFG)) {
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

function osClipboard() {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard"], { encoding: "utf8" })
      .replace(/\r\n/g, "\n").replace(/\n$/, "");
  } catch {
    return null;
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
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
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

const VK = { Enter: 13, Escape: 27, F1: 112, F2: 113, F3: 114, F4: 115, Delete: 46, C: 67, PageUp: 33, PageDown: 34, Down: 40, Up: 38, Right: 39, Left: 37 };
// CDP modifiers: Alt=1, Ctrl=2, Shift=8
async function key(cdp, k, mod = 0) {
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k], modifiers: mod };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(150);
}
const colKey = (cdp, name) => key(cdp, "Arrow" + name, 1 | 8);

// DOM-only view state (no module access in the bundled exe): one cursor per
// selection range, one selection plate per non-empty range
const cmDom = (cdp) => evalIn(cdp, `(() => ({
  cursors: document.querySelectorAll(".cm-cursor").length,
  plates: document.querySelectorAll(".cm-selectionBackground").length,
  path: document.querySelector(".ed-status .path")?.textContent ?? "",
}))()`);
const clipEvent = (cdp, type, text) => evalIn(cdp, `(() => {
  const host = document.querySelector(".cm-content");
  if (!host) return null;
  const dt = new DataTransfer();
  ${text !== undefined ? `dt.setData("text/plain", ${JSON.stringify(text)});` : ""}
  host.dispatchEvent(new ClipboardEvent(${JSON.stringify(type)}, { clipboardData: dt, bubbles: true, cancelable: true }));
  return dt.getData("text/plain") || null;
})()`);

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: mkdtempSync(join(tmpdir(), "alnavi-034-web-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
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

  // sandbox panel: rows .., block.txt, paste.txt — Down lands on block.txt
  await cdp.send("Input.insertText", { text: `cd ${BOX}` });
  await key(cdp, "Enter");
  await waitFor(cdp, `(document.querySelector(".panel.active .crumbs")?.textContent ?? "").includes("alnavi-034") ? 1 : ""`, 8000, "cd sandbox");
  await key(cdp, "ArrowDown"); // ".." -> block.txt
  await key(cdp, "F4");
  await waitFor(cdp, `!!document.querySelector(".cm-editor")`, 12000, "editor");
  let s = await cmDom(cdp);
  check("3. F4 opened block.txt in the editor", /block\.txt/.test(s.path), JSON.stringify(s.path));

  // ---- the block: caret 0 (Ctrl+PageUp), Down x2 + Right x2 = lines 1..3, cols 0..2 ----
  await key(cdp, "PageUp", 2); // Ctrl+PageUp: caret to the doc start
  await colKey(cdp, "Down"); await colKey(cdp, "Down");
  s = await cmDom(cdp);
  check("4. Shift+Alt+Down x2: one cursor per line, nothing selected yet", s.cursors === 3 && s.plates === 0, `cursors=${s.cursors} plates=${s.plates}`);
  await colKey(cdp, "Right"); await colKey(cdp, "Right");
  s = await cmDom(cdp);
  check("5. Shift+Alt+Right x2: every line's fragment selected", s.cursors === 3 && s.plates === 3, `cursors=${s.cursors} plates=${s.plates}`);

  // ---- copy: DOM event (deterministic) and the REAL Ctrl+C -> OS clipboard ----
  const copied = await clipEvent(cdp, "copy");
  check("6. copy event yields the block rows joined with newlines", copied === "ab\nkl\nmn", JSON.stringify(copied));
  await key(cdp, "C", 2); // real Ctrl+C
  await sleep(400);
  const osClip = osClipboard();
  check("7. real Ctrl+C put the block on the OS clipboard", osClip === "ab\nkl\nmn", JSON.stringify(osClip));

  // ---- close clean, open paste.txt, paste the block, save ----
  await key(cdp, "Escape");
  await waitFor(cdp, `!!document.querySelector(".panel") && !document.querySelector(".cm-editor")`, 8000, "back to panels");
  await key(cdp, "ArrowDown"); // block.txt -> paste.txt
  await key(cdp, "F4");
  await waitFor(cdp, `!!document.querySelector(".cm-editor")`, 12000, "paste.txt editor");
  await key(cdp, "PageUp", 2); // caret to the doc start
  await clipEvent(cdp, "paste", "ab\nkl\nmn");
  await key(cdp, "F2");
  await sleep(700);
  const pasted = readFileSync(PASTE, "utf8");
  check("8. pasted block + F2 landed in paste.txt on disk", pasted === "ab\nkl\nmntail", JSON.stringify(pasted));
  await key(cdp, "Escape");
  await waitFor(cdp, `!!document.querySelector(".panel") && !document.querySelector(".cm-editor")`, 8000, "back to panels 2");

  // ---- block delete: rows spliced, short line not merged, saved to disk ----
  await key(cdp, "ArrowUp"); // paste.txt -> block.txt
  await key(cdp, "F4");
  await waitFor(cdp, `!!document.querySelector(".cm-editor")`, 12000, "block.txt editor 2");
  await key(cdp, "PageUp", 2); // caret to the doc start (whatever was remembered)
  await key(cdp, "ArrowRight"); await key(cdp, "ArrowRight"); await key(cdp, "ArrowRight"); // col 3
  await colKey(cdp, "Down"); await colKey(cdp, "Down"); await colKey(cdp, "Right");
  s = await cmDom(cdp);
  check("9. delete setup: 3 rows selected around col 3 (short line empty)", s.cursors === 3 && s.plates === 2, `cursors=${s.cursors} plates=${s.plates}`);
  await key(cdp, "Delete");
  s = await cmDom(cdp);
  check("10. Delete removed the selected fragments (plates gone)", s.cursors === 3 && s.plates === 0, `cursors=${s.cursors} plates=${s.plates}`);
  await key(cdp, "F2");
  await sleep(700);
  const deleted = readFileSync(BLOCK, "utf8");
  check("11. Delete removed each row's fragment, short line not merged",
    deleted === "abcefghij\nkl\nmnoqrstuv\nwxyz\n0123456789", JSON.stringify(deleted));
  await key(cdp, "Escape");
  await waitFor(cdp, `!!document.querySelector(".panel") && !document.querySelector(".cm-editor")`, 8000, "back to panels 3");

  // ---- the read-only viewer column-selects and copies too ----
  await key(cdp, "F3");
  await waitFor(cdp, `!!document.querySelector(".cm-editor")`, 12000, "viewer");
  await key(cdp, "PageUp", 2); // caret to the doc start
  await colKey(cdp, "Down"); await colKey(cdp, "Down");
  await colKey(cdp, "Right"); await colKey(cdp, "Right");
  s = await cmDom(cdp);
  check("12. viewer F3: column selected (cursors+plates)", s.cursors === 3 && s.plates === 3, `cursors=${s.cursors} plates=${s.plates}`);
  const vcopy = await clipEvent(cdp, "copy");
  check("13. viewer copy yields the block rows", vcopy === "ab\nkl\nmn", JSON.stringify(vcopy));
  await key(cdp, "Escape");
  await waitFor(cdp, `!!document.querySelector(".panel") && !document.querySelector(".cm-editor")`, 8000, "back to panels 4");

  // ---- F1 documents the column chords ----
  await key(cdp, "F1");
  await waitFor(cdp, `!!document.querySelector(".dlg.help-dlg")`, 8000, "help dialog");
  const help = await evalIn(cdp, `(() => {
    const rows = [...document.querySelectorAll(".help-dlg .hrow")];
    const hit = rows.find((x) => (x.querySelector("kbd")?.textContent ?? "").includes("Shift+Alt+"));
    return { found: !!hit, kbd: hit?.querySelector("kbd")?.textContent ?? "", rows: rows.length };
  })()`);
  check("14. help carries the Shift+Alt column rows (96 rows)", help.found && help.rows === 96 && /Shift\+Alt/.test(help.kbd), `rows=${help.rows} kbd=${JSON.stringify(help.kbd)}`);
  await key(cdp, "Escape");

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error("FAILED:", failed.map(f => f.name).join("; "));
    process.exitCode = 1;
  }
} finally {
  child.kill();
  spawn("taskkill", ["/IM", "Al-Navi.exe", "/F"], { stdio: "ignore" });
  await sleep(1000);
  restoreCfg();
  rmSync(BOX, { recursive: true, force: true });
}
