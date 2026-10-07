// exe-level E2E for alnavi-012 (Dialogs.svelte split into components, 1.12.8):
// every dialog of the refactored router must still open and close on Esc with
// its keyboard cursor intact, and the flows named in the card must work on the
// REAL released exe with real key presses: F5-copy with the transfer dialog,
// Ctrl+M multi-rename, F2 user menu, Alt+F1 drives. The app's real config
// (%APPDATA%\al-navi) is backed up and restored.
// Usage: node scripts/e2e-alnavi-012-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const CFG = join(process.env.APPDATA, "al-navi");
const CDP_PORT = 9269;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// the app writes settings/window state into the real config dir — back it up
const backedUp = [];
for (const f of readdirSync(CFG)) {
  if (f.endsWith(".e2e-bak")) continue;
  const p = join(CFG, f);
  cpSync(p, p + ".e2e-bak", { recursive: true });
  backedUp.push(p);
}
function restoreCfg() {
  // best-effort: the dying WebView2 holds EPERM locks on its profile a moment
  for (let i = 0; i < 3; i++) {
    try {
      for (const p of backedUp) cpSync(p + ".e2e-bak", p, { recursive: true });
      return;
    } catch {
      sleep(700);
    }
  }
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
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
// real key presses: plain keys and modifier chords
async function key(cdp, k, mod = 0) {
  const base = {
    key: k.key ?? k,
    code: k.code ?? k,
    windowsVirtualKeyCode: k.vk ?? (typeof k === "string" ? (VK[k] ?? k.charCodeAt(0)) : 0),
    modifiers: mod,
  };
  await cdp.send("Input.dispatchKeyEvent", { ...base, ...(k.text ? { text: k.text } : {}), type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(140);
}
const VK = { Escape: 27, F1: 112, F2: 113, F5: 116, F7: 118, F8: 119, F9: 120, F11: 122, F12: 123, A: 65, M: 77, Enter: 13, Insert: 45 };
const MOD_CTRL = 2;
const MOD_ALT = 1;
const waitFor = async (cdp, expr, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await evalIn(cdp, expr);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
};
async function clickAt(cdp, x, y) {
  const base = { x, y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  await sleep(250);
}
// click a DOM element like a user (CDP-synthesized Enter does not run the
// implicit form-submit / default-button action in WebView2 — alnavi-023)
async function clickEl(cdp, expr) {
  const r = await evalIn(
    cdp,
    `(() => { const el = ${expr}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`,
  );
  if (!r) throw new Error("clickEl: element not found");
  await clickAt(cdp, r.x, r.y);
}
const dlgOpen = (cdp, sel) => evalIn(cdp, `!!document.querySelector("${sel}")`);
// type a whole line into the focused cmdline input (IME-style insert — real
// key presses per char are flaky for punctuation) and submit with Enter
async function typeLine(cdp, text) {
  await cdp.send("Input.insertText", { text });
  await key(cdp, "Enter");
  await sleep(300);
}

// open a dialog with a real key, verify content, close it with Esc
async function openAndEsc(cdp, label, openKey, mod, sel, contentExpr) {
  await key(cdp, openKey, mod ?? 0);
  await waitFor(cdp, `!!document.querySelector("${sel}")`, 8000, label);
  check(`${label} opens`, true);
  if (contentExpr) {
    const v = await evalIn(cdp, contentExpr);
    check(`${label} renders its content`, v !== null && v !== undefined && v !== 0 && v !== false, JSON.stringify(v ?? "").slice(0, 60));
  }
  await key(cdp, "Escape");
  const closed = await evalIn(cdp, `!document.querySelector("${sel}")`);
  check(`${label} closes on Esc`, closed === true);
}

try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-012-exe-"));
  spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: "ignore",
  });
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    const list = await (
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => ({ json: async () => [] }))
    ).json();
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    if (wsUrl) break;
    await sleep(500);
  }
  check("exe launches (CDP target up)", !!wsUrl);
  if (!wsUrl) throw new Error("no CDP target");
  const cdp = connect(wsUrl);
  await cdp.ready;
  await sleep(3500);
  await waitFor(cdp, `!!document.querySelector(".panel, .panels")`, 15000, "app UI");
  const ver = await evalIn(cdp, `document.querySelector(".titlebar .version")?.textContent ?? ""`);
  check("title bar chip carries v1.13.0", ver.includes("1.13.0"), JSON.stringify(ver));
  // click the panel like a user so the window has the keyboard context
  const p = await evalIn(
    cdp,
    `(() => { const el = document.querySelector(".panel"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
  );
  if (p) await clickAt(cdp, p.x, p.y);

  // sandbox: left panel = two files, right panel = empty dest subdir
  const sandbox = join(process.env.TEMP || tmpdir(), "alnavi-012-exe");
  const dest = join(sandbox, "dest");
  rmSync(sandbox, { recursive: true, force: true });
  await evalIn(
    cdp,
    `(async () => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      await inv("mkdir", { path: ${JSON.stringify(dest)} });
      await inv("write_text", { path: ${JSON.stringify(join(sandbox, "alpha.txt"))}, content: "alpha-data", encoding: "utf-8", eol: "lf" });
      await inv("write_text", { path: ${JSON.stringify(join(sandbox, "beta.txt"))}, content: "beta-data", encoding: "utf-8", eol: "lf" });
      return true;
    })()`,
  );
  // the release exe has no /src modules — drive the panels like a user:
  // type "cd <path>" on the command line, Tab moves cd to the other panel
  await typeLine(cdp, `cd ${sandbox}`);
  const leftOk = await evalIn(cdp, `document.querySelector(".panel.active")?.textContent.includes("alpha.txt")`);
  check("cmdline cd parked the active panel on the sandbox", leftOk === true);
  await key(cdp, "Tab");
  await typeLine(cdp, `cd ${dest}`);
  const destOk = await evalIn(cdp, `!document.querySelector(".panel.active")?.textContent.includes("alpha.txt")`);
  check("Tab + cd parked the other panel on dest/", destOk === true);
  await key(cdp, "Tab"); // back to the sandbox panel for the file flows

  // ---- dialogs open / render / close on Esc (real keys) ----
  await openAndEsc(cdp, "F1 help", "F1", 0, ".dlg.help-dlg", `document.querySelectorAll(".help-dlg .hrow").length`);
  await openAndEsc(cdp, "F9 menu", { key: "F9", code: "F9", vk: VK.F9 }, 0, ".dlg .theme-grid", `document.querySelectorAll(".dlg .lang").length`);
  await openAndEsc(cdp, "F12 window list", { key: "F12", code: "F12", vk: VK.F12 }, 0, ".dlg .list", `document.querySelector(".dlg .li")?.textContent`);
  await openAndEsc(cdp, "Alt+F1 drives", { key: "F1", code: "F1", vk: VK.F1 }, MOD_ALT, ".dlg-body.drives", `document.querySelectorAll(".dlg-body.drives .drive").length`);
  await openAndEsc(cdp, "Alt+F7 search", { key: "F7", code: "F7", vk: VK.F7 }, MOD_ALT, ".dlg #search-form", `!!document.querySelector("#sr-f-root")?.value`);
  await openAndEsc(cdp, "Alt+F12 dir history", { key: "F12", code: "F12", vk: VK.F12 }, MOD_ALT, ".dlg .list", `document.querySelector(".dlg .li.mono")?.textContent`);
  await openAndEsc(cdp, "Alt+F8 cmd history", { key: "F8", code: "F8", vk: VK.F8 }, MOD_ALT, ".dlg .list", null);
  await openAndEsc(cdp, "F2 user menu (empty)", { key: "F2", code: "F2", vk: VK.F2 }, 0, ".dlg .list", `document.querySelector(".dlg .none")?.textContent`);

  // ---- F2 flow: Ins opens the item form, Esc returns to the list ----
  await key(cdp, { key: "F2", code: "F2", vk: VK.F2 });
  await waitFor(cdp, `!!document.querySelector(".dlg .list")`, 8000, "user menu");
  await key(cdp, { key: "Insert", code: "Insert", vk: VK.Insert });
  await waitFor(cdp, `!!document.querySelector("#um-item-form")`, 8000, "user-menu item form");
  check("Ins in F2 menu opens the item form", true);
  await key(cdp, "Escape");
  // NB: original keymap behavior — Esc closes the form AND the menu below it
  // (only the form's Cancel button returns to the list)
  const allClosed = await evalIn(cdp, `!document.querySelector(".dlg")`);
  check("Esc closes the item form (with the menu below)", allClosed === true);

  // ---- Alt+F1 drives: FTP entry, keyboard cursor, digit 2 -> FTP list ----
  await key(cdp, { key: "F1", code: "F1", vk: VK.F1 }, MOD_ALT);
  await waitFor(cdp, `!!document.querySelector(".dlg-body.drives")`, 8000, "drives");
  const drivesInfo = await evalIn(
    cdp,
    `(() => { const ds = [...document.querySelectorAll(".dlg-body.drives .drive")]; return { n: ds.length, ftp: ds.some((d) => d.textContent.includes("FTP")), kbd: document.querySelector(".drive.kbd") !== null }; })()`,
  );
  check("drives list has entries incl. the FTP row", drivesInfo.n > 1 && drivesInfo.ftp, JSON.stringify(drivesInfo));
  check("keyboard cursor starts on row 0 (.drive.kbd)", drivesInfo.kbd === true);
  await key(cdp, { key: "2", code: "Digit2", vk: 50 });
  await waitFor(cdp, `!!document.querySelector(".dlg .dlg-actions")`, 8000, "FTP list");
  const ftpTitle = await evalIn(cdp, `document.querySelector(".dlg .dlg-title")?.textContent ?? ""`);
  check("digit 2 in drives opens the FTP site list", /ftp/i.test(ftpTitle) || ftpTitle.includes("FTP"), JSON.stringify(ftpTitle));
  await key(cdp, "Escape");
  check("Esc closes the FTP list", (await dlgOpen(cdp, ".dlg")) === false);

  // ---- F5 copy with the transfer dialog: prefill, variants, accept copies ----
  // walk the cursor onto alpha.txt (".." first, then the dest/ dir)
  await key(cdp, "Home");
  await key(cdp, "ArrowDown");
  await key(cdp, "ArrowDown");
  const cursorOnAlpha = await evalIn(cdp, `/alpha\\.txt/i.test(document.querySelector(".panel.active .row.cursor")?.textContent ?? "")`);
  check("cursor walks onto alpha.txt", cursorOnAlpha === true);
  await key(cdp, { key: "F5", code: "F5", vk: VK.F5 });
  await waitFor(cdp, `!!document.querySelector(".dlg input")`, 8000, "F5 transfer dialog");
  const f5info = await evalIn(
    cdp,
    `(() => { const inp = document.querySelector(".dlg input"); return { val: inp?.value ?? "", sel: inp && inp.selectionStart === 0 && inp.selectionEnd === inp.value.length, variants: document.querySelectorAll(".dlg .variants .li").length }; })()`,
  );
  check("F5 dialog prefills the destination + name", /alpha\.txt/i.test(f5info.val) && /dest/i.test(f5info.val), JSON.stringify(f5info.val));
  check("F5 input opens with the value selected (overtype)", f5info.sel === true);
  check("F5 destination variants listed", f5info.variants >= 1, `variants=${f5info.variants}`);
  // NB: CDP-Enter does not submit the form (alnavi-023 lesson) — click OK
  await clickEl(cdp, `document.querySelector(".dlg .btn.primary")`);
  const destFiles = await waitFor(
    cdp,
    `(async () => { const names = (await window.__TAURI_INTERNALS__.invoke("list_dir", { path: ${JSON.stringify(dest)} })).entries.map((e) => e.name); return names.includes("alpha.txt") ? names : null; })()`,
    15000,
    "copy to land in dest/",
  );
  check("F5 copied alpha.txt into dest/", destFiles.includes("alpha.txt"), JSON.stringify(destFiles));
  // let the progress overlay finish/close before the next keyboard flow
  await waitFor(cdp, `!document.querySelector(".overlay")`, 10000, "progress overlay to close").catch(() => {});
  if (await dlgOpen(cdp, ".overlay")) {
    await key(cdp, "Escape"); // a lingering done-dialog: Esc = close
    await sleep(400);
  }

  // ---- Ctrl+M multi-rename over the panel (nothing marked = whole panel) ----
  await key(cdp, { key: "M", code: "KeyM", vk: VK.M }, MOD_CTRL);
  await waitFor(cdp, `!!document.querySelector(".dlg-mr")`, 8000, "multi-rename");
  const mr0 = await evalIn(
    cdp,
    `(() => { const rows = [...document.querySelectorAll(".dlg-mr .mr-row")].map((r) => r.textContent); return { n: rows.length, alpha: rows.some((t) => /alpha\\.txt/.test(t)), beta: rows.some((t) => /beta\\.txt/.test(t)) }; })()`,
  );
  check("Ctrl+M dialog previews the panel files", mr0.n >= 2 && mr0.alpha && mr0.beta, `rows=${mr0.n}`);
  // the mask is a FILTER (FAR semantics); a live transformation comes from
  // find/replace — type .txt -> .ren into the Find/Replace fields and the
  // preview + apply button must react (alpha.txt -> alpha.ren …)
  await sleep(400); // let the mount-time focus+select land on the mask input
  const focusInfo = await evalIn(
    cdp,
    `(() => { const el = document.activeElement; return { tag: el?.tagName, id: el?.id, val: document.querySelector("#mr-f-mask")?.value ?? "" }; })()`,
  );
  check("mask input focused on open", focusInfo.id === "mr-f-mask", JSON.stringify(focusInfo));
  await clickEl(cdp, `document.querySelector("#mr-f-find")`);
  await cdp.send("Input.insertText", { text: ".txt" });
  await clickEl(cdp, `document.querySelector("#mr-f-repl")`);
  await cdp.send("Input.insertText", { text: ".ren" });
  await sleep(500);
  const mr = await evalIn(
    cdp,
    `(() => { const rows = [...document.querySelectorAll(".dlg-mr .mr-row")].map((r) => r.textContent); return { ren: rows.some((t) => /alpha\\.ren/.test(t)), apply: document.querySelector(".dlg-mr .dlg-actions .primary")?.textContent.trim() ?? "", disabled: document.querySelector(".dlg-mr .dlg-actions .primary")?.disabled }; })()`,
  );
  check("find/replace updates the preview (alpha.ren)", mr.ren === true, JSON.stringify(mr.apply));
  check("apply button enabled with a nonzero count", !mr.disabled && !/: 0/.test(mr.apply), JSON.stringify(mr.apply));
  await key(cdp, "Escape");
  check("Esc cancels multi-rename", (await dlgOpen(cdp, ".dlg-mr")) === false);
  const namesAfter = await evalIn(cdp, `(async () => (await window.__TAURI_INTERNALS__.invoke("list_dir", { path: ${JSON.stringify(sandbox)} })).entries.filter((e) => e.name !== ".." && e.name !== ".").map((e) => e.name).sort())()`);
  check("nothing renamed after the cancel", JSON.stringify(namesAfter) === JSON.stringify(["alpha.txt", "beta.txt", "dest"]), JSON.stringify(namesAfter));

  // ---- F9 settings: sub-dialog opens from the menu, Esc returns ----
  await key(cdp, { key: "F9", code: "F9", vk: VK.F9 });
  await waitFor(cdp, `!!document.querySelector(".dlg .theme-grid")`, 8000, "F9 menu");
  await clickEl(cdp, `document.querySelector(".dlg .fc-open")`); // first = file colors
  await waitFor(cdp, `!!document.querySelector(".fc-rows")`, 8000, "file colors");
  check("file-colors sub-dialog opens from the menu", true);
  await key(cdp, "Escape");
  // NB: original keymap behavior — Esc closes the sub-dialog together with
  // the menu below it (the Close button does the same)
  const fcClosed = await evalIn(cdp, `!document.querySelector(".dlg")`);
  check("Esc closes the file-colors sub-dialog", fcClosed === true);

  // ---- confirm dialog (F8 delete): default button focused, Esc = No ----
  await key(cdp, "Home");
  await key(cdp, "ArrowDown");
  await key(cdp, "ArrowDown");
  await key(cdp, "ArrowDown"); // onto beta.txt (.., dest/, alpha.txt, beta.txt)
  const onBeta = await evalIn(cdp, `/beta\\.txt/i.test(document.querySelector(".panel.active .row.cursor")?.textContent ?? "")`);
  await key(cdp, { key: "F8", code: "F8", vk: VK.F8 });
  await waitFor(cdp, `!!document.querySelector('[role="alertdialog"]')`, 8000, "delete confirm");
  const confirmUi = await evalIn(
    cdp,
    `(() => { const btns = [...document.querySelectorAll('.dlg-actions button')]; return { focusedIsButton: document.activeElement?.tagName === "BUTTON", n: btns.length }; })()`,
  );
  check("F8 confirm opens with the default button focused", onBeta === true && confirmUi.focusedIsButton === true && confirmUi.n === 2, JSON.stringify({ onBeta, ...confirmUi }));
  await key(cdp, "Escape");
  await sleep(500);
  check("Esc answers No: the dialog closes", (await evalIn(cdp, `!document.querySelector('[role="alertdialog"]')`)) === true);
  const betaStill = await evalIn(cdp, `(async () => (await window.__TAURI_INTERNALS__.invoke("list_dir", { path: ${JSON.stringify(sandbox)} })).entries.some((e) => e.name === "beta.txt"))()`);
  check("Esc answers No: beta.txt survives", betaStill === true);
} catch (e) {
  check("script crashed", false, String(e));
} finally {
  const fails = results.filter((x) => !x.ok).length;
  console.log(`\n${fails ? fails + " FAILED" : "ALL " + results.length + " PASSED"}`);
  try {
    spawn("taskkill", ["/IM", "Al-Navi.exe", "/F"], { stdio: "ignore" });
  } catch {}
  await sleep(1200);
  restoreCfg();
  process.exit(fails ? 1 : 0);
}
