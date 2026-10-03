// E2E for 1.10.4 on the real Al-Navi exe via CDP: entering a folder puts the
// cursor on ".." (both bug faces: old numeric position, and a same-named
// nested entry), leaving a folder puts the cursor on the exited folder's row,
// and Ctrl+R still keeps the cursor on its entry.
// Usage: node scripts/e2e-1-10-4.mjs <path-to-exe>
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: node scripts/e2e-1-10-4.mjs <exe>");
  process.exit(1);
}

const FIXT = join(tmpdir(), "alnavi-1104");
const ROOT = join(FIXT, "root");
const CFG = join(process.env.APPDATA, "al-navi");
const PORT = 9235;
const profile = mkdtempSync(join(tmpdir(), "alnavi-1104-cdp-"));

// the app writes session/window/dir history into the real config dir —
// back it up and restore afterwards so the E2E leaves no trace
const backedUp = [];
for (const f of ["session.json", "window.json", "dir-history.json", "xfer-history.json"]) {
  const p = join(CFG, f);
  if (existsSync(p)) {
    cpSync(p, p + ".e2e-bak");
    backedUp.push(p);
  }
}
function restoreCfg() {
  for (const p of backedUp) cpSync(p + ".e2e-bak", p);
}

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
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const ready = new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws error"));
  });
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
    code: k,
    windowsVirtualKeyCode: opts.keyCode,
    nativeVirtualKeyCode: opts.keyCode,
    modifiers: (opts.alt ? 1 : 0) | (opts.ctrl ? 2 : 0) | (opts.shift ? 8 : 0),
  };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}
const kEnter = (cdp) => key(cdp, "Enter", { keyCode: 13 });
const kDown = (cdp) => key(cdp, "ArrowDown", { keyCode: 40 });
const kPgUpCtrl = (cdp) => key(cdp, "PageUp", { keyCode: 33, ctrl: true });
const kCtrlR = (cdp) => key(cdp, "r", { keyCode: 82, ctrl: true });

// navigate the active panel through the command line
async function cd(cdp, dir) {
  await evalIn(cdp, `(() => {
    const inp = document.querySelector(".cmdline input");
    inp.focus();
    inp.value = ${JSON.stringify("cd " + dir)};
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await kEnter(cdp);
  await sleep(700);
}

async function cursorName(cdp) {
  return evalIn(cdp, `document.querySelector(".panel.active .vlist .row.cursor .name")?.getAttribute("title") ?? null`);
}
async function rows(cdp) {
  return evalIn(cdp, `[...document.querySelectorAll(".panel.active .vlist .row .name")].map(n => n.getAttribute("title"))`);
}
async function crumb(cdp) {
  return evalIn(cdp, `[...document.querySelectorAll(".panel.active .crumbs .crumb")].map(c => c.textContent.trim()).join(" / ")`);
}

// move the panel cursor onto a row by name (wraps, assumes sorted view)
async function cursorTo(cdp, name, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const cur = await cursorName(cdp);
    if (cur === name) return true;
    await kDown(cdp);
    await sleep(60);
  }
  return false;
}

let child = null;
let cdp = null;
try {
  // fixture: "target" sits at listing index 3 (the old bug left the cursor
  // there after entering -> "c.txt"); "loop" holds a nested "loop" (the old
  // by-name carryover landed exactly on it)
  rmSync(FIXT, { recursive: true, force: true });
  for (const d of ["root/alpha", "root/loop/loop", "root/target"]) mkdirSync(join(FIXT, d), { recursive: true });
  for (const f of ["aa.txt", "mm.txt", "zz.txt"]) writeFileSync(join(ROOT, f), f);
  writeFileSync(join(ROOT, "loop", "x.txt"), "x");
  for (const f of ["a", "b", "c", "d", "e", "f"]) writeFileSync(join(ROOT, "target", f + ".txt"), f);

  ({ child, cdp } = await launch());
  console.log("connected");

  // ---- 1. boot + version ----
  const ver = await evalIn(cdp, `document.querySelector(".version")?.textContent ?? ""`);
  check("version 1.10.4 in UI", /1\.10\.4/.test(ver ?? ""), ver);

  // ---- 2. cd to the fixture root ----
  await cd(cdp, ROOT);
  let r = await rows(cdp);
  check("fixture root listed", (r ?? []).includes("target") && (r ?? []).includes("loop") && (r ?? []).includes("mm.txt"), JSON.stringify(r));

  // ---- 3. Enter a dir from a deep position -> cursor on ".." ----
  if (!(await cursorTo(cdp, "target"))) throw new Error("cursor not on target");
  const targetIdx = (await rows(cdp)).indexOf("target");
  await kEnter(cdp);
  await sleep(800);
  r = await rows(cdp);
  const c3 = await cursorName(cdp);
  check("Enter: dir entered", (r ?? []).includes("c.txt") && (await crumb(cdp)).includes("target"), `rows=${JSON.stringify(r)}`);
  check("Enter: cursor on '..' (old bug: same index -> '" + (r ?? [])[targetIdx] + "')", c3 === "..", `cursor=${c3}`);

  // ---- 4. Enter on '..' -> back, cursor on the exited folder ----
  await kEnter(cdp);
  await sleep(800);
  const c4 = await cursorName(cdp);
  check("Enter on '..': cursor back on 'target'", c4 === "target", `cursor=${c4}`);

  // ---- 5. same-name trap: nested 'loop' must not capture the cursor ----
  if (!(await cursorTo(cdp, "loop"))) throw new Error("cursor not on loop");
  await kEnter(cdp);
  await sleep(800);
  const c5 = await cursorName(cdp);
  r = await rows(cdp);
  check("nested dir entered", (r ?? []).includes("x.txt") && (await crumb(cdp)).includes("loop"), `rows=${JSON.stringify(r)}`);
  check("Enter: cursor on '..', not on nested 'loop'", c5 === "..", `cursor=${c5}`);

  // ---- 6. Ctrl+PgUp -> cursor on the exited folder ----
  await kPgUpCtrl(cdp);
  await sleep(800);
  const c6 = await cursorName(cdp);
  check("Ctrl+PgUp: cursor on 'loop'", c6 === "loop", `cursor=${c6}`);

  // ---- 7. Ctrl+R keeps the cursor on its entry ----
  if (!(await cursorTo(cdp, "mm.txt"))) throw new Error("cursor not on mm.txt");
  await kCtrlR(cdp);
  await sleep(800);
  const c7 = await cursorName(cdp);
  check("Ctrl+R: cursor stays on 'mm.txt'", c7 === "mm.txt", `cursor=${c7}`);

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
