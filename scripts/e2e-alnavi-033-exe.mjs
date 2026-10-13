// Exe-level E2E for alnavi-033: in the REAL released exe (1.14.1) the
// Alt+F7 search dialog must prefill the folder from the CURRENT panel, not
// from the last executed search. The bug: the persisted search-history.json
// root (e.g. a stale C:\Windows) won over whatever panel the user was
// looking at. Against the real backend:
//   - the real config is backed up and search-history.json is seeded with
//     root C:\Windows + mask/text from an old search
//   - cd the active panel to D:\Al-Navi, Alt+F7: root = D:\Al-Navi, NOT
//     C:\Windows; the old mask still restores (only the folder follows the
//     panel)
//   - Tab, cd the other panel to C:\ , Alt+F7: root = C:\ (the panel
//     folder — NOT the stale C:\Windows it was prefixed by)
//   - the prefilled root survives untouched in the field (submit is not
//     exercised here — the dev variant covers the full start chain)
// Usage: node scripts/e2e-alnavi-033-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.14.1";
const CFG = join(process.env.APPDATA, "al-navi");
const CDP_PORT = 9266;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// the stale last search the bug reproduced on: root C:\Windows
const SEED = {
  root: "C:\\Windows", mask: "*mts*", text: "Al-Navi",
  useRegex: false, textCaseSensitive: false,
  dateFrom: null, dateTo: null, sizeFrom: null, sizeTo: null, findDirs: true,
};

// seed search-history.json (real config is backed up / restored)
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
      // files the run created (e.g. a fresh search-history.json) go away
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

const VK = { Enter: 13, Escape: 27, Tab: 9, F7: 118 };
async function key(cdp, k, { alt = false } = {}) {
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k], modifiers: alt ? 1 : 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(150);
}
async function typeLine(cdp, text) {
  await cdp.send("Input.insertText", { text });
  await sleep(120);
  await key(cdp, "Enter");
}
const dialogState = `(() => ({
  open: !!document.getElementById("search-form"),
  root: document.getElementById("sr-f-root")?.value ?? null,
  mask: document.getElementById("sr-f-mask")?.value ?? null,
}))()`;

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: mkdtempSync(join(tmpdir(), "alnavi-033-exe-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "ignore",
});
try {
  // seed the stale search BEFORE the app reads search-history.json
  writeFileSync(join(CFG, "search-history.json"), JSON.stringify(SEED));

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

  // active (left) panel -> D:\Al-Navi
  await typeLine(cdp, "cd D:\\Al-Navi");
  await waitFor(cdp, `(document.querySelector(".panel.active .crumbs")?.textContent ?? "").toLowerCase().includes("al-navi") ? 1 : ""`, 8000, "cd D:\\Al-Navi");

  await key(cdp, "F7", { alt: true });
  await sleep(600);
  let dlg = await evalIn(cdp, dialogState);
  check("3. Alt+F7 opened the dialog", !!dlg?.open, JSON.stringify(dlg));
  check("4. root = the active panel folder (D:\\Al-Navi), not the stale C:\\Windows",
    dlg?.root === "D:\\Al-Navi", `root=${dlg?.root}`);
  check("5. the last search's mask still restores", dlg?.mask === "*mts*", `mask=${dlg?.mask}`);
  await key(cdp, "Escape");

  // switch panels; the right one -> C:\
  await key(cdp, "Tab");
  await typeLine(cdp, "cd C:\\");
  await waitFor(cdp, `(document.querySelector(".panel.active .crumbs")?.textContent ?? "").includes("C:") ? 1 : ""`, 8000, "cd C:\\");

  await key(cdp, "F7", { alt: true });
  await sleep(600);
  dlg = await evalIn(cdp, dialogState);
  check("6. root follows the other panel too (C:\\ — not its stale subtree C:\\Windows)",
    dlg?.root === "C:\\", `root=${dlg?.root}`);
  await key(cdp, "Escape");

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
