// Exe-level E2E for alnavi-038: the FAR encoding-conversion workflow works
// in the REAL released exe (1.14.5) — «выделить → вырезать → сменить
// кодировку → вставить → сохранить» becomes a direct convert action:
//   - cp1251.txt (readable) → F8 → KOI8-R → «Перекодировать» (Enter on the
//     default row): the text stays readable, the doc goes dirty, F2 writes
//     the file in KOI8-R — verified by decoding the real bytes from Node
//   - reopening the converted file shows 1251 mojibake (the bytes really
//     changed) and F8 → KOI8-R → «Перечитать» restores the readable view
//   - u8.txt (UTF-8) converted to UTF-16LE: real bytes checked, and the
//     file re-opens readable through the NUL heuristic (no BOM is written)
// Usage: node scripts/e2e-alnavi-038-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.14.5";
const CFG = join(process.env.APPDATA, "al-navi");
const CDP_PORT = 9269;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

const CP1251_TEXT = "Съёмный текст в кодировке 1251\nстрока номер два";
const U8_TEXT = "Юникодный текст UTF-8\nвторая строка тут";

// Node has no windows-1251 ENcoder, only a decoder — build one by inversion
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
const toCp1251 = byteEncoder("windows-1251");

const work = mkdtempSync(join(tmpdir(), "alnavi038exe"));
const CP_FILE = join(work, "cp1251.txt");
const U8_FILE = join(work, "u8.txt");
writeFileSync(CP_FILE, toCp1251(CP1251_TEXT));
writeFileSync(U8_FILE, Buffer.from(U8_TEXT, "utf8"));

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

const VK = { Enter: 13, Escape: 27, Home: 36, ArrowDown: 40, ArrowUp: 38, F2: 113, F3: 114, F4: 115, F8: 119 };
async function key(cdp, k, mods = 0) {
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k] ?? 0, modifiers: mods };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(120);
}

