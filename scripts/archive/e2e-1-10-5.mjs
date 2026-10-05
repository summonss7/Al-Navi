// E2E for 1.10.5 on the real Al-Navi exe via CDP: the editor status bar shows
// the character under the caret (decimal + hex code point — ASCII for Latin,
// Unicode for cyrillic) and the document totals (characters / lines / spaces),
// the totals follow live typing, and F2-save + Esc keep working. Drives the
// real UI: command line navigation, F4 to edit, arrow/End keys, insertText.
// Usage: node scripts/e2e-1-10-5.mjs <path-to-exe>
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: node scripts/e2e-1-10-5.mjs <exe>");
  process.exit(1);
}

const FIXT = join(tmpdir(), "alnavi-1105");
const ROOT = join(FIXT, "root");
const CFG = join(process.env.APPDATA, "al-navi");
const PORT = 9236;
const profile = mkdtempSync(join(tmpdir(), "alnavi-1105-cdp-"));

// the app writes session/window/history/editor state into the real config
// dir — back it up and restore afterwards so the E2E leaves no trace.
// window.json is additionally pre-seeded with a sane 1280x800 geometry: the
// user's real one may hold a minimized-window leftover (181x24 @ -32000),
// which would make any layout check meaningless
const backedUp = [];
for (const f of ["session.json", "window.json", "dir-history.json", "xfer-history.json", "editor-state.json", "view-history.json"]) {
  const p = join(CFG, f);
  if (existsSync(p)) {
    cpSync(p, p + ".e2e-bak");
    backedUp.push(p);
  }
}
writeFileSync(join(CFG, "window.json"), JSON.stringify({ x: 80, y: 60, w: 1280, h: 800, maximized: false }));
function restoreCfg() {
  for (const p of backedUp) cpSync(p + ".e2e-bak", p);
}

const DOC1 = "Hello World\nLine 2"; // 18 chars, 2 lines, 2 spaces
const DOC2 = "Привет, мир!\nвторая строка"; // 26 chars, 2 lines, 2 spaces

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

