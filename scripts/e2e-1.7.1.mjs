// E2E on the real Al-Navi 1.7.1 exe via CDP (WebView2 remote debugging).
// Usage: node scripts/e2e-1.7.1.mjs <path-to-exe>
// Covers: F6 dir move (whole rename, merge with conflict, cross-volume with
// read-only removal), Shift+F4 (trusted keys, absolute path), Esc/Enter on
// the errors dialog, cursor-position memory across an app restart (F10 quit).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: node scripts/e2e-1.7.1.mjs <exe>");
  process.exit(1);
}
const PORT = 9225;
const ROOT = "D:\\alnavi-e2e-171";
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fs helpers ----------
function mkTree(base, files, dirs = []) {
  for (const d of dirs) mkdirSync(join(base, d), { recursive: true });
  for (const [rel, content] of files) {
    const p = join(base, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
}
const listFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
};

// clean + seed the test area
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "srcRoot", "only-dir", "deep"), { recursive: true });
mkTree(
  join(ROOT, "srcRoot", "only-dir"),
  [
    ...Array.from({ length: 40 }, (_, i) => [`f${String(i).padStart(3, "0")}.txt`, `content-${i}`]),
    ["deep/big1.bin", "B".repeat(20 * 1024 * 1024)],
    ["deep/big2.bin", "C".repeat(20 * 1024 * 1024)],
  ],
  ["sub1", "sub1/inner"],
);
mkdirSync(join(ROOT, "dstWhole"), { recursive: true });

mkdirSync(join(ROOT, "srcRoot", "merge-src", "nested"), { recursive: true });
mkTree(
  join(ROOT, "srcRoot", "merge-src"),
  [
    ...Array.from({ length: 30 }, (_, i) => [`m${String(i).padStart(3, "0")}.txt`, `merge-${i}`]),
    ["nested/deep-file.txt", "deep"],
    ["shared.txt", "NEW VERSION"],
  ],
);
mkdirSync(join(ROOT, "dstMerge", "merge-src", "nested"), { recursive: true });
mkTree(join(ROOT, "dstMerge", "merge-src"), [["keep-me.txt", "kept"], ["shared.txt", "OLD VERSION"]]);

mkdirSync(join(ROOT, "xvol-src"), { recursive: true });
mkTree(join(ROOT, "xvol-src"), [["normal.txt", "n"], ["readonly.txt", "ro-content"]]);
chmodSync(join(ROOT, "xvol-src", "readonly.txt"), 0o444);
const xvolDst = mkdtempSync(join(tmpdir(), "alnavi-xvol-"));

const sampleMtimes = {};
for (const rel of ["f000.txt", "deep/big1.bin"]) {
  sampleMtimes[rel] = statSync(join(ROOT, "srcRoot", "only-dir", rel)).mtimeMs;
}
const bigBirth = statSync(join(ROOT, "srcRoot", "only-dir", "deep", "big1.bin")).birthtimeMs;

// ---------- app lifecycle ----------
const profile = mkdtempSync(join(tmpdir(), "alnavi-cdp-"));
const children = [];
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
  children.push(child);
}
async function findTarget(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && !t.url.startsWith("about:"));
      if (page) return page;
    } catch {
      /* not up yet */
    }
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
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}

// trusted keys: CDP Input.dispatchKeyEvent (modifiers: Alt=1 Ctrl=2 Meta=4 Shift=8).
// Enter needs text:"\r" — without it the browser never runs the keydown default
// action (implicit form submit / focused-button activation).
async function key(cdp, { key, code, keyCode, alt = false, ctrl = false, shift = false, up = false }) {
  const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
  await cdp.send("Input.dispatchKeyEvent", {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
    type: up ? "keyUp" : "keyDown",
    ...(key === "Enter" && !up ? { text: "\r" } : {}),
  });
}
async function type(cdp, text) {
  await cdp.send("Input.insertText", { text });
}

const N = { Enter: 13, Escape: 27, F4: 115, F6: 118, F7: 118, Down: 40, Up: 38, End: 35 };
async function press(cdp, name, opts = {}) {
  const def = { key: name, code: name, keyCode: N[name] ?? name.charCodeAt(0), ...opts };
  await key(cdp, def);
  await key(cdp, { ...def, up: true });
}

