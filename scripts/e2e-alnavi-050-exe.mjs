// E2E alnavi-050 (release exe): copying/moving onto an existing name froze
// the app — the op:conflict event could beat the copy_paths/move_paths
// invoke response, the store dropped the dialog request while it still held
// the -1 placeholder id, and the Rust side blocked on its answer forever.
// On the real shipped exe with REAL files on disk (no mocks):
//   1. exe boots with the pinned version
//   2. left/ holds a.txt b.txt c.txt, right/ already has a.txt (the conflict)
//   3. F5 copy a.txt -> the conflict dialog OPENS (pre-fix: eternal freeze
//      with the progress stuck in scan); «Копировать ↩» overwrites:
//      right/a.txt gets the new body
//   4. F5 copy b.txt -> Esc answers skip: right/b.txt never appears,
//      left/b.txt stays
//   5. F5 copy c.txt -> «Переименовать» answers rename: right/c (1).txt
//   6. F6 move a.txt -> Esc answers skip: both sides keep their a.txt
// The real config dir is backed up and restored afterwards (like 048/049).
// Usage: node scripts/e2e-alnavi-050-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.14.15";
const CDP_PORT = 9268;
const CFG = join(process.env.APPDATA, "al-navi");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// real config backup + restore (the typed `cd`s land in cmd-history.json)
const bak = mkdtempSync(join(tmpdir(), "alnavi-050-cfgbak-"));
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

