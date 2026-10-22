// Exe-level E2E for alnavi-037: in the REAL released exe (1.14.4) F8 in the
// editor / Shift+F8 in the viewer re-reads the file in the chosen encoding,
// auto-detection picks Unicode by BOM and falls back to windows-1251 for
// single-byte Cyrillic. Verified against the real Rust backend:
//   - koi8.txt (KOI8-R bytes) opens in the viewer as windows-1251 mojibake
//     (the fallback), Shift+F8 -> KOI8-R re-reads it correctly
//   - u16.txt (UTF-16LE + BOM) opens in the editor correctly right away
//     (auto), F8 -> windows-1251 turns it into mojibake, F8 -> Auto is
//     back to the correct decode
//   - cp1251.txt (Windows-1251 bytes) decodes correctly through the default
//     fallback without any manual switching
// Usage: node scripts/e2e-alnavi-037-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.14.4";
const CFG = join(process.env.APPDATA, "al-navi");
const CDP_PORT = 9267;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// ---- test texts and their single-byte encodings (built by inverting a
// TextDecoder — Node has no koi8-r/cp1251 ENcoder, only decoders)
const KOI8_TEXT = "Привет из KOI8-R\nвторая строка файла";
const U16_TEXT = "Привет из UTF-16LE\nтекст с Bom";
const CP1251_TEXT = "Привет из Windows-1251\nстрока номер два";

function byteEncoder(label) {
  const dec = new TextDecoder(label, { fatal: false });
  const map = new Map();
  for (let b = 0x80; b < 0x100; b++) {
    const ch = dec.decode(new Uint8Array([b]));
    if (ch && ch !== "\uFFFD") map.set(ch, b);
  }
  return (s) => {
    const out = [];
    for (const ch of s) {
      const code = ch.codePointAt(0);
      if (code < 0x80) out.push(code);
      else {
        const b = map.get(ch);
        if (b === undefined) throw new Error(`no byte for U+${code.toString(16)} in ${label}`);
        out.push(b);
      }
    }
    return Buffer.from(out);
  };
}
const toKoi8 = byteEncoder("koi8-r");
const toCp1251 = byteEncoder("windows-1251");

const work = mkdtempSync(join(tmpdir(), "alnavi037exe"));
writeFileSync(join(work, "cp1251.txt"), toCp1251(CP1251_TEXT));
writeFileSync(join(work, "koi8.txt"), toKoi8(KOI8_TEXT));
writeFileSync(join(work, "u16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(U16_TEXT, "utf16le")]));

// the app writes settings/window state into the real config dir — back it up
mkdirSync(CFG, { recursive: true });
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

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  };
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  return { ready, events, send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); }, close: () => ws.close() };
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

const VK = { Enter: 13, Escape: 27, Home: 36, ArrowDown: 40, ArrowUp: 38, F3: 114, F4: 115, F8: 119 };
async function key(cdp, k, mods = 0) {
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k] ?? 0, modifiers: mods };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(120);
}
const SHIFT = 8;

