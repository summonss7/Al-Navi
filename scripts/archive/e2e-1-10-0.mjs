// Real-exe E2E for 1.10.0: Ctrl+M multi-rename, F2 user menu, Alt+F11 view
// history. Drives the built exe over CDP (isolated WEBVIEW2_USER_DATA_FOLDER;
// the app config dir %APPDATA%\al-navi is snapshotted and restored because
// user-menu.json / view-history.json / cmd-history.json are written for real).
// Usage: node scripts/e2e-1-10-0.mjs [path-to-exe]
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const exe = process.argv[2] || join(dirname(dirname(fileURLToPath(import.meta.url))), "src-tauri", "target", "release", "al-navi.exe");
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 9229;
const profile = mkdtempSync(join(tmpdir(), "alnavi-cdp-"));
const work = mkdtempSync(join(tmpdir(), "alnavi-mr-"));
const CFG = join(process.env.APPDATA, "al-navi");
const SNAP_FILES = ["user-menu.json", "view-history.json", "cmd-history.json", "dir-history.json", "session.json", "window.json"];
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

// seed: 4 txt files for the batch + 1 masked-out + recreated later for conflicts
for (const n of ["one.txt", "two.txt", "three.txt", "four.txt"]) writeFileSync(join(work, n), n);
writeFileSync(join(work, "skipme.dat"), "data");

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
const exists = (p) => { try { return existsSync(p); } catch { return false; } };
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
async function key(cdp, { key: k, code, keyCode, ctrl = false, alt = false, up = false }) {
  const modifiers = (ctrl ? 2 : 0) | (alt ? 1 : 0);
  await cdp.send("Input.dispatchKeyEvent", {
    key: k, code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
    type: up ? "keyUp" : "keyDown",
  });
}
const press = (cdp, k, opts = {}) => key(cdp, { ...k, ...opts, up: false }).then(() => key(cdp, { ...k, ...opts, up: true }));

async function typeLine(cdp, text) {
  await cdp.send("Input.insertText", { text });
  await press(cdp, { key: "Enter", code: "Enter", keyCode: 13 });
}

async function fillSel(cdp, sel, value) {
  return evalIn(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
}

async function clickSel(cdp, sel) {
  const r = await evalIn(cdp, `(() => {
    const b = document.querySelector(${JSON.stringify(sel)});
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
  })()`);
  if (!r) return null;
  if (r.disabled) return "disabled";
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  }
  return "clicked";
}

const mrRowTexts = (cdp) => evalIn(cdp,
  `[...document.querySelectorAll(".dlg-mr .mr-row")].map((r) => r.textContent.replace(/\\s+/g, " ").trim())`);