// the real files the exe copies/moves: left/ is the source panel, right/
// already holds a.txt — copying a.txt onto it is the user's freeze scenario
const work = mkdtempSync(join(tmpdir(), "alnavi-050-"));
const left = join(work, "left");
const right = join(work, "right");
mkdirSync(left); mkdirSync(right);
writeFileSync(join(left, "a.txt"), "alpha-body");
writeFileSync(join(left, "b.txt"), "beta-body");
writeFileSync(join(left, "c.txt"), "gamma-body");
writeFileSync(join(right, "a.txt"), "old-a-body");
// every copied name must already exist on the right for a conflict to arise
writeFileSync(join(right, "b.txt"), "old-b-body");
writeFileSync(join(right, "c.txt"), "old-c-body");

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
  return {
    ready, events,
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
const waitFs = async (fn, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
};
async function key(cdp, def) {
  await cdp.send("Input.dispatchKeyEvent", { ...def, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...def, type: "keyUp" });
  await sleep(150);
}
const tab = (cdp) => key(cdp, { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
const f5 = (cdp) => key(cdp, { key: "F5", code: "F5", windowsVirtualKeyCode: 116 });
const f6 = (cdp) => key(cdp, { key: "F6", code: "F6", windowsVirtualKeyCode: 117 });
const esc = (cdp) => key(cdp, { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
// `text` on keyDown lets the browser run the default action — the cd command
const enter = (cdp) => key(cdp, { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
const type = (cdp, t) => cdp.send("Input.insertText", { text: t });

const cursorName = (cdp) => evalIn(cdp, `document.querySelector(".row.cursor .name")?.textContent ?? null`);
const activeCrumbs = `document.querySelector(".panel.active .crumbs")?.textContent ?? ""`;
const passiveCrumbs = `document.querySelector(".panel:not(.active) .crumbs")?.textContent ?? ""`;
// a CDP-synthesized Enter does not click buttons (e2e-smoke lesson): click
async function clickBtn(cdp, expr) {
  const r = await evalIn(cdp, `(() => { const b = ${expr}; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!r) throw new Error("no button to click");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: r.x, y: r.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: r.x, y: r.y });
  await sleep(200);
}
const clickPrimary = (cdp) => clickBtn(cdp, `document.querySelector(".dlg-actions .btn.primary")`);
const clickRenameBtn = (cdp) => clickBtn(cdp, `[...document.querySelectorAll(".dlg-actions button")][4]`);

// cursor to a row by name (Home first: the refreshed view may reset it)
async function cursorTo(cdp, name) {
  await key(cdp, { key: "Home", code: "Home", windowsVirtualKeyCode: 36 });
  for (let i = 0; i < 8 && (await cursorName(cdp)) !== name; i++) {
    await key(cdp, { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  }
  return cursorName(cdp);
}
// F5/F6 on the file under the cursor: the input dialog opens prefilled with
// the passive panel + the file name; the primary button starts the transfer
async function startTransfer(cdp, fn) {
  await fn(cdp);
  const pref = await waitFor(cdp, `document.querySelector(".dlg input")?.value ?? null`, 5000, "transfer dialog");
  await clickPrimary(cdp);
  return pref;
}

let child = null;
let cdpRef = null;
// dump the DOM + console state when a step fails: which dialog is up, what
// the button row looks like, any backend/console error — enough to tell a
// dead click from a failed copy
async function dumpState(where) {
  const dom = await evalIn(cdpRef, `(() => ({
    warn: !!document.querySelector(".dlg-title.warn"),
    dlgTitle: document.querySelector(".dlg-title")?.textContent ?? null,
    btns: [...document.querySelectorAll(".dlg-actions button")].map((b) => b.className + ":" + b.textContent),
    progressPhase: document.querySelector(".dlg .phase, .dlg .status")?.textContent ?? null,
    progressText: document.querySelector(".dlg")?.textContent?.replace(/\\s+/g, " ").slice(0, 200) ?? null,
    inner: [window.innerWidth, window.innerHeight],
    primaryRect: (() => { const b = document.querySelector(".dlg-actions .btn.primary"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })(),
    elAtCenter: (() => { const b = document.querySelector(".dlg-actions .btn.primary"); if (!b) return "no button"; const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el ? (el.tagName + "." + el.className) : "nothing"; })(),
    activeEl: document.activeElement ? (document.activeElement.tagName + "." + document.activeElement.className) : "none",
    clickProp: (() => { const b = document.querySelector(".dlg-actions .btn.primary"); if (!b) return "no button"; const syms = Object.getOwnPropertySymbols(b).map((s) => s.description + "=" + Object.keys(b[s] ?? {}).join(",")); return syms.length ? syms.join(" | ") : "no symbols"; })(),
    themeBtnSyms: (() => { const b = document.querySelector(".titlebar .btn, header .btn"); if (!b) return "no theme btn"; return Object.getOwnPropertySymbols(b).map((s) => s.description + "=" + Object.keys(b[s] ?? {}).join(",")).join(" | ") || "no symbols"; })(),
    rootHears: window.__rootHearsClick ?? "not probed",
  }))()`).catch((e) => `dom eval failed: ${e.message}`);
  const errors = cdpRef.events.filter((e) =>
    (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") ||
    (e.method === "Runtime.exceptionThrown") ||
    (e.method === "Log.entryAdded" && e.params.entry.level === "error"),
  ).map((e) => e.method === "Log.entryAdded" ? e.params.entry.text : (e.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" "));
  console.error(`DUMP @ ${where}:`, JSON.stringify(dom));
  if (errors.length) console.error("CONSOLE ERRORS:", errors.join(" | "));
  try {
    console.error("right/a.txt =", existsSync(join(right, "a.txt")) ? JSON.stringify(readFileSync(join(right, "a.txt"), "utf8")) : "(missing)");
  } catch { /* work dir may be gone */ }
}
try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-050-webview-"));
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
  await cdp.send("Log.enable");
  cdpRef = cdp;
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await sleep(3500);
  await waitFor(cdp, `!!document.querySelector(".cmdline input")`, 15000, "app UI");
  await sleep(1500); // settle: panels load, settings apply

  const version = (await evalIn(cdp, `(document.querySelector(".version")?.textContent ?? "").trim()`));
  check(`2. title bar pins v${VERSION_PIN}`, version.includes(VERSION_PIN), version || "(none)");

  // park the panels: active on left/, passive on right/
  await evalIn(cdp, `document.querySelector(".cmdline input").focus(); true`);
  await type(cdp, `cd "${left}"`);
  await enter(cdp); await sleep(1200);
  await waitFor(cdp, `(${activeCrumbs}).toLowerCase().includes("left") ? true : null`, 8000, "left panel cd");
  await tab(cdp);
  await type(cdp, `cd "${right}"`);
  await enter(cdp); await sleep(1200);
  await waitFor(cdp, `(${activeCrumbs}).toLowerCase().includes("right") && (${passiveCrumbs}).toLowerCase().includes("left") ? true : null`, 8000, "right panel cd");
  await tab(cdp); // back to left/
  check("3. panels parked: left/ active, right/ passive", true);

  // ---- A: F5 copy a.txt onto the existing right/a.txt — THE freeze scenario
  await cursorTo(cdp, "a.txt");
  const prefA = await startTransfer(cdp, f5);
  check("4. F5 dialog prefilled with right/ + a.txt", /right/i.test(prefA) && /a\.txt/i.test(prefA), prefA);
  // pre-fix: the op:conflict event lost the race to the invoke response, the
  // dialog never opened and the progress hung in "scan" forever
  const confA = await waitFor(cdp, `(() => { const t = document.querySelector(".dlg-title.warn"); if (!t) return null; const paths = [...document.querySelectorAll(".dlg .path")].map((p) => p.textContent); return { src: paths[0], dst: paths[1] }; })()`, 8000, "conflict dialog");
  check("5. conflict dialog opens (no freeze) with the a.txt pair",
    /a\.txt/i.test(confA.src ?? "") && /a\.txt/i.test(confA.dst ?? ""), `${confA.src} -> ${confA.dst}`);
  await clickPrimary(cdp); // «Копировать ↩» = overwrite — ONE answer must be
  // enough: transfer_one used to ask a second time via copy_one_file (the
  // dialog popped back open right after the click), fixed with
  // copy_one_file_no_conflict — waitFs below fails if the dialog ever returns
  let overwritten;
  try {
    overwritten = await waitFs(() =>
      existsSync(join(right, "a.txt")) && readFileSync(join(right, "a.txt"), "utf8") === "alpha-body", 10000, "right/a.txt overwritten");
  } catch (e) {
    await dumpState("overwrite click");
    throw e;
  }
  check("6. overwrite lands: right/a.txt carries the new body", overwritten, readFileSync(join(right, "a.txt"), "utf8"));
  await waitFor(cdp, `!document.querySelector(".overlay .dlg")`, 8000, "progress overlay closed");

  // ---- B: F5 copy b.txt, Esc answers skip
  await cursorTo(cdp, "b.txt");
  await startTransfer(cdp, f5);
  await waitFor(cdp, `!!document.querySelector(".dlg-title.warn")`, 8000, "conflict dialog (b.txt)");
  await esc(cdp);
  await waitFor(cdp, `!document.querySelector(".overlay .dlg")`, 8000, "progress overlay closed (skip)");
  check("7. Esc skips: right/b.txt keeps its old body, left/b.txt kept",
    existsSync(join(right, "b.txt")) && readFileSync(join(right, "b.txt"), "utf8") === "old-b-body" && existsSync(join(left, "b.txt")),
    readFileSync(join(right, "b.txt"), "utf8"));

  // ---- C: F5 copy c.txt, «Переименовать» answers rename
  await cursorTo(cdp, "c.txt");
  await startTransfer(cdp, f5);
  await waitFor(cdp, `!!document.querySelector(".dlg-title.warn")`, 8000, "conflict dialog (c.txt)");
  await clickRenameBtn(cdp);
  const renamed = await waitFs(() =>
    existsSync(join(right, "c (1).txt")) && readFileSync(join(right, "c (1).txt"), "utf8") === "gamma-body", 10000, "right/c (1).txt");
  check("8. rename answer lands as right/c (1).txt, source kept", renamed && existsSync(join(left, "c.txt")));
  await waitFor(cdp, `!document.querySelector(".overlay .dlg")`, 8000, "progress overlay closed (rename)");

  // ---- D: F6 move a.txt onto the existing right/a.txt, Esc answers skip
  await cursorTo(cdp, "a.txt");
  await startTransfer(cdp, f6);
  await waitFor(cdp, `!!document.querySelector(".dlg-title.warn")`, 8000, "conflict dialog (move)");
  await esc(cdp);
  await waitFor(cdp, `!document.querySelector(".overlay .dlg")`, 8000, "progress overlay closed (move skip)");
  check("9. move skip: left/a.txt kept, right/a.txt untouched",
    existsSync(join(left, "a.txt")) && readFileSync(join(right, "a.txt"), "utf8") === "alpha-body");

  child.kill();
} catch (e) {
  console.error("SUITE ERROR:", e.message);
  if (child) child.kill();
} finally {
  await sleep(500);
  child?.kill();
  try { child?.kill(); } catch { /* already gone */ }
  restoreCfg();
  if (results.every((r) => r.ok)) rmSync(work, { recursive: true, force: true });
  else console.log("work dir kept:", work);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
