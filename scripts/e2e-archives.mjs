// E2E for M6 archives + window memory on the real Al-Navi exe via CDP.
// Usage: node scripts/e2e-m6.mjs <path-to-exe>
// Covers: entering zip/tar.gz/tar/7z as folders, cp866 zip names, F3 inside
// archives, Alt+F6 unpack, Alt+F5 pack (zip + 7z), F5 out of an archive,
// F5/F6 INTO an archive (append + move), read-only guards, window size memory.
import { spawn, execSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: node scripts/e2e-m6.mjs <exe>");
  process.exit(1);
}

const FIXT = "C:\\Users\\CUSTOM\\AppData\\Local\\Temp\\alnavi-m6";
const SRC = join(FIXT, "src");
const OUT = join(FIXT, "out");
const OUT2 = join(FIXT, "out2");
const CFG = join(process.env.APPDATA, "al-navi");

const PORT = 9224;
const profile = mkdtempSync(join(tmpdir(), "alnavi-m6-cdp-"));

// the app writes session/window/xfer history into the real config dir —
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

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
const exists = (p) => { try { statSync(p); return true; } catch { return false; } };

let child = null;
async function launch() {
  child = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
    detached: false,
  });
  const target = await findTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await sleep(2500);
  return cdp;
}

async function findTarget(retries = 40) {
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
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text + " " + JSON.stringify(r.result.exceptionDetails.exception?.description ?? "").slice(0, 300) };
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
const FKEYS = { F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119 };
const kEnter = (cdp) => key(cdp, "Enter", { keyCode: 13 });
const kEsc = (cdp) => key(cdp, "Escape", { keyCode: 27 });
const kDown = (cdp) => key(cdp, "ArrowDown", { keyCode: 40 });
const kUp = (cdp) => key(cdp, "ArrowUp", { keyCode: 38 });
const kPgUpCtrl = (cdp) => key(cdp, "PageUp", { keyCode: 33, ctrl: true });
const kIns = (cdp) => key(cdp, "Insert", { keyCode: 45 });

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

