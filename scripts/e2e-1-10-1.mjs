// Real-exe E2E for 1.10.1: Ctrl+Shift+Insert on ".." copies the panel's own
// directory path. Drives the built exe over CDP (isolated WEBVIEW2_USER_DATA_FOLDER;
// %APPDATA%\al-navi is snapshotted/restored because cd lands in the histories).
// The clipboard is read from the Node side via PowerShell Get-Clipboard — the
// page's navigator.clipboard.readText is focus-dependent in the WebView — and
// the user's clipboard text is restored afterwards (best effort, text only).
// Usage: node scripts/e2e-1-10-1.mjs [path-to-exe]
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const exe = process.argv[2] || join(dirname(dirname(fileURLToPath(import.meta.url))), "src-tauri", "target", "release", "al-navi.exe");
const PORT = 9230;
const profile = mkdtempSync(join(tmpdir(), "alnavi-cdp-"));
const work = mkdtempSync(join(tmpdir(), "alnavi-cp-"));
const CFG = join(process.env.APPDATA, "al-navi");
const SNAP_FILES = ["cmd-history.json", "dir-history.json", "session.json", "window.json"];
const snap = {};
for (const f of SNAP_FILES) {
  const p = join(CFG, f);
  snap[f] = existsSync(p) ? readFileSync(p, "utf8") : null;
}
const restoreCfg = () => {
  for (const f of SNAP_FILES) {
    const p = join(CFG, f);
    try {
      if (snap[f] === null) { if (existsSync(p)) rmSync(p); }
      else writeFileSync(p, snap[f]);
    } catch (e) { console.error("restore failed for", f, e.message); }
  }
};

// best-effort clipboard snapshot (text only)
let clipBackup = null;
try { clipBackup = execSync("powershell -NoProfile -Command Get-Clipboard", { encoding: "utf8" }); } catch {}
const restoreClip = () => {
  if (clipBackup === null || clipBackup === "") return; // was empty/non-text — nothing sane to restore
  try {
    execSync("powershell -NoProfile -Command \"$input | Set-Clipboard\"", { input: clipBackup });
  } catch (e) { console.error("clipboard restore failed:", e.message); }
};
const getClip = () => {
  try { return execSync("powershell -NoProfile -Command Get-Clipboard", { encoding: "utf8" }); } catch { return null; }
};
const norm = (s) => s.trim().replace(/\\+$/, "").toLowerCase();

writeFileSync(join(work, "sample.txt"), "e2e");

let child = null;
const launch = () => {
  child = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
    detached: false,
  });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(150);
  }
}

async function findTarget(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && !t.url.startsWith("about:"));
      if (page) return page;
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
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}

// CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8
async function key(cdp, { key: k, code, keyCode, ctrl = false, shift = false, alt = false, up = false }) {
  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0) | (alt ? 1 : 0);
  await cdp.send("Input.dispatchKeyEvent", {
    key: k, code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
    type: up ? "keyUp" : "keyDown",
  });
}
const press = (cdp, k, opts = {}) => key(cdp, { ...k, ...opts, up: false }).then(() => key(cdp, { ...k, ...opts, up: true }));
// Ctrl+Shift+Insert — the chord under test
const pressCopyPaths = (cdp) =>
  press(cdp, { key: "Insert", code: "Insert", keyCode: 45, ctrl: true, shift: true });

async function typeLine(cdp, text) {
  await cdp.send("Input.insertText", { text });
  await press(cdp, { key: "Enter", code: "Enter", keyCode: 13 });
}

const cursorRow = (cdp) => evalIn(cdp, `document.querySelector(".panel.active .row.cursor")?.textContent?.replace(/\\s+/g, " ").trim() ?? ""`);

try {
  launch();
  const target = await findTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  console.log(`connected: ${target.title ?? target.url}`);
  await sleep(2000);

  // ---- boot + version ----
  const boot = await evalIn(cdp, `(() => ({
    tauri: !!window.__TAURI_INTERNALS__,
    version: (document.body.textContent.match(/1\\.10\\.1/) || [])[0] ?? null,
  }))()`);
  check("app booted with real backend", !!boot?.tauri, JSON.stringify(boot));
  check("version 1.10.1 in UI", boot?.version === "1.10.1");

  // ---- cd the panel to the work dir ----
  await typeLine(cdp, `cd ${work}`);
  await sleep(900);
  const crumb = await evalIn(cdp, `document.querySelector(".panel.active .crumbs")?.textContent ?? ""`);
  check("cd to work dir", crumb.toUpperCase().includes("ALNAVI-CP"), crumb.slice(0, 60));

  // ============================================================
  // Ctrl+Shift+Insert on ".." — the dir path itself
  // ============================================================
  await press(cdp, { key: "Home", code: "Home", keyCode: 36 });
  await sleep(200);
  const upRow = await cursorRow(cdp);
  check("cursor on '..'", upRow.startsWith(".."), upRow.slice(0, 30));
  await pressCopyPaths(cdp);
  await sleep(400);
  let clip = getClip();
  check("'..' copies the panel dir path", norm(String(clip)) === norm(work),
    JSON.stringify({ got: clip?.trim(), want: work }));

  // ============================================================
  // on a regular file — its full path (unchanged behavior)
  // ============================================================
  await press(cdp, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
  await sleep(200);
  const fileRow = await cursorRow(cdp);
  check("cursor on sample.txt", fileRow.includes("sample.txt"), fileRow.slice(0, 30));
  await pressCopyPaths(cdp);
  await sleep(400);
  clip = getClip();
  check("file row still copies the file path", norm(String(clip)) === norm(join(work, "sample.txt")),
    JSON.stringify(clip?.trim()));

  // ============================================================
  // marked file wins over ".." (FAR semantics)
  // ============================================================
  await press(cdp, { key: "Insert", code: "Insert", keyCode: 45 }); // mark sample.txt
  await sleep(200);
  await press(cdp, { key: "Home", code: "Home", keyCode: 36 });
  await sleep(200);
  check("back on '..'", (await cursorRow(cdp)).startsWith(".."));
  await pressCopyPaths(cdp);
  await sleep(400);
  clip = getClip();
  check("marked file wins over '..'", norm(String(clip)) === norm(join(work, "sample.txt")),
    JSON.stringify(clip?.trim()));

  cdp.close();
} catch (e) {
  check("script ran", false, String(e));
} finally {
  try { child?.kill(); } catch {}
  restoreCfg();
  restoreClip();
  setTimeout(() => {
    try { rmSync(work, { recursive: true, force: true }); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }, 800);
  setTimeout(() => process.exit(results.filter((r) => !r.ok).length ? 1 : 0), 1500);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