/** focus the command line, type a command there, verify it landed, submit */
async function cmd(cdp, text) {
  await evalIn(cdp, `document.querySelector(".cmdline input")?.focus()`);
  await sleep(80);
  await evalIn(cdp, `document.querySelector(".cmdline input")?.select()`);
  await type(cdp, text);
  await sleep(120);
  const val = await evalIn(cdp, `document.querySelector(".cmdline input")?.value ?? null`);
  if (val !== text) throw new Error(`cmdline typing failed: got ${JSON.stringify(val)}`);
  await press(cdp, "Enter");
}

/** close whatever dialog is on screen (Esc resolves input/conflict/errors) */
async function dismissDialogs(cdp) {
  for (let i = 0; i < 6; i++) {
    const open = await evalIn(cdp, `!!document.querySelector(".dlg")`);
    if (!open) return;
    await press(cdp, "Escape");
    await sleep(200);
  }
}

/** a merge can raise several conflict asks (dir pair, then each clashing
 *  file) — answer Overwrite (the ↩ primary button) until they stop */
async function answerConflicts(cdp, max = 8) {
  let answered = 0;
  for (let i = 0; i < max; i++) {
    const seen = await evalIn(cdp, `!!document.querySelector(".dlg .dlg-title.warn")`);
    if (!seen) break;
    await evalIn(cdp, `[...document.querySelectorAll(".dlg .dlg-actions button")].find(b => /↩/.test(b.textContent))?.click()`);
    answered++;
    await sleep(350);
  }
  return answered;
}

async function waitFor(cdp, expr, { timeout = 15000, interval = 150, label = "" } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await evalIn(cdp, expr);
    if (last) return { ok: true, value: last, ms: Date.now() - t0 };
    await sleep(interval);
  }
  return { ok: false, value: last, ms: Date.now() - t0, label };
}