const cmText = (cdp) => evalIn(cdp, `document.querySelector(".cm-content")?.textContent ?? null`);
const encChip = (cdp) => evalIn(cdp, `[...document.querySelectorAll(".v-status .btn.small")].map((b) => b.textContent.trim()).join("|")`);
const edSelect = (cdp) => evalIn(cdp, `document.querySelectorAll(".ed-status select")[1]?.value ?? null`);
const pickerRow = (cdp) => evalIn(cdp, `(() => {
  const rows = [...document.querySelectorAll(".dlg-body .li")];
  return rows.map((r, i) => ({ t: r.textContent.trim(), kbd: r.classList.contains("kbd"), i }));
})()`);

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: mkdtempSync(join(tmpdir(), "alnavi-037-exe-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
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

  await cdp.send("Input.insertText", { text: `cd ${work}` });
  await key(cdp, "Enter");
  await waitFor(cdp, `(document.querySelector(".panel.active .crumbs")?.textContent ?? "").toLowerCase().includes("alnavi037exe") ? 1 : ""`, 8000, "sandbox cd");

  // files sort alphabetically: cp1251.txt, koi8.txt, u16.txt (row 0 = "..")
  const cursorTo = async (name) => {
    await key(cdp, "Home");
    for (let i = 0; i < 3; i++) {
      const cur = await evalIn(cdp, `document.querySelector(".panel.active .row.cursor .name")?.textContent`);
      if (cur === name) return;
      await key(cdp, "ArrowDown");
    }
  };

  {
    // ---- viewer: KOI8-R file, auto-fallback mojibake -> Shift+F8 re-read
    await cursorTo("koi8.txt");
    await key(cdp, "F3");
    await waitFor(cdp, `!!document.querySelector(".cm-editor")`, 10000, "viewer text");
    await sleep(400);
    let text = await cmText(cdp);
    check("3. koi8.txt auto-opens as windows-1251 mojibake", text !== null && text.length > 10 && !text.includes("Привет"), JSON.stringify(text?.slice(0, 40)));
    let chip = await encChip(cdp);
    check("4. viewer chip: Windows-1251 (fallback)", chip.includes("Windows-1251"), chip);

    await key(cdp, "F8", SHIFT);
    await sleep(250);
    let rows = await pickerRow(cdp);
    check("5. Shift+F8 opened the picker (8 rows, cursor on current)", rows.length === 8 && rows[4]?.kbd === true && /Windows-1251/.test(rows[4].t), rows?.find(r => r.kbd)?.t ?? "none");
    await key(cdp, "ArrowDown"); // -> KOI8-R
    await key(cdp, "Enter");
    await waitFor(cdp, `(document.querySelector(".cm-content")?.textContent ?? "").includes("Привет из KOI8-R") ? 1 : ""`, 8000, "koi8 re-read");
    check("6. KOI8-R re-read shows the correct Russian text", true);
    chip = await encChip(cdp);
    check("7. viewer chip: KOI8-R", chip.includes("KOI8-R"), chip);
    await key(cdp, "Escape"); // close the viewer

    // ---- editor: UTF-16LE+BOM auto-detected, manual override, auto back
    await cursorTo("u16.txt");
    await key(cdp, "F4");
    await waitFor(cdp, `!!document.querySelector(".cm-editor")`, 10000, "editor open");
    await waitFor(cdp, `(document.querySelector(".cm-content")?.textContent ?? "").includes("Привет из UTF-16LE") ? 1 : ""`, 8000, "u16 auto decode");
    check("8. u16.txt (BOM) auto-decoded as UTF-16LE in the editor", true);
    check("9. editor status select: utf-16le", (await edSelect(cdp)) === "utf-16le", await edSelect(cdp));

    await key(cdp, "F8");
    await sleep(250);
    // cursor on utf-16le (idx 2) -> windows-1251 is idx 4: Down, Down
    await key(cdp, "ArrowDown");
    await key(cdp, "ArrowDown");
    await key(cdp, "Enter");
    await sleep(300);
    // alnavi-038: a concrete encoding asks convert-or-reload; the re-read
    // is the second row of that step
    await key(cdp, "ArrowDown");
    await key(cdp, "Enter");
    await waitFor(cdp, `!(document.querySelector(".cm-content")?.textContent ?? "").includes("Привет из UTF-16LE") && (document.querySelector(".cm-content")?.textContent ?? "").length > 5 ? 1 : ""`, 8000, "manual 1251 decode");
    check("10. F8 -> Windows-1251 re-decodes as mojibake (manual override works)", true);
    check("11. editor status select: windows-1251", (await edSelect(cdp)) === "windows-1251");

    await key(cdp, "F8");
    await sleep(250);
    // cursor on windows-1251 (idx 4) -> Auto is idx 0: Up x4
    await key(cdp, "ArrowUp");
    await key(cdp, "ArrowUp");
    await key(cdp, "ArrowUp");
    await key(cdp, "ArrowUp");
    await key(cdp, "Enter");
    await waitFor(cdp, `(document.querySelector(".cm-content")?.textContent ?? "").includes("Привет из UTF-16LE") ? 1 : ""`, 8000, "auto decode");
    check("12. F8 -> Auto re-detects UTF-16LE from the BOM", true);
    check("13. editor status select back: utf-16le", (await edSelect(cdp)) === "utf-16le");
    await key(cdp, "Escape"); // close the editor

    // ---- editor: plain windows-1251 needs no manual switching
    await cursorTo("cp1251.txt");
    await key(cdp, "F4");
    await waitFor(cdp, `(document.querySelector(".cm-content")?.textContent ?? "").includes("Привет из Windows-1251") ? 1 : ""`, 8000, "1251 auto decode");
    check("14. cp1251.txt decodes correctly through the fallback (no manual step)", true);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error("FAILED:", failed.map(f => f.name).join("; "));
    process.exitCode = 1;
  }
} catch (e) {
  console.error("E2E failed:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  child.kill();
  await sleep(500);
  restoreCfg();
  rmSync(work, { recursive: true, force: true });
}
