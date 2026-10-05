// E2E for 1.10.7 (alnavi-017) on the real Al-Navi exe via CDP: the copy/move
// progress window is centered. The overlay used to override .overlay with
// align-items:flex-end / justify-content:flex-start + paddings, planting the
// progress card in the bottom-left corner; the override must be gone on the
// real UI path too. Drives the app like a user: cd both panels through the
// command line, F5 on a 512MB file, Enter in the transfer dialog, then the
// progress dialog is frozen with the Pause button and its geometry measured
// against the viewport; Cancel + Close must return to the panels.
// Usage: node scripts/e2e-1-10-7.mjs <path-to-exe>
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: node scripts/e2e-1-10-7.mjs <exe>");
  process.exit(1);
}

const FIXT = join(tmpdir(), "alnavi-1107");
const ROOT = join(FIXT, "root");
const DEST = join(FIXT, "dest");
const CFG = join(process.env.APPDATA, "al-navi");
const PORT = 9239;
const profile = mkdtempSync(join(tmpdir(), "alnavi-1107-cdp-"));

// the app writes session/window/history state into the real config dir —
// back it up and restore afterwards so the E2E leaves no trace. window.json
// is pre-seeded with a sane 1280x800 geometry (CARDS/016 minimized leftover)
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

// 512MB so the copy outlives the CDP round-trips; frozen with Pause anyway
const BIG = 512 * 1024 * 1024;

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
    send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); },
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
    // without text:"\r" a CDP Enter carries no char and the implicit form
    // submission (the F5 transfer dialog's confirm path) never fires
    ...(k === "Enter" ? { text: "\r" } : {}),
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

// center deltas of the rendered dialog against the viewport (px, signed)
const dlgCenter = (cdp) => evalIn(cdp, `
  (() => {
    const ov = document.querySelector(".overlay");
    const dlg = ov?.querySelector(".dlg");
    if (!dlg) return null;
    const r = dlg.getBoundingClientRect();
    return {
      dx: Math.round(((r.left + r.right) / 2 - innerWidth / 2) * 10) / 10,
      dy: Math.round(((r.top + r.bottom) / 2 - innerHeight / 2) * 10) / 10,
      w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight,
      overlayStyle: ov.getAttribute("style") ?? "",
      hasBar: !!dlg.querySelector(".bar"),
      buttons: [...dlg.querySelectorAll(".dlg-actions .btn")].map((b) => b.textContent.trim()),
    };
  })()
`);

// wait until a progress dialog (with the progress bar) is rendered
async function waitForProgress(cdp, ms) {
  const t0 = Date.now();
  for (;;) {
    const g = await dlgCenter(cdp);
    if (g && g.hasBar) return g;
    if (Date.now() - t0 > ms) return null;
    await sleep(100);
  }
}

let child = null;
let cdp = null;
try {
  rmSync(FIXT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(DEST, { recursive: true });
  writeFileSync(join(ROOT, "big.bin"), Buffer.alloc(BIG));

  ({ child, cdp } = await launch());
  console.log("connected");

  // ---- 1. boot + version ----
  const ver = await evalIn(cdp, `document.querySelector(".version")?.textContent ?? ""`);
  check("1: version 1.10.7 in UI", /1\.10\.7/.test(ver ?? ""), ver);

  // ---- 2. both panels into the fixture: left=ROOT (active), right=DEST ----
  await cd(cdp, ROOT);
  await key(cdp, "Tab", { keyCode: 9 });
  await sleep(300);
  await cd(cdp, DEST);
  await key(cdp, "Tab", { keyCode: 9 });
  await sleep(300);
  if (!(await cursorTo(cdp, "big.bin"))) throw new Error("cursor not on big.bin");

  // ---- 3. F5 transfer dialog is centered ----
  await key(cdp, "F5", { keyCode: 116, code: "F5" });
  await sleep(700);
  let g = await dlgCenter(cdp);
  const hasInput = await evalIn(cdp, `!!document.querySelector(".overlay .dlg input")`);
  check("2: F5 transfer dialog opened", g !== null && hasInput === true, JSON.stringify(g));
  check("3: F5 transfer dialog centered (dx<=1, dy<=1)", g !== null && Math.abs(g.dx) <= 1 && Math.abs(g.dy) <= 1,
    g ? `dx=${g.dx} dy=${g.dy} dlg=${g.w}x${g.h} vp=${g.vw}x${g.vh}` : "no dialog");

  // ---- 4. Enter starts the copy; freeze the progress with Pause ----
  await key(cdp, "Enter", { keyCode: 13 });
  g = await waitForProgress(cdp, 15000);
  check("4: progress dialog appeared after Enter", g !== null, g ? "" : "no .dlg with .bar in 15s");
  if (g) {
    // pause first (buttons: pause | background | cancel) to freeze the op
    await evalIn(cdp, `[...document.querySelectorAll(".overlay .dlg-actions .btn")][0]?.click(); true`);
    await sleep(600);
    g = await dlgCenter(cdp);
    check("5: progress dialog centered (dx<=1, dy<=1)", g !== null && Math.abs(g.dx) <= 1 && Math.abs(g.dy) <= 1,
      g ? `dx=${g.dx} dy=${g.dy} dlg=${g.w}x${g.h} vp=${g.vw}x${g.vh}` : "dialog gone");
    check("6: overlay carries no corner override", g !== null && g.overlayStyle === "", g ? JSON.stringify(g.overlayStyle) : "no dialog");
    check("7: pause/background/cancel buttons rendered", g !== null && g.buttons.length === 3, g ? g.buttons.join("|") : "");

    // ---- 8. still centered after Cancel lands in the done state ----
    await evalIn(cdp, `[...document.querySelectorAll(".overlay .dlg-actions .btn")].at(-1)?.click(); true`);
    await sleep(1000);
    g = await dlgCenter(cdp);
    check("8: cancelled op keeps the (centered) result dialog", g !== null && Math.abs(g.dx) <= 1 && Math.abs(g.dy) <= 1,
      g ? `dx=${g.dx} dy=${g.dy} buttons=${g.buttons.join("|")}` : "dialog gone");
    if (g) {
      // Close returns to the panels with the caret in the command line
      await evalIn(cdp, `[...document.querySelectorAll(".overlay .dlg-actions .btn")].at(-1)?.click(); true`);
      await sleep(500);
    }
  }

  // ---- 9. back to the panels, cmdline owns the caret ----
  const after = await evalIn(cdp, `(() => ({
    overlayGone: !document.querySelector(".overlay"),
    isCmd: document.activeElement === document.querySelector(".cmdline input"),
  }))()`);
  check("9: Close returns to panels with the cmdline caret", after.overlayGone === true && after.isCmd === true, JSON.stringify(after));

  cdp.close();
} catch (e) {
  console.error("E2E error:", e);
  results.push({ name: "script completed", ok: false, info: String(e) });
} finally {
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  try { if (child) child.kill(); } catch { /* already gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { rmSync(FIXT, { recursive: true, force: true }); } catch {}
  restoreCfg();
  process.exit(fails ? 1 : 0);
}