const cmText = (cdp) => evalIn(cdp, `document.querySelector(".cm-content")?.textContent ?? null`);
const edSelect = (cdp) => evalIn(cdp, `document.querySelectorAll(".ed-status select")[1]?.value ?? null`);
const dirtyDot = (cdp) => evalIn(cdp, `!!document.querySelector(".ed-status.top .dirty")`);
const toastText = (cdp) => evalIn(cdp, `document.querySelector(".toast")?.textContent ?? null`);
const pickerRows = (cdp) => evalIn(cdp, `(() => {
  const rows = [...document.querySelectorAll(".dlg-body .li")];
  return rows.map((r, i) => ({ t: r.textContent.trim(), kbd: r.classList.contains("kbd"), i }));
})()`);

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: mkdtempSync(join(tmpdir(), "alnavi-038-exe-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
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
  await waitFor(cdp, `(document.querySelector(".panel.active .crumbs")?.textContent ?? "").toLowerCase().includes("alnavi038exe") ? 1 : ""`, 8000, "sandbox cd");

  // files sort alphabetically: cp1251.txt (row 0 = ".."), u8.txt
  const cursorTo = async (name) => {
    await key(cdp, "Home");
    for (let i = 0; i < 3; i++) {
      const cur = await evalIn(cdp, `document.querySelector(".panel.active .row.cursor .name")?.textContent`);
      if (cur === name) return;
      await key(cdp, "ArrowDown");
    }
  };

  {
    // ---- convert cp1251 -> KOI8-R, save, verify the real bytes
    await cursorTo("cp1251.txt");
    await key(cdp, "F4");
    await waitFor(cdp, `(document.querySelector(".cm-content")?.textContent ?? "").includes("Съёмный текст") ? 1 : ""`, 8000, "cp1251 auto decode");
    check("3. cp1251.txt opens readable (fallback)", true);
    check("4. status select: windows-1251", (await edSelect(cdp)) === "windows-1251", await edSelect(cdp));

    await key(cdp, "F8");
    await sleep(250);
    // cursor on windows-1251 (idx 4) -> koi8-r (idx 5): one Down
    await key(cdp, "ArrowDown");
    await key(cdp, "Enter");
    await sleep(300);
    let rows = await pickerRows(cdp);
    check("5. action step appeared (2 rows, cursor on convert)", rows.length === 2 && rows[0].kbd === true && /KOI8-R/.test(rows[0].t), rows.map(r => r.t).join(" | "));
    await key(cdp, "Enter"); // default = convert
    await sleep(400);
    check("6. text stays readable after the convert", (await cmText(cdp))?.includes("Съёмный текст") === true);
    check("7. doc marked dirty (nothing written yet)", (await dirtyDot(cdp)) === true);
    check("8. status select: koi8-r", (await edSelect(cdp)) === "koi8-r", await edSelect(cdp));
    const toast = await toastText(cdp);
    check("9. toast prompts the F2 save", /KOI8-R/.test(toast ?? "") && /F2/.test(toast ?? ""), toast);

    await key(cdp, "F2");
    await sleep(700);
    check("10. dirty cleared after F2", (await dirtyDot(cdp)) === false);
    const bytes = readFileSync(CP_FILE);
    const asKoi = new TextDecoder("koi8-r").decode(bytes);
    check("11. file on disk is now real KOI8-R bytes", asKoi === CP1251_TEXT, JSON.stringify(asKoi.slice(0, 30)));
    check("12. bytes are no longer the cp1251 layout", toCp1251(CP1251_TEXT).equals(bytes) === false);
    await key(cdp, "Escape"); // close the editor

    // ---- reopen: 1251 mojibake (the convert really changed the file)
    await cursorTo("cp1251.txt");
    await key(cdp, "F4");
    await waitFor(cdp, `!(document.querySelector(".cm-content")?.textContent ?? "").includes("Съёмный текст") ? 1 : ""`, 8000, "mojibake reopen");
    check("13. converted file re-opens as 1251 mojibake (bytes changed)", true);

    // ---- reload row restores the readable KOI8-R view
    await key(cdp, "F8");
    await sleep(250);
    await key(cdp, "ArrowDown"); // -> koi8-r
    await key(cdp, "Enter");
    await sleep(300);
    await key(cdp, "ArrowDown"); // action step: convert -> reload
    await key(cdp, "Enter");
    await waitFor(cdp, `(document.querySelector(".cm-content")?.textContent ?? "").includes("Съёмный текст") ? 1 : ""`, 8000, "koi8 reload");
    check("14. «Перечитать» re-decodes the file as KOI8-R", true);
    check("15. status select: koi8-r after reload", (await edSelect(cdp)) === "koi8-r");
    await key(cdp, "Escape");
  }

  {
    // ---- convert UTF-8 -> UTF-16LE (multi-byte save, no BOM expected)
    await cursorTo("u8.txt");
    await key(cdp, "F4");
    await waitFor(cdp, `(document.querySelector(".cm-content")?.textContent ?? "").includes("Юникодный текст") ? 1 : ""`, 8000, "utf8 auto decode");
    check("16. u8.txt opens readable as UTF-8", true);

    await key(cdp, "F8");
    await sleep(250);
    // cursor on utf-8 (idx 1) -> utf-16le (idx 2): one Down
    await key(cdp, "ArrowDown");
    await key(cdp, "Enter");
    await sleep(300);
    await key(cdp, "Enter"); // convert
    await sleep(400);
    check("17. convert to UTF-16LE keeps the text", (await cmText(cdp))?.includes("Юникодный текст") === true);
    await key(cdp, "F2");
    await sleep(700);
    const bytes = readFileSync(U8_FILE);
    check("18. file saved as UTF-16LE bytes with BOM", bytes.length === 2 + Buffer.byteLength(U8_TEXT, "utf16le") && bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])), `${bytes.length} bytes`);
    check("19. UTF-16LE bytes decode back to the text", new TextDecoder("utf-16le").decode(bytes.subarray(2)) === U8_TEXT);
    await key(cdp, "Escape");

    // reopen: the BOM must make the auto-detector pick UTF-16LE
    await cursorTo("u8.txt");
    await key(cdp, "F4");
    await waitFor(cdp, `(document.querySelector(".cm-content")?.textContent ?? "").includes("Юникодный текст") ? 1 : ""`, 8000, "utf16 reopen");
    check("20. converted file re-opens readable (BOM auto-detect)", true);
    check("21. status select: utf-16le", (await edSelect(cdp)) === "utf-16le", await edSelect(cdp));
    await key(cdp, "Escape");
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