async function rows(cdp) {
  return evalIn(cdp, `[...document.querySelectorAll(".panel.active .vlist .row .name")].map(n => n.getAttribute("title"))`);
}
async function cursorName(cdp) {
  return evalIn(cdp, `document.querySelector(".panel.active .vlist .row.cursor .name")?.getAttribute("title") ?? null`);
}
async function crumb(cdp) {
  return evalIn(cdp, `[...document.querySelectorAll(".panel.active .crumbs .crumb")].map(c => c.textContent.trim()).join(" / ")`);
}
async function toastText(cdp) {
  return evalIn(cdp, `document.querySelector(".toast")?.textContent ?? null`);
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

// dialog helpers (ONE dialog action per evaluate — batches hang)
async function setDialogInput(cdp, value) {
  return evalIn(cdp, `(() => {
    const inp = document.querySelector(".dlg input:not([type=checkbox])");
    if (!inp) return null;
    inp.focus();
    inp.value = ${JSON.stringify(value)};
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
}
async function dialogOpen(cdp) {
  return evalIn(cdp, `!!document.querySelector(".dlg")`);
}
async function clickDialogBtn(cdp, label) {
  return evalIn(cdp, `(() => {
    const btns = [...document.querySelectorAll(".dlg .dlg-actions .btn")];
    const b = btns.find(x => x.textContent.trim() === ${JSON.stringify(label)}) || btns[btns.length - 1];
    b?.click();
    return !!b;
  })()`);
}
async function clickPackFormat(cdp, idx) {
  return evalIn(cdp, `document.querySelectorAll(".dlg .variants .li")[${idx}]?.click() ?? false`);
}

// wait until a node-side predicate passes
async function waitFor(predicate, timeoutMs, label = "") {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return true;
    await sleep(400);
  }
  return false;
}

async function waitOpDone(cdp) {
  // the progress dialog auto-closes ~600ms after a clean finish
  for (let i = 0; i < 60; i++) {
    const open = await dialogOpen(cdp);
    if (!open) return true;
    await sleep(500);
  }
  return false;
}

function tree(root) {
  const out = [];
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { out.push(prefix + e.name + "/"); walk(p, prefix + e.name + "/"); }
      else out.push(prefix + e.name);
    }
  };
  walk(root, "");
  return out.sort();
}

try {
  // fresh out dirs + extra fixture files for the append/move scenarios;
  // also clean archives a previous E2E run may have dropped in the fixture root
  rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
  rmSync(OUT2, { recursive: true, force: true }); mkdirSync(OUT2, { recursive: true });
  rmSync(join(FIXT, "packed.zip"), { force: true });
  rmSync(join(FIXT, "packed7.7z"), { force: true });
  rmSync(join(FIXT, "verify-zip"), { recursive: true, force: true });
  writeFileSync(join(SRC, "toadd.bin"), Buffer.from("payload-to-add-12345"));
  writeFileSync(join(SRC, "tomove.bin"), Buffer.from("payload-to-move-6789"));
  // 'старый русский зип\r\nвторая строка\r\n' in cp866
  const CP866_BODY = Buffer.from("e1e2a0e0eba920e0e3e1e1aaa8a920a7a8af0d0aa2e2aee0a0ef20e1e2e0aeaaa00d0a", "hex");

  const cdp = await launch();
  console.log("connected");

  // ---- 1. boot + version ----
  const boot = await evalIn(cdp, `(() => ({ tauri: !!window.__TAURI_INTERNALS__, panels: document.querySelectorAll(".panel").length }))()`);
  check("app booted", !!boot?.tauri && boot.panels >= 1, JSON.stringify(boot));
  const ver = await evalIn(cdp, `document.querySelector(".version")?.textContent ?? ""`);
  check("version 1.9.0 in UI", /1\.9\.0/.test(ver ?? ""), ver);

  // ---- 2. navigate to the fixture root ----
  await cd(cdp, FIXT);
  let r = await rows(cdp);
  check("fixture root listed", (r ?? []).includes("ref.zip") && (r ?? []).includes("src"), JSON.stringify(r));

  // ---- 3. Enter opens a zip as a folder ----
  if (!(await cursorTo(cdp, "ref.zip"))) throw new Error("cursor not on ref.zip");
  await kEnter(cdp);
  await sleep(900);
  r = await rows(cdp);
  let cr = await crumb(cdp);
  check("Enter enters zip", (r ?? []).includes("readme.txt") && (r ?? []).includes("sub dir") && (cr ?? "").includes("ref.zip"),
    `crumb=${cr}; rows=${JSON.stringify(r)}`);
  // (PowerShell Compress-Archive skips empty folders, so ref.zip has no
  // "empty dir" entry at all — dir synthesis is covered by the cp866 zip)

  // ---- 4. navigate inner dirs, Ctrl+PgUp back ----
  await cursorTo(cdp, "sub dir");
  await kEnter(cdp);
  await sleep(700);
  r = await rows(cdp);
  check("inner dir listing", (r ?? []).includes("beta.bin") && (r ?? []).includes("inner"), JSON.stringify(r));
  await kPgUpCtrl(cdp);
  await sleep(500);
  r = await rows(cdp);
  check("Ctrl+PgUp to archive root", (r ?? []).includes("readme.txt"), JSON.stringify(r));
  await kPgUpCtrl(cdp);
  await sleep(700);
  cr = await crumb(cdp);
  check("Ctrl+PgUp steps out to disk", !(cr ?? "").includes("archive") && (cr ?? "").includes("alnavi-m6"), cr);

  // ---- 5. F3 views a member ----
  await cursorTo(cdp, "ref.zip");
  await kEnter(cdp);
  await sleep(700);
  await cursorTo(cdp, "readme.txt");
  await key(cdp, "F3", { keyCode: FKEYS.F3 });
  await sleep(1200);
  const viewText = await evalIn(cdp, `document.querySelector(".viewer, [class*=viewer]")?.textContent ?? document.body.textContent`);
  check("F3 opens member in viewer", /hello archive/.test(viewText ?? ""), "");
  await kEsc(cdp);
  await sleep(600);
  await kPgUpCtrl(cdp);
  await sleep(500);

  // ---- 6. cp866 zip names decode ----
  await cursorTo(cdp, "ref-cp866.zip");
  await kEnter(cdp);
  await sleep(900);
  r = await rows(cdp);
  check("cp866 member name decoded", (r ?? []).includes("привет cp866.txt"), JSON.stringify(r));
  check("cp866 dir synthesized", (r ?? []).includes("dir866"), JSON.stringify(r));
  await kPgUpCtrl(cdp);
  await sleep(500);

  // ---- 7. tar.gz and tar listing ----
  await cursorTo(cdp, "ref.tgz");
  await kEnter(cdp);
  await sleep(900);
  r = await rows(cdp);
  check("tar.gz enters", (r ?? []).includes("readme.txt") && (r ?? []).includes("sub dir"), JSON.stringify(r));
  await kPgUpCtrl(cdp);
  await sleep(500);
  await cursorTo(cdp, "ref.tar");
  await kEnter(cdp);
  await sleep(900);
  r = await rows(cdp);
  check("tar enters", (r ?? []).includes("readme.txt"), JSON.stringify(r));
  await kPgUpCtrl(cdp);
  await sleep(500);

  // ---- 8. read-only guards (F8, F7 inside an archive) ----
  await cursorTo(cdp, "ref.zip");
  await kEnter(cdp);
  await sleep(700);
  await key(cdp, "F8", { keyCode: FKEYS.F8 });
  await sleep(500);
  let t = await toastText(cdp);
  check("F8 in archive blocked", !!t && (await dialogOpen(cdp)) === false, t);
  await sleep(3100);
  await key(cdp, "F7", { keyCode: FKEYS.F7 });
  await sleep(500);
  t = await toastText(cdp);
  check("F7 in archive blocked", !!t && (await dialogOpen(cdp)) === false, t);
  await kEsc(cdp); // in case an input dialog opened anyway
  await sleep(3100);

  // ---- 9. Alt+F6 unpack (subdir default on) ----
  await kPgUpCtrl(cdp);
  await sleep(500);
  await cursorTo(cdp, "ref-cp866.zip");
  await key(cdp, "F6", { keyCode: FKEYS.F6, alt: true });
  await sleep(700);
  check("unpack dialog opens", await dialogOpen(cdp));
  await setDialogInput(cdp, OUT);
  await clickDialogBtn(cdp, "OK");
  const unpackOk = await waitOpDone(cdp);
  const cpTxt = join(OUT, "ref-cp866", "привет cp866.txt");
  const insideTxt = join(OUT, "ref-cp866", "dir866", "inside.txt");
  check("unpack runs to completion", unpackOk);
  check("unpack subdir layout", exists(cpTxt) && exists(insideTxt), tree(OUT).join(", "));
  if (exists(cpTxt)) {
    const got = readFileSync(cpTxt);
    check("cp866 bytes round-trip", got.equals(CP866_BODY), got.toString("hex").slice(0, 40));
  } else {
    check("cp866 bytes round-trip", false, "file missing");
  }
  if (exists(insideTxt)) {
    check("cp866 inner file content", readFileSync(insideTxt).length === 333, `${readFileSync(insideTxt).length} bytes`);
  }

  // ---- 10. Alt+F5 pack (zip), verify with Expand-Archive ----
  // pack always goes into the OPPOSITE panel — put the right panel at OUT2
  await key(cdp, "Tab", { keyCode: 9 });
  await sleep(300);
  await cd(cdp, OUT2);
  await key(cdp, "Tab", { keyCode: 9 }); // back to the left (source) panel
  await sleep(300);
  await cd(cdp, SRC);
  await cursorTo(cdp, "readme.txt");
  await kIns(cdp);
  await sleep(200);
  await cursorTo(cdp, "sub dir");
  await kIns(cdp);
  await sleep(200);
  await key(cdp, "F5", { keyCode: FKEYS.F5, alt: true });
  await sleep(700);
  const packDlg = await evalIn(cdp, `(() => ({ open: !!document.querySelector(".dlg"), name: document.querySelector(".dlg input")?.value ?? null }))()`);
  check("pack dialog opens with stem", packDlg?.open && packDlg.name === "src", JSON.stringify(packDlg));
  await setDialogInput(cdp, "packed");
  await clickDialogBtn(cdp, "OK");
  check("pack runs to completion", await waitOpDone(cdp));
  const packedZip = join(OUT2, "packed.zip");
  check("packed.zip created", exists(packedZip), packedZip);
  if (exists(packedZip)) {
    const exdir = join(FIXT, "verify-zip");
    rmSync(exdir, { recursive: true, force: true });
    try {
      execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${packedZip}' -DestinationPath '${exdir}' -Force"`, { stdio: "pipe" });
      const ok1 = sha(join(exdir, "readme.txt")) === sha(join(SRC, "readme.txt"));
      const ok2 = sha(join(exdir, "sub dir", "beta.bin")) === sha(join(SRC, "sub dir", "beta.bin"));
      const ok3 = exists(join(exdir, "sub dir", "inner"));
      check("packed.zip independently valid", ok1 && ok2 && ok3, `r=${ok1} b=${ok2} i=${ok3}`);
    } catch (e) {
      check("packed.zip independently valid", false, String(e).slice(0, 120));
    }
  }

  // ---- 11. 7z roundtrip ----
  await key(cdp, "F5", { keyCode: FKEYS.F5, alt: true });
  await sleep(700);
  await setDialogInput(cdp, "packed7");
  await clickPackFormat(cdp, 3); // .7z
  await sleep(200);
  await clickDialogBtn(cdp, "OK");
  check("7z pack runs", await waitOpDone(cdp));
  const packed7 = join(OUT2, "packed7.7z");
  check("packed7.7z created", exists(packed7), packed7);

  // ---- 12. enter packed.zip, F5 a subtree out ----
  await cd(cdp, OUT2);
  await cursorTo(cdp, "packed.zip");
  await kEnter(cdp);
  await sleep(900);
  await cursorTo(cdp, "sub dir");
  await key(cdp, "F5", { keyCode: FKEYS.F5 });
  await sleep(700);
  check("F5-from-archive dialog opens", await dialogOpen(cdp));
  await setDialogInput(cdp, join(OUT2, "ex1"));
  await clickDialogBtn(cdp, "OK");
  check("F5 extract subtree runs", await waitOpDone(cdp));
  const betaOut = join(OUT2, "ex1", "sub dir", "beta.bin");
  check("F5 extract content", exists(betaOut) && sha(betaOut) === sha(join(SRC, "sub dir", "beta.bin")), betaOut);
  if (exists(betaOut)) {
    const mt = statSync(betaOut).mtime;
    const want = new Date("2023-01-15T08:30:00");
    const drift = Math.abs(mt.getTime() - want.getTime());
    check("mtime preserved", drift < 5 * 60 * 1000, `${mt.toISOString()} vs ${want.toISOString()}`);
  }

  // ---- 13. F5 INTO an archive (append) ----
  // the target panel (right) must be inside the archive for the interception
  await key(cdp, "Tab", { keyCode: 9 });
  await sleep(300);
  await cd(cdp, OUT2);
  await cursorTo(cdp, "packed.zip");
  await kEnter(cdp);
  await sleep(900);
  await key(cdp, "Tab", { keyCode: 9 }); // back to the left (source) panel
  await sleep(300);
  await cd(cdp, SRC);
  await cursorTo(cdp, "toadd.bin");
  await key(cdp, "F5", { keyCode: FKEYS.F5 });
  await sleep(700);
  const prefilled = await evalIn(cdp, `document.querySelector(".dlg input")?.value ?? null`);
  check("F5-into-archive prefills the archive url", (prefilled ?? "").startsWith("archive://") && (prefilled ?? "").includes("packed.zip"), prefilled);
  await clickDialogBtn(cdp, "OK");
  check("append into archive runs", await waitOpDone(cdp));
  // reopen the archive and verify the new entry is there
  await cd(cdp, OUT2);
  await cursorTo(cdp, "packed.zip");
  await kEnter(cdp);
  await sleep(900);
  r = await rows(cdp);
  check("appended entry visible", (r ?? []).includes("toadd.bin"), JSON.stringify(r));
  // extract it back and compare — the target panel must be on disk again
  await key(cdp, "Tab", { keyCode: 9 });
  await sleep(300);
  await cd(cdp, OUT2);
  await key(cdp, "Tab", { keyCode: 9 });
  await sleep(300);
  await cursorTo(cdp, "toadd.bin");
  await key(cdp, "F5", { keyCode: FKEYS.F5 });
  await sleep(700);
  await setDialogInput(cdp, join(OUT2, "ex2"));
  await clickDialogBtn(cdp, "OK");
  check("append extract runs", await waitOpDone(cdp));
  const toaddOut = join(OUT2, "ex2", "toadd.bin");
  check("appended content round-trip", exists(toaddOut) && sha(toaddOut) === sha(join(SRC, "toadd.bin")), toaddOut);

  // ---- 14. F6 INTO an archive (move semantics) ----
  // right panel back inside the archive for the move target
  await key(cdp, "Tab", { keyCode: 9 });
  await sleep(300);
  await cd(cdp, OUT2);
  await cursorTo(cdp, "packed.zip");
  await kEnter(cdp);
  await sleep(900);
  await key(cdp, "Tab", { keyCode: 9 });
  await sleep(300);
  await cd(cdp, SRC);
  await cursorTo(cdp, "tomove.bin");
  await key(cdp, "F6", { keyCode: FKEYS.F6 });
  await sleep(700);
  const pre2 = await evalIn(cdp, `document.querySelector(".dlg input")?.value ?? null`);
  check("F6-into-archive prefills the archive url", (pre2 ?? "").startsWith("archive://"), pre2);
  await clickDialogBtn(cdp, "OK");
  check("move-into-archive runs", await waitOpDone(cdp));
  const srcGone = await waitFor(() => !exists(join(SRC, "tomove.bin")), 4000);
  check("F6 removed the source", srcGone, "tomove.bin still on disk");

  // ---- 15. 7z listing + unpack ----
  // the unpack target is the opposite panel — keep it on a real disk dir
  await key(cdp, "Tab", { keyCode: 9 });
  await sleep(300);
  await cd(cdp, OUT2);
  await key(cdp, "Tab", { keyCode: 9 });
  await sleep(300);
  await cd(cdp, OUT2);
  await cursorTo(cdp, "packed7.7z");
  await kEnter(cdp);
  await sleep(900);
  r = await rows(cdp);
  check("7z enters", (r ?? []).includes("readme.txt") && (r ?? []).includes("sub dir"), JSON.stringify(r));
  await kPgUpCtrl(cdp);
  await sleep(400);
  await cursorTo(cdp, "packed7.7z");
  await key(cdp, "F6", { keyCode: FKEYS.F6, alt: true });
  await sleep(700);
  await setDialogInput(cdp, join(OUT2, "ex7"));
  await clickDialogBtn(cdp, "OK");
  check("7z unpack runs", await waitOpDone(cdp));
  const r7 = join(OUT2, "ex7", "packed7", "readme.txt");
  check("7z content round-trip", exists(r7) && sha(r7) === sha(join(SRC, "readme.txt")), r7);

  // ---- 16. session maps an archive panel back to disk ----
  await cursorTo(cdp, "packed.zip");
  await kEnter(cdp);
  await sleep(2500); // debounce is 1s
  const sessRaw = readFileSync(join(CFG, "session.json"), "utf8");
  const sess = JSON.parse(sessRaw);
  check("session maps archive panel to disk dir",
    Object.values(sess).every((v) => typeof v !== "string" || !String(v).startsWith("archive://")),
    sessRaw.replace(/\s+/g, " ").slice(0, 160));

  // ---- 17. window size memory ----
  // A real OS-level resize (MoveWindow) drives the resize events; CDP's
  // Browser.setWindowBounds only resizes Chromium's surface and fires nothing.
  await cdp.close();
  child.kill();
  await sleep(1000);
  {
    const cdp2 = await launch();
    const dpr = await evalIn(cdp2, `window.devicePixelRatio`);
    // DPI note: the resize ps1 runs DPI-unaware, so its pixels are scaled
    const PS_W = 1150, PS_H = 740;
    const psOut = execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "D:/Al-Navi/scripts/resize-window.ps1", "-W", String(PS_W), "-H", String(PS_H)],
      { encoding: "utf8", cwd: "D:/Al-Navi" },
    ).trim();
    console.log("  ps1:", psOut);
    await sleep(2000); // debounce save is 800ms
    const wjson = join(CFG, "window.json");
    let saved = null;
    try { saved = JSON.parse(readFileSync(wjson, "utf8")); } catch {}
    const physW = Math.round(PS_W * (dpr ?? 1)), physH = Math.round(PS_H * (dpr ?? 1));
    check("window.json saved after resize",
      !!saved && Math.abs(saved.w - physW) < 90 && Math.abs(saved.h - physH) < 90 && saved.maximized === false,
      `saved=${JSON.stringify(saved)} dpr=${dpr} expect≈${physW}x${physH}`);
    // maximize through the real titlebar button, then check it is remembered
    await evalIn(cdp2, `[...document.querySelectorAll(".win-controls .wc")][1]?.click() ?? false`);
    await sleep(1800);
    let savedMax = null;
    try { savedMax = JSON.parse(readFileSync(wjson, "utf8")); } catch {}
    check("maximized state saved", savedMax?.maximized === true, JSON.stringify(savedMax));
    await cdp2.close();
    child.kill();
    await sleep(1000);
    // relaunch: geometry + maximized must come back (CDP's windowState field
    // is unreliable for the WebView2 host — infer maximized from the size)
    const cdp3 = await launch();
    const dim = await evalIn(cdp3, `({ w: window.outerWidth, h: window.outerHeight, dpr: window.devicePixelRatio })`);
    const phys = { w: Math.round((dim?.w ?? 0) * (dim?.dpr ?? 1)), h: Math.round((dim?.h ?? 0) * (dim?.dpr ?? 1)) };
    check("window reopens maximized", !!saved && phys.h > saved.h + 100, `${phys.w}x${phys.h} vs saved ${saved?.w}x${saved?.h}`);
    // restore down (titlebar button) — it must fall back to the saved normal size
    await evalIn(cdp3, `[...document.querySelectorAll(".win-controls .wc")][1]?.click() ?? false`);
    await sleep(1200);
    const dim2 = await evalIn(cdp3, `({ w: window.outerWidth, h: window.outerHeight, dpr: window.devicePixelRatio })`);
    const phys2 = { w: Math.round((dim2?.w ?? 0) * (dim2?.dpr ?? 1)), h: Math.round((dim2?.h ?? 0) * (dim2?.dpr ?? 1)) };
    check("un-maximize returns to saved size",
      Math.abs(phys2.w - physW) < 120 && Math.abs(phys2.h - physH) < 120,
      `${phys2.w}x${phys2.h} vs ≈${physW}x${physH}`);
    await cdp3.close();
  }

  // ---- summary ----
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  child?.kill();
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  restoreCfg();
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error("E2E error:", e);
  child?.kill();
  restoreCfg();
  process.exit(1);
}
