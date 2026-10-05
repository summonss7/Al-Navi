// Real-exe E2E for 1.10.2: a failed delete names the process that holds the
// file/folder. Drives the built exe over CDP (isolated WEBVIEW2_USER_DATA_FOLDER;
// %APPDATA%\al-navi snapshotted/restored because cd lands in the histories).
// Holders are real PowerShell processes keeping files open with an exclusive
// share: one blocks F8-to-trash on a single file, one blocks Shift+Del on a
// folder through a file inside it. (A process CWD no longer blocks folder
// deletion on this Windows, so that path is not UI-drivable here.)
// Usage: node scripts/e2e-1-10-2.mjs [path-to-exe]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const exe = process.argv[2] || join(dirname(dirname(fileURLToPath(import.meta.url))), "src-tauri", "target", "release", "al-navi.exe");
const PORT = 9232;
const profile = mkdtempSync(join(tmpdir(), "alnavi-cdp-"));
const work = mkdtempSync(join(tmpdir(), "alnavi-lock-"));
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

// a real process keeping `file` open with no sharing allowed
const holders = [];
const holdFile = (file) => {
  const ps = ` $f=[IO.File]::Open('${file.replace(/'/g, "''")}','Open','Read','None'); Start-Sleep -Seconds 180`;
  holders.push(spawn("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore", windowsHide: true }));
};

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

async function key(cdp, { key: k, code, keyCode, shift = false, up = false }) {
  const modifiers = shift ? 8 : 0;
  await cdp.send("Input.dispatchKeyEvent", {
    key: k, code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
    type: up ? "keyUp" : "keyDown",
  });
}
const press = (cdp, k, opts = {}) => key(cdp, { ...k, ...opts, up: false }).then(() => key(cdp, { ...k, ...opts, up: true }));
const pressF8 = (cdp) => press(cdp, { key: "F8", code: "F8", keyCode: 119 });
const pressShiftDelete = (cdp) =>
  press(cdp, { key: "Delete", code: "Delete", keyCode: 46, shift: true });

async function typeLine(cdp, text) {
  await cdp.send("Input.insertText", { text });
  await press(cdp, { key: "Enter", code: "Enter", keyCode: 13 });
}

const cursorRow = (cdp) => evalIn(cdp, `document.querySelector(".panel.active .row.cursor")?.textContent?.replace(/\\s+/g, " ").trim() ?? ""`);

// Home, then ArrowDown until the cursor row shows `name` (rows: ".." + sorted)
async function navigateTo(cdp, name) {
  await press(cdp, { key: "Home", code: "Home", keyCode: 36 });
  await sleep(150);
  for (let i = 0; i < 30; i++) {
    const row = await cursorRow(cdp);
    if (row.includes(name)) return row;
    await press(cdp, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
    await sleep(120);
  }
  throw new Error(`row not found: ${name}`);
}

// F8/Shift+Del -> confirm dialog -> click the focused Yes button (synthetic
// Enter doesn't activate focused buttons in the WebView — see e2e-1.7.1)
async function confirmDelete(cdp, pressKey) {
  await pressKey();
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".dlg .dlg-actions .btn.primary")`), 4000, "confirm dialog");
  await sleep(150);
  await evalIn(cdp, `document.querySelector(".dlg .dlg-actions .btn.primary")?.click()`);
}

// wait for the op to finish and return the error lines shown in the dialog
async function opErrors(cdp) {
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".dlg .errs .err")`), 20000, "delete error line");
  return evalIn(cdp, `[...document.querySelectorAll(".dlg .errs .err")].map((e) => e.textContent).join(" | ")`);
}

async function closeDialog(cdp) {
  await evalIn(cdp, `[...document.querySelectorAll(".dlg .dlg-actions .btn")].pop()?.click()`);
  await sleep(400);
}

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
    version: (document.body.textContent.match(/1\\.10\\.2/) || [])[0] ?? null,
  }))()`);
  check("app booted with real backend", !!boot?.tauri, JSON.stringify(boot));
  check("version 1.10.2 in UI", boot?.version === "1.10.2");

  // ---- cd the panel to the work dir ----
  await typeLine(cdp, `cd ${work}`);
  await sleep(900);
  const crumb = await evalIn(cdp, `document.querySelector(".panel.active .crumbs")?.textContent ?? ""`);
  check("cd to work dir", crumb.toUpperCase().includes("ALNAVI-LOCK"), crumb.slice(0, 60));

  // ============================================================
  // A) held FILE -> trash: the error names the holding process
  // ============================================================
  const heldFile = join(work, "a-held.txt");
  writeFileSync(heldFile, "held");
  holdFile(heldFile);
  await sleep(1500); // let the holder open the file
  const rowA = await navigateTo(cdp, "a-held.txt");
  check("cursor on a-held.txt", rowA.includes("a-held.txt"), rowA.slice(0, 40));
  await confirmDelete(cdp, () => pressF8(cdp));
  const errA = String(await opErrors(cdp));
  check("file error names the holder", /held by:/i.test(errA) && /powershell/i.test(errA) && /pid \d+/i.test(errA), errA.slice(0, 220));
  check("file error keeps the raw trash error and only appends the holder",
    /operations were aborted/i.test(errA) && /held by:/i.test(errA), errA.slice(0, 120));
  await closeDialog(cdp);

  // ============================================================
  // B) folder with a HELD FILE INSIDE -> permanent delete: the
  //    remove_dir_all error (os error 32) names the holder via the
  //    remaining-files sweep
  // ============================================================
  const heldDir = join(work, "z-held-dir");
  mkdirSync(heldDir);
  writeFileSync(join(heldDir, "gone.txt"), "deletable");
  const inner = join(heldDir, "inner.txt");
  writeFileSync(inner, "held");
  holdFile(inner);
  await sleep(1500); // let the holder open the file
  const rowB = await navigateTo(cdp, "z-held-dir");
  check("cursor on z-held-dir", rowB.includes("z-held-dir"), rowB.slice(0, 40));
  await confirmDelete(cdp, () => pressShiftDelete(cdp));
  const errB = String(await opErrors(cdp));
  check("folder error names the holder of the file inside",
    /held by:/i.test(errB) && /powershell/i.test(errB) && /pid \d+/i.test(errB), errB.slice(0, 220));
  check("folder still exists (delete really failed)", existsSync(heldDir) && existsSync(inner));
  await closeDialog(cdp);

  // ============================================================
  // C) a normal delete is unaffected: no error, file gone
  // ============================================================
  writeFileSync(join(work, "plain.txt"), "bye");
  await sleep(300);
  await navigateTo(cdp, "plain.txt");
  await confirmDelete(cdp, () => pressF8(cdp));
  await sleep(1500);
  const gone = !existsSync(join(work, "plain.txt"));
  const noErr = await evalIn(cdp, `!document.querySelector(".dlg .errs .err")`);
  check("plain delete succeeds silently", gone && noErr, JSON.stringify({ gone, noErr }));
  const stillHeld = existsSync(heldFile) && existsSync(heldDir);
  check("held targets untouched by their failed deletes", stillHeld);

  cdp.close();
} catch (e) {
  check("script ran", false, String(e));
} finally {
  try { child?.kill(); } catch {}
  for (const h of holders) { try { h.kill(); } catch {} }
  restoreCfg();
  // holders need a moment to drop their handles before cleanup
  setTimeout(() => {
    try { rmSync(work, { recursive: true, force: true }); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }, 1200);
  setTimeout(() => process.exit(results.filter((r) => !r.ok).length ? 1 : 0), 2000);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