try {
  launch();
  const target = await findTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  console.log(`connected: ${target.title ?? target.url}`);
  await sleep(1500);
  const resizeOut = execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${join(ROOT, "scripts", "resize-window.ps1")}" -W 1200 -H 700`,
    { encoding: "utf8" },
  ).trim();
  console.log(`window: ${resizeOut}`);
  await sleep(1200);

  // ---- boot + version ----
  const boot = await evalIn(cdp, `(() => ({
    tauri: !!window.__TAURI_INTERNALS__,
    version: (document.body.textContent.match(/1\\.10\\.0/) || [])[0] ?? null,
  }))()`);
  check("app booted with real backend", !!boot?.tauri, JSON.stringify(boot));
  check("version 1.10.0 in UI", boot?.version === "1.10.0");

  // ---- cd the panel to the work dir ----
  await typeLine(cdp, `cd ${work}`);
  await sleep(900);
  const crumb = await evalIn(cdp, `document.querySelector(".panel.active .crumbs")?.textContent ?? ""`);
  check("cd to work dir", crumb.toUpperCase().includes("ALNAVI-MR"), crumb.slice(0, 60));

  // ============================================================
  // Ctrl+M — multi-rename
  // ============================================================
  await press(cdp, { key: "m", code: "KeyM", keyCode: 77, ctrl: true });
  await sleep(500);
  check("Ctrl+M opens the dialog", (await evalIn(cdp, `!!document.querySelector(".dlg-mr")`)) === true);
  const nItems = await evalIn(cdp, `document.querySelector(".dlg-mr .dlg-title")?.textContent ?? ""`);
  check("targets = whole panel (5 files)", /5/.test(String(nItems)), nItems.replace(/\s+/g, " ").trim());
  // default form: nothing changes -> apply disabled
  let applyState = await clickSel(cdp, ".dlg-mr .dlg-actions .primary");
  check("apply disabled when nothing changes", applyState === "disabled", String(applyState));
  // mask + counter template
  check("mask field filled", (await fillSel(cdp, "#mr-f-mask", "*.txt")) === true);
  await sleep(150);
  check("name template filled", (await fillSel(cdp, "#mr-f-name", "renamed-[C]")) === true);
  check("digits filled", (await fillSel(cdp, "#mr-f-cd", "2")) === true);
  await sleep(300);
  let rows = await mrRowTexts(cdp);
  // the panel is name-sorted: four, one, three, two — the counter follows
  check("preview: 4 masked rows with counter", rows.length === 4 &&
    rows[0].includes("four.txt") && rows[0].includes("renamed-01.txt") &&
    rows[3].includes("two.txt") && rows[3].includes("renamed-04.txt"),
    JSON.stringify(rows));
  applyState = await clickSel(cdp, ".dlg-mr .dlg-actions .primary");
  check("apply enabled with changes", applyState === "clicked", String(applyState));
  // wait for the op to finish and the files to appear on disk
  const renamedOk = await waitFor(() =>
    ["renamed-01.txt", "renamed-02.txt", "renamed-03.txt", "renamed-04.txt"].every((n) => exists(join(work, n))) &&
    !exists(join(work, "one.txt")) && !exists(join(work, "two.txt")),
    8000, "renamed files");
  check("batch renamed on disk", !!renamedOk);
  check("masked-out file untouched", exists(join(work, "skipme.dat")));
  await waitFor(async () => (await evalIn(cdp, `!document.querySelector(".dlg-mr")`)) === true, 5000, "dialog closed");

  // ---- conflict: a target name already exists on disk ----
  writeFileSync(join(work, "one.txt"), "recreated");
  await press(cdp, { key: "r", code: "KeyR", keyCode: 82, ctrl: true }); // Ctrl+R: let the watcher/panel see the new file
  await sleep(1200);
  await press(cdp, { key: "m", code: "KeyM", keyCode: 77, ctrl: true });
  await sleep(400);
  await fillSel(cdp, "#mr-f-mask", "one.txt");
  await fillSel(cdp, "#mr-f-name", "renamed-01"); // renamed-01.txt exists already
  await sleep(1200); // the disk-existence check is debounced
  rows = await mrRowTexts(cdp);
  check("conflict row flagged", rows.length === 1 && rows[0].includes("renamed-01.txt"), JSON.stringify(rows));
  applyState = await clickSel(cdp, ".dlg-mr .dlg-actions .primary");
  check("apply disabled on conflict", applyState === "disabled", String(applyState));
  await press(cdp, { key: "Escape", code: "Escape", keyCode: 27 });
  await sleep(300);
  check("Esc cancels (no rename happened)", exists(join(work, "one.txt")));
  check("dialog closed after Esc", (await evalIn(cdp, `!document.querySelector(".dlg-mr")`)) === true);

  // ============================================================
  // F2 — user menu
  // ============================================================
  // walk the cursor onto a specific row (Home first, then down until matched)
  async function cursorTo(cdp, nameRe, maxSteps = 12) {
    await press(cdp, { key: "Home", code: "Home", keyCode: 36 });
    await sleep(150);
    for (let i = 0; i < maxSteps; i++) {
      const row = await evalIn(cdp, `document.querySelector(".panel.active .row.cursor")?.textContent ?? ""`);
      if (new RegExp(nameRe, "i").test(row)) return row;
      await press(cdp, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
      await sleep(150);
    }
    return null;
  }
  const curRow = await cursorTo(cdp, "renamed-01\\.txt");
  check("cursor on renamed-01.txt", !!curRow, (curRow ?? "not found").replace(/\s+/g, " ").slice(0, 50));

  await press(cdp, { key: "F2", code: "F2", keyCode: 113 });
  await sleep(400);
  check("F2 opens an empty menu", (await evalIn(cdp,
    `!!document.querySelector('.dlg .none')`)) === true);
  // Ins -> add form
  await press(cdp, { key: "Insert", code: "Insert", keyCode: 45 });
  await sleep(300);
  check("Ins opens the add form", (await evalIn(cdp, `!!document.querySelector("#um-f-cmd")`)) === true);
  await fillSel(cdp, "#um-f-title", "E2E marker");
  await fillSel(cdp, "#um-f-cmd", "echo !!> marker.txt & exit");
  const saved = await clickSel(cdp, ".dlg .dlg-actions .primary");
  await sleep(300);
  check("item saved back to the list", saved === "clicked" &&
    (await evalIn(cdp, `document.querySelector(".dlg .list .li")?.textContent.includes("E2E marker")`)) === true);
  // Enter executes: placeholders expand (cursor on renamed-01.txt), the shell
  // writes marker.txt into the panel dir (cwd)
  rmSync(join(work, "marker.txt"), { force: true });
  await press(cdp, { key: "Enter", code: "Enter", keyCode: 13 });
  const marker = await waitFor(() =>
    exists(join(work, "marker.txt")) ? readFileSync(join(work, "marker.txt"), "utf8").trim() : null,
    10000, "marker file");
  check("menu command executed with !! expanded", marker === "renamed-01.txt", JSON.stringify(marker));
  await waitFor(async () => (await evalIn(cdp, `!document.querySelector(".dlg")`)) === true, 5000, "menu closed");

  // ============================================================
  // Alt+F11 — view history
  // ============================================================
  // view two specific files with F3, closing the viewer after each
  for (const f of ["renamed-01.txt", "renamed-02.txt"]) {
    await cursorTo(cdp, f.replace(".", "\\."));
    await press(cdp, { key: "F3", code: "F3", keyCode: 114 });
    await sleep(600);
    const vp = await evalIn(cdp, `document.querySelector(".v-status .path")?.textContent ?? ""`);
    check(`F3 views ${f}`, vp.includes(f), vp.slice(-40));
    await press(cdp, { key: "Escape", code: "Escape", keyCode: 27 });
    await sleep(300);
  }

  await press(cdp, { key: "F11", code: "F11", keyCode: 122, alt: true });
  await sleep(400);
  const vhRows = await evalIn(cdp, `[...document.querySelectorAll('.dlg .list .li')].map((r) => r.textContent.replace(/\\s+/g, " ").trim())`);
  check("Alt+F11 lists both views, newest first",
    vhRows.length === 2 && vhRows[0].includes("renamed-02.txt") && vhRows[1].includes("renamed-01.txt"),
    JSON.stringify(vhRows));
  await press(cdp, { key: "Enter", code: "Enter", keyCode: 13 });
  await sleep(600);
  const vpath = await evalIn(cdp, `document.querySelector(".v-status .path")?.textContent ?? ""`);
  check("Enter reopens the newest view", vpath.includes("renamed-02.txt"), vpath.slice(-40));
  await press(cdp, { key: "Escape", code: "Escape", keyCode: 27 });
  await sleep(400);
  check("no dialog left open", (await evalIn(cdp, `!document.querySelector(".dlg")`)) === true);

  // ============================================================
  // persistence across a restart (user-menu.json / view-history.json)
  // ============================================================
  // F10 -> confirm (the Yes button is autofocused); verify the dialog really
  // is up before Enter, retry once if the keypress got lost
  let quitDlg = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    await press(cdp, { key: "F10", code: "F10", keyCode: 121 });
    await sleep(500);
    quitDlg = await evalIn(cdp, `(() => {
      const b = document.activeElement;
      return {
        hasDlg: !!document.querySelector(".dlg"),
        defaultBtn: !!b && b.tagName === "BUTTON" && !!b.closest(".dlg-actions"),
        btn: b?.textContent ?? null,
      };
    })()`);
    if (quitDlg?.hasDlg && quitDlg?.defaultBtn) break;
    await press(cdp, { key: "Escape", code: "Escape", keyCode: 27 });
    await sleep(300);
  }
  check("F10 quit confirm shown with focused button", quitDlg?.hasDlg === true && quitDlg?.defaultBtn === true,
    JSON.stringify(quitDlg));
  if (quitDlg?.hasDlg && quitDlg?.defaultBtn) {
    // a synthetic Enter doesn't activate a focused button in the WebView —
    // click it through the DOM (same workaround as e2e-1.7.1)
    await evalIn(cdp, `document.activeElement?.click()`);
  }
  await waitFor(() => {
    try { process.kill(child.pid, 0); return null; } catch { return "exited"; }
  }, 10000, "app exit");
  child = null;
  await sleep(800);
  check("user-menu.json persisted", exists(join(CFG, "user-menu.json")) &&
    readFileSync(join(CFG, "user-menu.json"), "utf8").includes("E2E marker"));
  check("view-history.json persisted", exists(join(CFG, "view-history.json")) &&
    readFileSync(join(CFG, "view-history.json"), "utf8").includes("renamed-02.txt"));

  launch();
  const target2 = await findTarget();
  const cdp2 = await connect(target2.webSocketDebuggerUrl);
  await cdp2.ready;
  console.log("reconnected after restart");
  await sleep(2000);
  await press(cdp2, { key: "F2", code: "F2", keyCode: 113 });
  await sleep(500);
  const menuAfter = await evalIn(cdp2, `document.querySelector(".dlg .list .li")?.textContent ?? ""`);
  check("menu survives restart", menuAfter.includes("E2E marker"), menuAfter.replace(/\s+/g, " ").slice(0, 50));
  await press(cdp2, { key: "Escape", code: "Escape", keyCode: 27 });
  await press(cdp2, { key: "F11", code: "F11", keyCode: 122, alt: true });
  await sleep(500);
  const vhAfter = await evalIn(cdp2, `[...document.querySelectorAll('.dlg .list .li')].map((r) => r.textContent.replace(/\\s+/g, " ").trim())`);
  check("view history survives restart", vhAfter.length >= 2 &&
    vhAfter.some((r) => r.includes("renamed-01.txt")) && vhAfter.some((r) => r.includes("renamed-02.txt")),
    JSON.stringify(vhAfter));
  cdp2.close();
  child?.kill();
  child = null;
} catch (e) {
  check("script ran", false, String(e));
} finally {
  try { child?.kill(); } catch {}
  restoreCfg();
  // best effort: the WebView2 processes release the temp dirs asynchronously
  setTimeout(() => {
    try { rmSync(work, { recursive: true, force: true }); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }, 800);
  setTimeout(() => process.exit(results.filter((r) => !r.ok).length ? 1 : 0), 1200);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