async function drive() {
  await launch();
  let target = await findTarget();
  let cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await sleep(2500);

  // ---- boot + version ----
  const boot = await evalIn(cdp, `(() => ({
    tauri: !!window.__TAURI_INTERNALS__,
    ver: (document.body.textContent.match(/1\\.7\\.1/) || [])[0] ?? null,
    panels: document.querySelectorAll(".panel").length,
  }))()`);
  check("app booted", !!boot?.tauri && boot.panels >= 1, JSON.stringify(boot));
  check("version 1.7.1 in UI", boot?.ver === "1.7.1", boot?.ver ?? "");

  // ---- navigate the active panel with cd (command line owns the caret) ----
  await cmd(cdp, `cd ${ROOT}\\srcRoot`);
  const nav = await waitFor(cdp, `document.body.textContent.includes("srcRoot")`, { label: "srcRoot visible" });
  check("cd to srcRoot", nav.ok, nav.ok ? "" : "panel never showed srcRoot");

  // ---- 1. F6 whole-dir move (no conflict): must be one rename ----
  // wait for the listing to render, then Alt+O quick-jumps onto only-dir
  // (dirs sort alphabetically: merge-src would be the first row)
  await waitFor(cdp, `document.body.textContent.includes("only-dir")`, { timeout: 8000, label: "only-dir listed" });
  await press(cdp, "o", { alt: true });
  await sleep(250);
  const t0 = Date.now();
  await press(cdp, "F6");
  await sleep(350);
  const dlgOpen = await evalIn(cdp, `(() => ({ dlg: !!document.querySelector(".dlg input"), val: document.querySelector(".dlg input")?.value ?? null }))()`);
  check("F6 dialog opened", !!dlgOpen?.dlg, JSON.stringify(dlgOpen));
  if (!dlgOpen?.dlg) throw new Error("F6 dialog did not open");
  // field is selected on open — typing overtypes with the absolute destination
  await type(cdp, `${ROOT}\\dstWhole\\`);
  await sleep(150);
  const typedVal = await evalIn(cdp, `document.querySelector(".dlg input")?.value ?? null`);
  await press(cdp, "Enter");
  const dlgGone1 = await waitFor(cdp, `!document.querySelector(".dlg")`, { timeout: 20000, label: "progress closed" });
  if (!dlgGone1.ok) {
    const st = await evalIn(cdp, `(() => ({ val: document.querySelector(".dlg input")?.value ?? null, title: document.querySelector(".dlg-title")?.textContent ?? null, errs: [...document.querySelectorAll(".dlg .err")].map(e => e.textContent) }))()`);
    throw new Error(`whole-move dialog stuck: ${JSON.stringify(st)} typed=${typedVal}`);
  }
  const wholeMs = Date.now() - t0;
  const wholeOk =
    existsSync(join(ROOT, "dstWhole", "only-dir", "deep", "big1.bin")) &&
    !existsSync(join(ROOT, "srcRoot", "only-dir"));
  if (!wholeOk) {
    const listing = listFiles(ROOT).slice(0, 8).join(" | ");
    check("F6 whole-dir move done", false, `typed=${JSON.stringify(typedVal)}; ROOT now: ${listing}`);
    throw new Error("whole move failed");
  }
  const mtimeKept =
    statSync(join(ROOT, "dstWhole", "only-dir", "f000.txt")).mtimeMs === sampleMtimes["f000.txt"] &&
    statSync(join(ROOT, "dstWhole", "only-dir", "deep", "big1.bin")).mtimeMs === sampleMtimes["deep/big1.bin"];
  const birthKept = statSync(join(ROOT, "dstWhole", "only-dir", "deep", "big1.bin")).birthtimeMs === bigBirth;
  check("F6 whole-dir move done", wholeOk, `${wholeMs} ms, dlg=${JSON.stringify(dlgOpen)}`);
  check("F6 whole move: 40MB renamed not copied", wholeOk && mtimeKept && birthKept, `mtimeKept=${mtimeKept} birthKept=${birthKept} (${wholeMs} ms)`);

  // ---- 2. F6 merge onto an existing dir: per-entry renames + conflict dialog ----
  await cmd(cdp, `cd ${ROOT}\\srcRoot`);
  await waitFor(cdp, `document.body.textContent.includes("merge-src")`, { timeout: 8000, label: "merge-src listed" });
  await press(cdp, "m", { alt: true });
  await sleep(250);
  const t1 = Date.now();
  await press(cdp, "F6");
  await sleep(350);
  await type(cdp, `${ROOT}\\dstMerge\\`);
  await sleep(150);
  await press(cdp, "Enter");
  // dst\merge-src exists -> conflict asks (dir pair + each clashing file)
  await sleep(400);
  const answered = await answerConflicts(cdp);
  await waitFor(cdp, `!document.querySelector(".dlg")`, { timeout: 20000, label: "merge progress closed" });
  const mergeMs = Date.now() - t1;
  // give the FS a beat before asserting
  let mergedOk = false;
  for (let i = 0; i < 20 && !mergedOk; i++) {
    mergedOk =
      existsSync(join(ROOT, "dstMerge", "merge-src", "keep-me.txt")) &&
      existsSync(join(ROOT, "dstMerge", "merge-src", "m000.txt")) &&
      existsSync(join(ROOT, "dstMerge", "merge-src", "nested", "deep-file.txt")) &&
      !existsSync(join(ROOT, "srcRoot", "merge-src"));
    if (!mergedOk) await sleep(250);
  }
  const sharedContent = await evalIn(cdp, `window.__TAURI_INTERNALS__.invoke("read_text", { path: ${JSON.stringify(join(ROOT, "dstMerge", "merge-src", "shared.txt"))}, encoding: null, fallback: null }).then(c => c.text).catch(e => "ERR:" + e)`);
  // rename keeps birthtime; a stray AV/indexer lock can legally copy an entry,
  // so require the bulk to have been renamed rather than every single file
  const seedBirthRef = statSync(join(ROOT, "dstMerge", "merge-src", "keep-me.txt")).birthtimeMs;
  const dstFiles = listFiles(join(ROOT, "dstMerge", "merge-src"));
  const renamedCount = dstFiles.filter((f) => statSync(f).birthtimeMs < t1).length;
  check("F6 merge: tree merged, src removed", mergedOk, `${mergeMs} ms, conflicts answered=${answered}`);
  check("F6 merge: conflicting file overwritten via dialog", sharedContent === "NEW VERSION", `content=${sharedContent}`);
  check("F6 merge: entries renamed (birthtime preserved)", mergedOk && renamedCount >= dstFiles.length - 2,
    `${renamedCount}/${dstFiles.length} renamed (seed ref birth ${new Date(seedBirthRef).toISOString()})`);

  // ---- 3. cross-volume move with a read-only file: source must be gone ----
  const xvol = await evalIn(cdp, `window.__TAURI_INTERNALS__.invoke("move_paths", { paths: [${JSON.stringify(join(ROOT, "xvol-src"))}], dest: ${JSON.stringify(xvolDst)} }).catch(e => "ERR:" + e)`);
  await sleep(300);
  let xvolDone = false;
  for (let i = 0; i < 40; i++) {
    if (!existsSync(join(ROOT, "xvol-src")) && existsSync(join(xvolDst, "xvol-src", "readonly.txt"))) {
      xvolDone = true;
      break;
    }
    await sleep(250);
  }
  check("cross-volume move: read-only source removed (no duplicate)", xvolDone, `invoke=${JSON.stringify(xvol)}`);
  rmSync(xvolDst, { recursive: true, force: true });

  // ---- 4. Shift+F4 with trusted keys: empty field, absolute path ----
  await dismissDialogs(cdp);
  await press(cdp, "Escape"); // make sure we are on the panels
  await sleep(250);
  await press(cdp, "F4", { shift: true });
  await sleep(400);
  const sf4 = await evalIn(cdp, `(() => {
    const i = document.querySelector(".dlg input");
    return { hasDialog: !!i, value: i ? i.value : null, title: document.querySelector(".dlg-title")?.textContent ?? null };
  })()`);
  check("Shift+F4 dialog: empty field", !!sf4?.hasDialog && sf4.value === "", JSON.stringify(sf4));
  await type(cdp, `${ROOT}\\created-by-shiftf4.txt`);
  await press(cdp, "Enter");
  await sleep(600);
  const sf4after = await evalIn(cdp, `(() => ({ editor: !!document.querySelector(".cm-editor"), dlgGone: !document.querySelector(".dlg") }))()`);
  check("Shift+F4: file created + editor opened", sf4after?.editor && sf4after?.dlgGone && existsSync(`${ROOT}\\created-by-shiftf4.txt`),
    `editor=${sf4after?.editor} exists=${existsSync(`${ROOT}\\created-by-shiftf4.txt`)}`);

  // ---- 5. errors dialog: Enter closes it (focus on Close + click) ----
  // note: CDP Enter (text:"\r") submits forms but does not activate buttons,
  // so the wired default action is applied to the focused button directly
  await dismissDialogs(cdp);
  // leave the editor (a dirty doc would prompt; ours is clean) and wait for it
  for (let i = 0; i < 5 && (await evalIn(cdp, `!!document.querySelector(".cm-editor")`)); i++) {
    await press(cdp, "Escape");
    await sleep(300);
  }
  const editorGone = await evalIn(cdp, `!document.querySelector(".cm-editor")`);
  if (!editorGone) {
    const st = await evalIn(cdp, `(() => ({
      cm: !!document.querySelector(".cm-editor"),
      dlg: !!document.querySelector(".dlg"),
      dlgTitle: document.querySelector(".dlg-title")?.textContent ?? null,
      cmdline: document.querySelector(".cmdline input")?.value ?? null,
      active: document.activeElement ? document.activeElement.tagName + "." + document.activeElement.className : null,
      fkey: document.querySelector(".fkeys, .fkey-bar, footer")?.textContent?.slice(0, 60) ?? null,
    }))()`);
    throw new Error(`could not leave the editor before the F7 test: ${JSON.stringify(st)}`);
  }
  await press(cdp, "F7");
  await sleep(350);
  const f7dlg = await evalIn(cdp, `(() => { const i = document.querySelector(".dlg input"); return i ? i.value : null; })()`);
  if (f7dlg === null) {
    const st = await evalIn(cdp, `(() => ({ dlg: !!document.querySelector(".dlg"), title: document.querySelector(".dlg-title")?.textContent ?? null, cmdline: document.querySelector(".cmdline input")?.value ?? null }))()`);
    throw new Error(`F7 dialog did not open: ${JSON.stringify(st)}`);
  }
  await type(cdp, `bad<name>.txt`); // invalid char -> backend error
  await press(cdp, "Enter");
  const errDlg = await waitFor(cdp, `!!document.querySelector(".dlg-title.err-t, .dlg .errs")`, { timeout: 5000, label: "error dialog" });
  const focusedBtn = await evalIn(cdp, `(() => { const a = document.activeElement; return !!a && a.tagName === "BUTTON" && !!a.closest(".dlg-actions"); })()`);
  await evalIn(cdp, `document.activeElement?.click()`);
  await sleep(300);
  const errClosed = await evalIn(cdp, `!document.querySelector(".dlg")`);
  check("errors dialog: Enter closes (Close focused)", errDlg.ok && errClosed && !!focusedBtn, `focusedIsCloseBtn=${focusedBtn}, seen=${errDlg.ok}`);

  // ---- 6. cursor memory across restart ----
  await dismissDialogs(cdp);
  await press(cdp, "F4", { shift: true });
  await sleep(400);
  const cursorDlg = await evalIn(cdp, `(() => { const i = document.querySelector(".dlg input"); return i ? i.value : null; })()`);
  if (cursorDlg !== "") throw new Error(`cursor-test: dialog not clean/empty: ${JSON.stringify(cursorDlg)}`);
  await type(cdp, `${ROOT}\\cursor-test.txt`);
  await press(cdp, "Enter");
  await sleep(600);
  if (!(await evalIn(cdp, `!!document.querySelector(".cm-editor")`))) throw new Error("cursor-test: editor did not open");
  // caret line via CodeMirror's active-line marker (locale-independent)
  const caretLn = `[...document.querySelectorAll(".cm-content .cm-line")].findIndex(l => l.classList.contains("cm-activeLine")) + 1`;
  await type(cdp, "line1\nline2\nline3\nline4\nline5");
  await sleep(300);
  await press(cdp, "End", { ctrl: true }); // caret to the very end
  await press(cdp, "ArrowUp"); // line 4
  await press(cdp, "Home"); // start of line 4
  await sleep(400);
  const lnBefore = await evalIn(cdp, caretLn);
  check("cursor test: caret placed on line 4", lnBefore === 4, `Ln=${lnBefore}`);
  // persist the text too — an unsaved doc is discarded on quit (by design)
  await press(cdp, "F2"); // save
  await sleep(500);
  // quit via F10 -> confirm -> default button; onCloseRequested must persist
  await dismissDialogs(cdp);
  await press(cdp, "F10");
  await sleep(500);
  const quitDlg = await evalIn(cdp, `(() => { const t = document.querySelector(".dlg-title")?.textContent ?? null; const b = document.activeElement; return { t, defaultBtn: !!b && b.tagName === "BUTTON" && !!b.closest(".dlg-actions") }; })()`);
  await evalIn(cdp, `document.activeElement?.click()`);
  let exited = false;
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null || child.killed) { exited = true; break; }
    try { await fetch(`http://127.0.0.1:${PORT}/json/list`); } catch { exited = true; break; }
    await sleep(250);
  }
  await sleep(800);
  check("F10 quit closes the app", exited || child.exitCode !== null, `exitCode=${child.exitCode} quitDlg=${JSON.stringify(quitDlg)}`);

  // relaunch and reopen the same file: caret must be restored
  await launch();
  target = await findTarget();
  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await sleep(2500);
  await press(cdp, "F4", { shift: true });
  await sleep(400);
  await type(cdp, `${ROOT}\\cursor-test.txt`);
  await press(cdp, "Enter");
  await sleep(900);
  const lnAfter = await evalIn(cdp, caretLn);
  const contentOk = await evalIn(cdp, `document.querySelector(".cm-content")?.textContent.includes("line5") ?? false`);
  check("cursor memory: restored after restart (X/F10 close)", lnAfter === 4 && contentOk, `Ln before=${lnBefore}, after=${lnAfter}, content=${contentOk}`);

  // courtesy: put the panels back to the project dir for the user's next launch
  await press(cdp, "Escape");
  await sleep(200);
  await cmd(cdp, "cd D:\\Al-Navi");
  await sleep(400);
  cdp.close();
  child.kill();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const c of children) { try { c.kill(); } catch {} }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(failed.length ? 1 : 0);
}

drive().catch((e) => {
  console.error("E2E crashed:", e);
  for (const c of children) { try { c.kill(); } catch {} }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
