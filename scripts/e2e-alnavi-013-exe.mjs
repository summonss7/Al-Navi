// Exe E2E for alnavi-013: lazy editor/viewer chunks + lazy CodeMirror grammars
// on the real release binary (custom-protocol build) over CDP.
//   - startup fetches neither the CodeMirror core chunk nor the editor/viewer
//     areas (panel boot stays lean)
//   - F4 on a .rs file opens the editor, pulls the rust grammar on demand and
//     colorizes — text renders right away, no console errors
//   - Esc closes the editor back to the panels
//   - F3 on a .json file drives the same lazy path in the read-only viewer
//   - the title bar carries the expected release version
// File operations run in a temp sandbox; the app's real config
// (%APPDATA%\al-navi) is backed up and restored afterwards.
// Usage: node scripts/e2e-alnavi-013-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const EXPECT_VERSION = "1.14.3";
const CFG = join(process.env.APPDATA, "al-navi");
const CDP_PORT = 9266;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// ---- sandbox: a dir with a rust file and a json file
const work = mkdtempSync(join(tmpdir(), "alnavi013"));
const left = join(work, "left");
mkdirSync(left);
writeFileSync(join(left, "main.rs"), 'fn main() {\n    let answer = 42; // the answer\n    println!("hello {}", answer);\n}\n');
writeFileSync(join(left, "config.json"), '{\n  "retries": 3,\n  "tags": ["a", "b"],\n  "verbose": true\n}\n');

// the app writes settings/window state into the real config dir — back it up
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
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    events.push(msg);
  };
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  return {
    ready, events,
    send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); },
    close: () => ws.close(),
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
    const v = await evalIn(cdp, expr);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
};

const VK = { Escape: 27, Tab: 9, Home: 36, ArrowDown: 40, F3: 114, F4: 115 };
async function key(cdp, k) {
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k] ?? 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(150);
}
async function typeLine(cdp, text) {
  await cdp.send("Input.insertText", { text });
  await sleep(120);
  await key(cdp, "Enter");
}
async function clickAt(cdp, x, y) {
  const base = { x, y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  await sleep(300);
}
async function clickEl(cdp, expr) {
  const r = await evalIn(cdp, `(() => { const el = ${expr}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
  if (!r) return false;
  await clickAt(cdp, r.x, r.y);
  return true;
}

const activeCrumbs = `document.querySelector(".panel.active .crumbs")?.textContent ?? ""`;
const cursorRow = `document.querySelector(".panel.active .row.cursor")?.textContent ?? ""`;
const marks = `document.querySelectorAll('.cm-content span[class^="ͼ"]').length`;
const assetJs = `performance.getEntriesByType("resource").filter((e) => /\\/assets\\/.*\\.js/.test(e.name)).length`;

let child = null;
try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi013wv"));
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
  const cdp = connect(wsUrl);
  await cdp.ready;
  await sleep(3500);
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await waitFor(cdp, `!!document.querySelector(".panel, .panels")`, 15000, "app UI");
  await clickEl(cdp, `document.querySelector(".panel")`);

  const boot = await evalIn(cdp, `(() => ({
    tauri: !!window.__TAURI_INTERNALS__,
    version: (document.querySelector(".version")?.textContent ?? "").trim(),
    panels: document.querySelectorAll(".panel").length,
  }))()`);
  check("2. booted with the real backend, two panels", boot?.tauri && boot?.panels === 2, JSON.stringify(boot));
  check(`3. release version ${EXPECT_VERSION} in the title bar`, (boot?.version ?? "").includes(EXPECT_VERSION), boot?.version ?? "(none)");

  // ---- startup graph: no CodeMirror core / editor / viewer chunks
  const bootHeavy = await evalIn(cdp, `performance.getEntriesByType("resource").filter((e) => /\\/assets\\/(cm-|EditorArea|ViewerArea)/.test(e.name)).map((e) => e.name.split("/").pop()).join(",")`);
  check("4. startup fetched no cm/editor/viewer chunk", bootHeavy === "", bootHeavy || "(clean)");
  const bootAssets = await evalIn(cdp, assetJs);

  // ---- cd to the sandbox and open main.rs in the editor
  await evalIn(cdp, `document.querySelector(".cmdline input")?.focus(); true`);
  await typeLine(cdp, `cd ${left}`);
  await waitFor(cdp, `(${activeCrumbs}).toLowerCase().includes("left") ? ${activeCrumbs} : ""`, 8000, "panel cd");
  // walk the cursor onto main.rs (files sort after ..; config.json < main.rs)
  await key(cdp, "Home");
  for (let i = 0; i < 5; i++) {
    const row = await evalIn(cdp, cursorRow);
    if (/main\.rs/i.test(row)) break;
    await key(cdp, "ArrowDown");
  }
  const rsRow = await evalIn(cdp, cursorRow);
  check("5. cursor parked on main.rs", /main\.rs/i.test(rsRow), rsRow.replace(/\s+/g, " ").slice(0, 40));

  await key(cdp, "F4");
  const t0 = Date.now();
  await waitFor(cdp, `document.querySelector(".cm-content")?.textContent.includes("the answer") ? 1 : ""`, 15000, "editor text");
  const textMs = Date.now() - t0;
  await waitFor(cdp, `(${marks}) > 0 ? 1 : ""`, 15000, "rust syntax marks");
  check("6. F4 editor: text renders, rust grammar colorizes on demand", true, `text=${textMs}ms, marks=${await evalIn(cdp, marks)}`);
  const editorAssets = await evalIn(cdp, assetJs);
  check("7. F4 pulled new JS chunks (editor area + cm core + grammar)", editorAssets > bootAssets, `assets ${bootAssets} -> ${editorAssets}`);

  await key(cdp, "Escape");
  await waitFor(cdp, `!!document.querySelector(".panel.active")`, 8000, "back to panels");
  check("8. Esc closes the editor back to the panels", true);

  // ---- F3 viewer on config.json
  await key(cdp, "Home");
  for (let i = 0; i < 5; i++) {
    const row = await evalIn(cdp, cursorRow);
    if (/config\.json/i.test(row)) break;
    await key(cdp, "ArrowDown");
  }
  await key(cdp, "F3");
  await waitFor(cdp, `document.querySelector(".cm-content")?.textContent.includes("retries") ? 1 : ""`, 15000, "viewer text");
  await waitFor(cdp, `(${marks}) > 0 ? 1 : ""`, 15000, "json syntax marks");
  check("9. F3 viewer: text renders, json grammar colorizes", true, `marks=${await evalIn(cdp, marks)}`);

  // ---- console stayed clean through the lazy loads
  const errs = cdp.events.filter((e) =>
    (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") ||
    (e.method === "Runtime.exceptionThrown") ||
    (e.method === "Log.entryAdded" && e.params.entry.level === "error"),
  );
  check("10. no console errors / uncaught exceptions", errs.length === 0, errs.map((e) => e.method === "Log.entryAdded" ? `${e.params.entry.url ?? ""} ${e.params.entry.text}` : JSON.stringify(e.params.args?.[0]?.value ?? e.params)).slice(0, 3).join(" | "));
} catch (e) {
  check("script completed without harness errors", false, String(e));
} finally {
  if (child) child.kill();
  await sleep(600);
  restoreCfg();
  rmSync(work, { recursive: true, force: true });
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
}
