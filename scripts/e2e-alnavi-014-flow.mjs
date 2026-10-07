// Shared flow for the alnavi-014 SFTP e2e suites (dev + exe): drives the
// REAL app binary over CDP with real key presses against REAL local servers
// (python paramiko SFTP + pyftpdlib FTP, spawned on scratch ports with
// scratch roots). Covers the card criteria: sftp:// connect+list via the
// drive menu, F3 view, F4 edit+save, F7 mkdir, F5 copy (with progress
// dialog), conflict handling, F6 move, Shift+F6 rename, F8 delete, network
// error as a dialog with the app still responsive, FTP regression through
// the refactored remote engine, and sftp:// typed on the command line.
import { spawn, execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function connect(wsUrl) {
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
export async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
/** the dialogs + both panels — dumped into a waitFor timeout for debugging */
const stateDump = (cdp) => evalIn(cdp, `(() => ({
  dialogs: [...document.querySelectorAll(".overlay .dlg")].map(d => (d.querySelector(".dlg-title")?.textContent ?? "") + "|" + (d.querySelector(".dlg-body")?.textContent ?? "").slice(0, 120)),
  toast: document.querySelector(".toast")?.textContent ?? "",
  cmdline: document.querySelector(".cmdline input")?.value ?? null,
  L: { path: document.querySelector(".panel:not(.active) .crumbs")?.getAttribute("title"), rows: (document.querySelector(".panel:not(.active) .vlist")?.textContent ?? "").slice(0, 150) },
  R: { path: document.querySelector(".panel.active .crumbs")?.getAttribute("title"), rows: (document.querySelector(".panel.active .vlist")?.textContent ?? "").slice(0, 150) },
}))()`);

export async function waitFor(cdp, expr, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await evalIn(cdp, expr);
    if (v) return v;
    if (Date.now() - t0 > ms) {
      let dump = "";
      try { dump = JSON.stringify(await stateDump(cdp)).slice(0, 600); } catch {}
      throw new Error(`timeout waiting for ${label} :: ${dump}`);
    }
    await sleep(120);
  }
}

const VK = {
  Enter: 13, Escape: 27, Backspace: 8, Tab: 9, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  F2: 113, F4: 115, F5: 116, F7: 118, F8: 119,
};
const MOD = { alt: 1, ctrl: 2, shift: 8 };

export async function key(cdp, k, { ctrl = false } = {}) {
  const vk = VK[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
  const base = { key: k, code: k, windowsVirtualKeyCode: vk, modifiers: ctrl ? MOD.ctrl : 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(90);
}
export async function altKey(cdp, k) {
  // Alt as a separate down/up around the key — the reliable shape in both the
  // dev (vite) and exe harnesses
  const vk = VK[k] ?? k.toUpperCase().charCodeAt(0);
  await cdp.send("Input.dispatchKeyEvent", { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, modifiers: MOD.alt, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { key: k, code: k, windowsVirtualKeyCode: vk, modifiers: MOD.alt, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { key: k, code: k, windowsVirtualKeyCode: vk, modifiers: MOD.alt, type: "keyUp" });
  await cdp.send("Input.dispatchKeyEvent", { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, modifiers: 0, type: "keyUp" });
  await sleep(110);
}
/** Shift+key as a separate down/up around the key (like Alt) */
export async function shiftKey(cdp, k) {
  const vk = VK[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
  await cdp.send("Input.dispatchKeyEvent", { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: MOD.shift, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { key: k, code: k, windowsVirtualKeyCode: vk, modifiers: MOD.shift, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { key: k, code: k, windowsVirtualKeyCode: vk, modifiers: MOD.shift, type: "keyUp" });
  await cdp.send("Input.dispatchKeyEvent", { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0, type: "keyUp" });
  await sleep(110);
}

export async function digit(cdp, d) {
  const base = { key: d, code: "Digit" + d, windowsVirtualKeyCode: d.charCodeAt(0), modifiers: 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(110);
}
/** click the dialog's primary (OK/confirm) button with a real mouse event */
export async function clickPrimary(cdp) {
  const r = await evalIn(cdp, `(() => { const b = document.querySelector(".dlg-actions .btn.primary:not([disabled])") ?? document.querySelector(".dlg-actions .btn.primary"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!r) throw new Error("no primary button to click");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: r.x, y: r.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: r.x, y: r.y });
  await sleep(160);
}


/** name in the cursor row of the active panel */
export const cursorName = (cdp) => evalIn(cdp, `document.querySelector(".panel.active .row.cursor .name")?.textContent ?? null`);

/** walk the active panel with arrows until the cursor row is the named one */
export async function moveToName(cdp, name) {
  for (let i = 0; i < 80; i++) {
    const cur = await cursorName(cdp);
    if (cur === name) return;
    await key(cdp, "ArrowDown");
  }
  throw new Error(`moveToName(${name}) failed — cursor on ${await cursorName(cdp)}`);
}

export async function typeText(cdp, text) {
  await cdp.send("Input.insertText", { text });
  await sleep(140);
}

/** value of the focused input (typed-text verification) */
export const focusedValue = (cdp) => evalIn(cdp, `document.activeElement?.value ?? null`);

// panel path (the crumbs nav carries the full path in its title)
export const activePath = (cdp) => evalIn(cdp, `document.querySelector(".panel.active .crumbs")?.getAttribute("title") ?? ""`);
export const activeRows = (cdp) => evalIn(cdp, `document.querySelector(".panel.active .vlist")?.textContent ?? ""`);
export const dialogTitle = (cdp) => evalIn(cdp, `document.querySelector(".dlg .dlg-title")?.textContent ?? ""`);
export const dialogGone = (cdp) => evalIn(cdp, `document.querySelector(".overlay .dlg") ? "" : "gone"`);

/** spawn a test server and wait for its READY line */
export async function startServer(args, readyNeedle) {
  const child = spawn("python", args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });
  const t0 = Date.now();
  while (!out.includes(readyNeedle)) {
    if (Date.now() - t0 > 20000) throw new Error(`server not ready: ${args.join(" ")} — ${out.slice(0, 400)}`);
    await sleep(150);
  }
  return child;
}

/**
 * Run the full SFTP flow against the given exe. opts:
 *   cdpPort, workDir (scratch), sftpPort, ftpPort, check(name, ok, info)
 * The caller manages vite (the dev harness) — this flow only needs the exe.
 */
export async function runSftpFlow(EXE, opts) {
  const { cdpPort, work, sftpPort, ftpPort, check } = opts;
  const CFG = join(process.env.APPDATA, "al-navi");
  const sftpRoot = join(work, "sftp-root");
  const ftpRoot = join(work, "ftp-root");
  const localL = join(work, "local-left");
  const localR = join(work, "local-right");

  // ---- scratch servers + data ----
  mkdirSync(join(sftpRoot, "docs"), { recursive: true });
  mkdirSync(ftpRoot, { recursive: true });
  mkdirSync(localL, { recursive: true });
  mkdirSync(localR, { recursive: true });
  writeFileSync(join(sftpRoot, "hello.txt"), "hello from sftp test server\nline2\n");
  writeFileSync(join(sftpRoot, "docs", "one.txt"), "doc one\n");
  const big = Buffer.alloc(8 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big.write("e2e big bin chunk with some spread content ", i, "utf8");
  writeFileSync(join(sftpRoot, "big.bin"), big);
  writeFileSync(join(ftpRoot, "note.txt"), "ftp test file\n");
  writeFileSync(join(localL, "conflict.txt"), "local version\n");

  const sftp = await startServer([join("scripts", "test-servers", "sftp-server.py"), sftpRoot, String(sftpPort)], "SFTP READY");
  const ftp = await startServer([join("scripts", "test-servers", "ftp-server.py"), ftpRoot, String(ftpPort)], "FTP READY");

  // ---- config: backup real, seed sites + session + deterministic settings ----
  mkdirSync(CFG, { recursive: true });
  const backedUp = [];
  for (const f of readdirSync(CFG)) {
    if (f.endsWith(".e2e-bak")) continue;
    const p = join(CFG, f);
    cpSync(p, p + ".e2e-bak", { recursive: true });
    backedUp.push(p);
  }
  const restoreCfg = () => {
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
  };
  const SFTP_URL = `sftp://test@127.0.0.1:${sftpPort}`;
  const FTP_URL = `ftp://test@127.0.0.1:${ftpPort}`;
  writeFileSync(join(CFG, "ftp-sites.json"), JSON.stringify([
    { id: "e2esftp", name: "SFTP test", host: "127.0.0.1", port: sftpPort, user: "test", password: "test", secure: true, hotkey: "S" },
    { id: "e2eftp", name: "FTP test", host: "127.0.0.1", port: ftpPort, user: "test", password: "test", hotkey: "F" },
  ]));
  writeFileSync(join(CFG, "session.json"), JSON.stringify({ leftPath: localL, rightPath: localR, shortcuts: {}, splitRatio: 0.5 }));
  writeFileSync(join(CFG, "settings.json"), JSON.stringify({ confirmDelete: true }));

  let child = null;
  try {
    child = spawn(EXE, [], {
      env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: mkdtempSync(join(tmpdir(), "alnavi014-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}` },
      stdio: "ignore",
    });
    let wsUrl = null;
    for (let i = 0; i < 40; i++) {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`).catch(() => ({ json: async () => [] }))).json();
      wsUrl = list.find(t => t.type === "page")?.webSocketDebuggerUrl ?? null;
      if (wsUrl) break;
      await sleep(300);
    }
    if (!wsUrl) throw new Error("no CDP page");
    const cdp = connect(wsUrl);
    await cdp.ready;
    await waitFor(cdp, `!!document.querySelector(".panel.active .vlist")`, 20000, "panels booted");

    // ---- 1. drive menu shows the SFTP row with jump key 3 ----
    await altKey(cdp, "F2");
    await waitFor(cdp, `!!document.querySelector(".dlg-body.drives")`, 5000, "drives dialog");
    const sftpRow = await evalIn(cdp, `[...document.querySelectorAll(".dlg-body.drives .drive")].find(d => d.textContent.includes("SFTP"))?.textContent ?? ""`);
    check("drive menu has the SFTP row", /SFTP/.test(sftpRow), JSON.stringify(sftpRow));
    await digit(cdp, "3");

    // ---- 2. shared site list with scheme badges; Enter connects ----
    await waitFor(cdp, `[...document.querySelectorAll(".dlg .li")].some(li => li.textContent.includes("SFTP"))`, 5000, "site list");
    const rowsText = await evalIn(cdp, `[...document.querySelectorAll(".dlg .li")].map(li => li.textContent).join(" ~ ")`);
    check("site list shows SFTP and FTP sites with badges", rowsText.includes("SFTP test") && rowsText.includes("SFTP") && rowsText.includes("FTP test"), JSON.stringify(rowsText));
    await key(cdp, "Enter");
    await waitFor(cdp, `(document.querySelector(".panel.active .crumbs")?.getAttribute("title") ?? "").startsWith("${SFTP_URL}")`, 15000, "sftp panel connected");
    const p1 = await activePath(cdp);
    check("SFTP panel lists the jail root", p1 === SFTP_URL, p1);
    const rows1 = await activeRows(cdp);
    check("SFTP listing shows seeded entries", ["hello.txt", "big.bin", "docs"].every(n => rows1.includes(n)), rows1.slice(0, 120));

    // ---- 3. F3 viewer ----
    await moveToName(cdp, "hello.txt");
    await key(cdp, "F3");
    await waitFor(cdp, `document.querySelector(".viewer .cm-content")?.textContent.includes("hello from sftp") || document.querySelector(".viewer")?.textContent.includes("hello from sftp")`, 10000, "viewer text");
    check("F3 views the remote text file", true);
    await key(cdp, "Escape");

    // ---- 4. F4 edit + save round-trips to the server ----
    await waitFor(cdp, `!!document.querySelector(".panel.active .vlist")`, 5000, "back to panels");
    await key(cdp, "F4");
    await waitFor(cdp, `!!document.querySelector(".cm-editor") && document.activeElement?.classList?.contains("cm-content")`, 10000, "editor focused");
    await key(cdp, "End", { ctrl: true });
    await typeText(cdp, "\ne2e appended line");
    await key(cdp, "F2");
    await sleep(700);
    await key(cdp, "Escape");
    await waitFor(cdp, `!!document.querySelector(".panel.active .vlist")`, 5000, "back to panels 2");
    await key(cdp, "F4");
    const edited = await waitFor(cdp, `(document.querySelector(".cm-editor .cm-content")?.textContent ?? "").includes("e2e appended line")`, 10000, "saved content on reopen");
    check("F4 edit saved to the SFTP server", edited === true || !!edited);
    await key(cdp, "Escape");

    // ---- 5. F7 mkdir ----
    await waitFor(cdp, `!!document.querySelector(".panel.active .vlist")`, 5000, "back to panels 3");
    await key(cdp, "F7");
    await waitFor(cdp, `document.activeElement?.tagName === "INPUT"`, 5000, "mkdir input");
    await typeText(cdp, "e2e-dir");
    await clickPrimary(cdp);
    await waitFor(cdp, `(document.querySelector(".panel.active .vlist")?.textContent ?? "").includes("e2e-dir")`, 10000, "e2e-dir row");
    check("F7 creates a remote folder", true);

    // ---- 6. F5 download to the local panel (op queue + auto refresh) ----
    await moveToName(cdp, "hello.txt");
    await key(cdp, "F5");
    await waitFor(cdp, `document.activeElement?.tagName === "INPUT"`, 5000, "copy dialog");
    await clickPrimary(cdp);
    const t6 = Date.now();
    let sawProgress = false;
    while (Date.now() - t6 < 10000) {
      if (await evalIn(cdp, `!!document.querySelector(".overlay .dlg")`)) sawProgress = true;
      if (existsSync(join(localL, "hello.txt"))) break;
      await sleep(100);
    }
    check("F5 copies SFTP -> local via the op queue", existsSync(join(localL, "hello.txt")), sawProgress ? "progress dialog seen" : "fast copy");

    // ---- 7. local -> SFTP copy, then a conflict dialog on the repeat ----
    await key(cdp, "Tab"); // active = left local panel
    await moveToName(cdp, "conflict.txt");
    await key(cdp, "F5");
    await waitFor(cdp, `document.activeElement?.tagName === "INPUT"`, 5000, "upload dialog");
    await clickPrimary(cdp);
    await waitFor(cdp, `(document.querySelector(".panel.inactive .vlist")?.textContent ?? "").includes("conflict.txt")`, 15000, "uploaded row");
    check("F5 copies local -> SFTP", true);
    await key(cdp, "F5");
    await waitFor(cdp, `document.activeElement?.tagName === "INPUT"`, 5000, "upload dialog 2");
    await clickPrimary(cdp);
    const conflictShown = await waitFor(cdp, `!!document.querySelector(".dlg-title.warn")`, 8000, "conflict dialog");
    check("conflict dialog on overwrite", !!conflictShown || conflictShown === "");
    await clickPrimary(cdp); // default = overwrite
    await waitFor(cdp, `!document.querySelector(".dlg-title.warn")`, 10000, "conflict resolved");
    check("conflict overwrite completes", true);

    // ---- 8. F6 move SFTP -> local ----
    await key(cdp, "Tab"); // active = right sftp panel
    await moveToName(cdp, "big.bin");
    await key(cdp, "F6");
    await waitFor(cdp, `document.activeElement?.tagName === "INPUT"`, 5000, "move dialog");
    await clickPrimary(cdp);
    const t8 = Date.now();
    while (Date.now() - t8 < 30000) {
      const moved = existsSync(join(localL, "big.bin"));
      const rows = await activeRows(cdp);
      if (moved && !rows.includes("big.bin")) break;
      await sleep(200);
    }
    check("F6 moves big.bin off the server", existsSync(join(localL, "big.bin")) && !(await activeRows(cdp)).includes("big.bin"));

    // ---- 9. Shift+F6 remote rename ----
    await moveToName(cdp, "conflict.txt");
    await shiftKey(cdp, "F6");
    await waitFor(cdp, `document.activeElement?.tagName === "INPUT"`, 5000, "rename dialog");
    await typeText(cdp, "renamed-remote.txt");
    await clickPrimary(cdp);
    await waitFor(cdp, `(document.querySelector(".panel.active .vlist")?.textContent ?? "").includes("renamed-remote.txt")`, 10000, "renamed row");
    check("Shift+F6 renames on the server", true);

    // ---- 10. F8 remote delete ----
    // the rename re-sorts the panel — the cursor stays on a row index, not
    // on the file; walk it onto the renamed row before deleting
    await moveToName(cdp, "renamed-remote.txt");
    const delCur = await cursorName(cdp);
    check("cursor on the renamed row before F8", delCur === "renamed-remote.txt", String(delCur));
    await key(cdp, "F8");
    await waitFor(cdp, `!!document.querySelector(".overlay .dlg")`, 5000, "delete confirm");
    await clickPrimary(cdp);
    const t10 = Date.now();
    while (Date.now() - t10 < 15000) {
      if (!(await activeRows(cdp)).includes("renamed-remote.txt")) break;
      await sleep(150);
    }
    check("F8 deletes on the server", !(await activeRows(cdp)).includes("renamed-remote.txt"));

    // ---- 11. SFTP -> SFTP relay copy into docs ----
    await moveToName(cdp, "hello.txt");
    await key(cdp, "F5");
    await waitFor(cdp, `document.activeElement?.tagName === "INPUT"`, 5000, "relay dialog");
    await typeText(cdp, `${SFTP_URL}/docs`);
    await clickPrimary(cdp);
    await sleep(500);
    await moveToName(cdp, "docs");
    await key(cdp, "Enter");
    await waitFor(cdp, `(document.querySelector(".panel.active .vlist")?.textContent ?? "").includes("hello.txt")`, 15000, "relay result");
    check("F5 relays SFTP -> SFTP through a temp file", true);

    // ---- 12. network error: dialog, app stays responsive ----
    await altKey(cdp, "F2");
    await waitFor(cdp, `!!document.querySelector(".dlg-body.drives")`, 5000, "drives 2");
    await digit(cdp, "3");
    await waitFor(cdp, `[...document.querySelectorAll(".dlg .btn")].some(b => b.querySelector(".ph-bolt"))`, 5000, "quick connect btn");
    await evalIn(cdp, `[...document.querySelectorAll(".dlg .btn")].find(b => b.querySelector(".ph-bolt")).click()`);
    await waitFor(cdp, `!!document.getElementById("ftp-f-host")`, 5000, "site form");
    await evalIn(cdp, `(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      set("ftp-f-host", "127.0.0.1"); set("ftp-f-port", "2299"); set("ftp-f-user", "x"); set("ftp-f-pass", "x");
      return 1;
    })()`);
    // the form must be preset to SFTP by the drive-menu row 3
    const sftpPreset = await evalIn(cdp, `[...document.querySelectorAll(".scheme-toggle button")].findIndex(b => b.classList.contains("sel"))`);
    check("SFTP row presets the quick form to SFTP", sftpPreset === 1, `sel index ${sftpPreset}`);
    await evalIn(cdp, `document.querySelector("button.primary[type=submit]")?.click()`);
    // wait for the REAL error dialog (its title carries the err-t class), not
    // for the still-open form whose protocol toggle also says "SFTP"
    const errShown = await waitFor(cdp, `(document.querySelector(".dlg-title.err-t")?.closest(".dlg")?.textContent ?? "").slice(0, 200)`, 25000, "connect error dialog");
    check("dead port shows an SFTP error dialog", /SFTP/i.test(String(errShown)) && /refused|timed out|timeout|could not/i.test(String(errShown)), String(errShown).slice(0, 120));
    await clickPrimary(cdp); // its primary button is Close
    // the site form may still be open underneath — close it, then wait out any
    // late-arriving dialog from the same failed connect
    await key(cdp, "Escape");
    await sleep(2500);
    for (let i = 0; i < 5; i++) {
      const late = await evalIn(cdp, `!!document.querySelector(".dlg-title.err-t")`);
      if (!late) break;
      await clickPrimary(cdp);
      await sleep(600);
    }
    const dlgAfterErr = await evalIn(cdp, `[...document.querySelectorAll(".overlay .dlg")].map(d => d.querySelector(".dlg-title")?.textContent ?? "?").join(",") || "none"`);
    check("error dialog closed after Esc", dlgAfterErr === "none", dlgAfterErr);
    await altKey(cdp, "F1");
    const responsive = await waitFor(cdp, `!!document.querySelector(".dlg-body.drives")`, 5000, "drives after error");
    check("app stays responsive after the error", !!responsive || responsive === "");
    await key(cdp, "Escape");

    // ---- 13. FTP regression through the refactored remote engine ----
    await altKey(cdp, "F2");
    await waitFor(cdp, `!!document.querySelector(".dlg-body.drives")`, 5000, "drives 3");
    await digit(cdp, "2");
    await waitFor(cdp, `[...document.querySelectorAll(".dlg .li")].some(li => li.textContent.includes("FTP test"))`, 5000, "site list 2");
    await key(cdp, "ArrowDown");
    await key(cdp, "Enter");
    await waitFor(cdp, `(document.querySelector(".panel.active .crumbs")?.getAttribute("title") ?? "").startsWith("${FTP_URL}")`, 15000, "ftp panel");
    const ftpRows = await activeRows(cdp);
    check("FTP panel lists note.txt (regression)", ftpRows.includes("note.txt"), ftpRows.slice(0, 80));
    await moveToName(cdp, "note.txt");
    await key(cdp, "F5");
    await waitFor(cdp, `document.activeElement?.tagName === "INPUT"`, 5000, "ftp copy dialog");
    await clickPrimary(cdp);
    const t13 = Date.now();
    while (Date.now() - t13 < 15000) {
      if (existsSync(join(localL, "note.txt"))) break;
      await sleep(150);
    }
    check("F5 copies FTP -> local (regression)", existsSync(join(localL, "note.txt")));
    await sleep(1500);
    const dlgAfterFtp = await evalIn(cdp, `[...document.querySelectorAll(".overlay .dlg")].map(d => (d.querySelector(".dlg-title")?.textContent ?? "?") + ":" + (d.querySelector(".dlg-body")?.textContent ?? "").slice(0, 60)).join(" || ") || "none"`);
    check("no dialog after the FTP copy", dlgAfterFtp === "none", dlgAfterFtp);

    // ---- 14. sftp:// typed on the command line ----
    {
      // the server must still answer a full SFTP handshake at this point of
      // the run (a plain TCP probe says nothing about a wedged accept loop)
      const py = "import paramiko\n" +
        `t = paramiko.Transport(('127.0.0.1', ${sftpPort}))\n` +
        "t.connect(username='test', password='test')\n" +
        "s = paramiko.SFTPClient.from_transport(t)\n" +
        "print(len(s.listdir('/')))\n" +
        "t.close()";
      const alive = await new Promise((res) => {
        execFile("python", ["-c", py], { timeout: 15000 }, (e, out) => res(!e && /\d+/.test(out ?? "")));
      });
      check("SFTP server still answers a handshake before the cmdline step", alive);
    }
    const dlgBeforeType = await evalIn(cdp, `[...document.querySelectorAll(".overlay .dlg")].map(d => d.querySelector(".dlg-title")?.textContent ?? "?").join(",") || "none"`);
    check("no dialog before the cmdline type", dlgBeforeType === "none", dlgBeforeType);
    await typeText(cdp, `${SFTP_URL}/docs`);
    // trace which backend commands the cmdline run actually issues
    await evalIn(cdp, `(() => {
      const orig = window.__TAURI_INTERNALS__.invoke;
      window.__e2e_invokes = [];
      window.__TAURI_INTERNALS__.invoke = function (cmd, args) {
        if (cmd.startsWith("sftp") || cmd.startsWith("ftp")) window.__e2e_invokes.push([cmd, JSON.stringify(args)]);
        return orig.apply(this, arguments);
      };
    })()`);
    await key(cdp, "Enter");
    await sleep(1200);
    console.log("cmdline invokes:", await evalIn(cdp, `JSON.stringify(window.__e2e_invokes ?? [])`));
    await waitFor(cdp, `(document.querySelector(".panel.active .crumbs")?.getAttribute("title") ?? "") === "${SFTP_URL}/docs"`, 15000, "cmdline sftp url");
    const rows14 = await activeRows(cdp);
    check("command line opens sftp:// URLs", rows14.includes("one.txt") && rows14.includes("hello.txt"), rows14.slice(0, 80));
  } finally {
    if (child) child.kill();
    for (const s of [sftp, ftp]) { try { s.kill(); } catch {} }
    await sleep(800);
    restoreCfg();
  }
}