async function launch() {
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
    detached: false,
  });
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && !t.url.startsWith("about:"));
      if (page) {
        const cdp = await connect(page.webSocketDebuggerUrl);
        await cdp.ready;
        await sleep(2500);
        return { child, cdp };
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("CDP target not found");
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
    send(method, params = {}) {
      return new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}

async function key(cdp, k, opts = {}) {
  const base = {
    key: k,
    code: opts.code ?? k,
    windowsVirtualKeyCode: opts.keyCode,
    nativeVirtualKeyCode: opts.keyCode,
    modifiers: (opts.alt ? 1 : 0) | (opts.ctrl ? 2 : 0) | (opts.shift ? 8 : 0),
  };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

// navigate the active panel through the command line
async function cd(cdp, dir) {
  await evalIn(cdp, `(() => {
    const inp = document.querySelector(".cmdline input");
    inp.focus();
    inp.value = ${JSON.stringify("cd " + dir)};
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await key(cdp, "Enter", { keyCode: 13 });
  await sleep(700);
}

async function cursorName(cdp) {
  return evalIn(cdp, `document.querySelector(".panel.active .vlist .row.cursor .name")?.getAttribute("title") ?? null`);
}
async function cursorTo(cdp, name, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const cur = await cursorName(cdp);
    if (cur === name) return true;
    await key(cdp, "ArrowDown", { keyCode: 40 });
    await sleep(60);
  }
  return false;
}

// status bar snapshot; settle waits out the 300ms caret tracker
async function bar(cdp, settle = 450) {
  await sleep(settle);
  return evalIn(cdp, `(() => {
    const bar = document.querySelector(".ed-status:not(.top)");
    if (!bar) return null;
    return {
      chip: bar.querySelector(".char-chip")?.textContent ?? null,
      totals: bar.querySelector(".totals")?.textContent ?? null,
      overflow: bar.scrollWidth - bar.clientWidth,
    };
  })()`);
}

// totals hold exactly three numbers (chars/lines/spaces); the labels follow
// the user's locale, so compare the numbers only (labels covered by dev E2E)
const nums = (t) => JSON.stringify(((t ?? "").match(/\d+/g) ?? []).map(Number));

let child = null;
let cdp = null;
try {
  rmSync(FIXT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "a.txt"), DOC1, "utf8");
  writeFileSync(join(ROOT, "rus.txt"), DOC2, "utf8");

  ({ child, cdp } = await launch());
  console.log("connected");

  // ---- 1. boot + version ----
  const ver = await evalIn(cdp, `document.querySelector(".version")?.textContent ?? ""`);
  check("version 1.10.5 in UI", /1\.10\.5/.test(ver ?? ""), ver);

  // ---- 2. open a.txt in the editor (F4) ----
  await cd(cdp, ROOT);
  if (!(await cursorTo(cdp, "a.txt"))) throw new Error("cursor not on a.txt");
  await key(cdp, "F4", { keyCode: 115 });
  await sleep(900);
  let s = await bar(cdp);
  check("F4 opened the editor with totals 18/2/2", nums(s?.totals) === "[18,2,2]", JSON.stringify(s?.totals));
  check("chip at caret 0: 'H' 72 0x48", (s?.chip ?? "").includes("'H' 72 0x48"), JSON.stringify(s?.chip));

  // ---- 3. arrow to 'W' ----
  for (let i = 0; i < 6; i++) await key(cdp, "ArrowRight", { keyCode: 39 });
  s = await bar(cdp);
  check("after 6x Right the chip is 'W' 87 0x57", (s?.chip ?? "").includes("'W' 87 0x57"), JSON.stringify(s?.chip));

  // ---- 4. End of line 1 -> newline under the caret ----
  await key(cdp, "End", { keyCode: 35 });
  s = await bar(cdp);
  check("End: newline escaped as '\\\\n' 10 0x0A", (s?.chip ?? "").includes("'\\n' 10 0x0A"), JSON.stringify(s?.chip));

  // ---- 5. Ctrl+End -> doc end, chip falls back to the last char ----
  await key(cdp, "End", { keyCode: 35, ctrl: true });
  s = await bar(cdp);
  check("Ctrl+End: chip on '2' 50 0x32", (s?.chip ?? "").includes("'2' 50 0x32"), JSON.stringify(s?.chip));

  // ---- 6. live typing updates the totals ----
  await cdp.send("Input.insertText", { text: " !" });
  s = await bar(cdp, 350);
  check("after typing ' !': totals 20/2/3", nums(s?.totals) === "[20,2,3]", JSON.stringify(s?.totals));

  // ---- 7. F2 saves, Esc returns to the panels ----
  await key(cdp, "F2", { keyCode: 113 });
  await sleep(600);
  await key(cdp, "Escape", { keyCode: 27 });
  await sleep(600);
  const backToPanels = await evalIn(cdp, `!!document.querySelector(".panel.active")`);
  check("F2 + Esc: saved and back to panels", backToPanels === true, "");

  // ---- 8. cyrillic file: Unicode code point ----
  if (!(await cursorTo(cdp, "rus.txt"))) throw new Error("cursor not on rus.txt");
  await key(cdp, "F4", { keyCode: 115 });
  s = await bar(cdp, 900);
  check("rus.txt totals 26/2/2", nums(s?.totals) === "[26,2,2]", JSON.stringify(s?.totals));
  check("chip at caret 0: 'П' 1055 0x41F", (s?.chip ?? "").includes("'П' 1055 0x41F"), JSON.stringify(s?.chip));
  check("status bar does not overflow", (s?.overflow ?? 1) <= 1, `overflow=${s?.overflow}`);

  await key(cdp, "Escape", { keyCode: 27 });
  cdp.close();
} catch (e) {
  check("script ran", false, String(e));
} finally {
  if (child) child.kill();
  restoreCfg();
  setTimeout(() => {
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    try { rmSync(FIXT, { recursive: true, force: true }); } catch {}
  }, 800);
}

const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
