// Dev E2E for alnavi-043: Ctrl+F7 in the editor opens a FAR-style modal
// Replace dialog — search text, replace text, case/whole-word/regex options,
// «Заменить» walks match by match (первое, потом следующее…), «Пропустить»
// advances without replacing, «Заменить всё» rewrites everything at once.
// Plain F7 keeps opening CodeMirror's own find panel. In panels mode Ctrl+F7
// stays the unsorted sort (no dialog). REAL keys are driven through CDP.
// Usage: node scripts/e2e-alnavi-043-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9277;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-043-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOC = "one two three\none two three";
const FILE = "D:\\e2e\\rep.txt";

// installed before any app script runs (see e2e-040 for the rationale)
const INIT_MOCK = `
(() => {
  const mk = (name, isDir, size, mtime) => ({ name, isDir, size, mtime, attrs: "", isSymlink: false, isHidden: false });
  const rows = [mk("rep.txt", false, 100, 1000), mk("data", true, 0, 3000)];
  window.__e2eCbSeq = 0;
  window.__cbs = {};
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = { currentWindow: "main", currentWebview: "main" };
  window.__TAURI_INTERNALS__.transformCallback = (cb) => {
    const id = ++window.__e2eCbSeq;
    window.__cbs[id] = cb;
    return id;
  };
  window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
    switch (cmd) {
      case "plugin:event|listen":
        window.__cbs[args.handler] = args.handler;
        return Promise.resolve(args.handler);
      case "plugin:event|unlisten": return Promise.resolve();
      case "list_dir": return Promise.resolve({ path: args.path, entries: rows, freeBytes: 0, totalBytes: 0 });
      case "home_path": return Promise.resolve("D:\\\\e2e");
      case "drives_list": return Promise.resolve([]);
      case "load_json": return Promise.resolve(null);
      case "save_json": return Promise.resolve(null);
      case "free_space": return Promise.resolve([0, 0]);
      case "read_text": return Promise.resolve({ text: ${JSON.stringify(DOC)}, encoding: "utf-8", eol: "lf", truncated: false });
      case "write_text": return Promise.resolve(null);
      case "path_exists": return Promise.resolve(false);
      default: return Promise.resolve(null);
    }
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => /updates\\/alnavi/.test(String(url))
    ? Promise.reject(new Error("e2e: update center blocked"))
    : origFetch(url, opts);
})();
`;

const alive = await fetch(`${ORIGIN}/`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
const vite = alive && alive.includes("Al-Navi") ? null : spawn("npm", ["run", "dev"], { shell: true, stdio: "ignore" });
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  "--window-size=1280,800",
  "about:blank",
], { stdio: "ignore" });

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  };
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  return {
    ready, events,
    send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); },
    close: () => ws.close(),
  };
}
async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
let cdp;
async function key(def) {
  await cdp.send("Input.dispatchKeyEvent", { ...def, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode, type: "keyUp" });
}
const CTRL = 2;
const f7 = () => key({ key: "F7", code: "F7", windowsVirtualKeyCode: 118 });
const ctrlF7 = () => key({ key: "F7", code: "F7", windowsVirtualKeyCode: 118, modifiers: CTRL });
const esc = () => key({ key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
// keyDown carries `text` ("\r") so the browser performs the default action
// too (implicit form submission) — exactly what a physical Enter does
const enter = () => key({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
const type = (t) => cdp.send("Input.insertText", { text: t });

// live stores of the running app (full .svelte.ts URL — see memory lessons)
const stImport = `new Function("u", "return import(u)")("/src/lib/stores/editor.svelte.ts")`;
const cmImport = `new Function("u", "return import(u)")("/src/lib/editor/cm.ts")`;
const editorFacts = () => evalIn(cdp, `(async () => {
  const st = await (${stImport});
  const cm = await (${cmImport});
  const v = cm.currentView();
  const sel = v ? v.state.selection.main : null;
  return {
    text: st.editor.active?.text ?? null,
    selText: sel && !sel.empty ? v.state.sliceDoc(sel.from, sel.to) : "",
    dirty: st.editor.active?.dirty ?? null,
  };
})()`);
const dlgFacts = () => evalIn(cdp, `(() => ({
  dlg: !!document.querySelector(".dlg"),
  focusedFind: document.activeElement === document.querySelector("#rp-f-find"),
  find: document.querySelector("#rp-f-find")?.value ?? null,
  repl: document.querySelector("#rp-f-with")?.value ?? null,
  case: document.querySelectorAll(".dlg-body input[type=checkbox]")[0]?.checked ?? null,
  word: document.querySelectorAll(".dlg-body input[type=checkbox]")[1]?.checked ?? null,
  re: document.querySelectorAll(".dlg-body input[type=checkbox]")[2]?.checked ?? null,
  toast: document.querySelector(".toast")?.textContent ?? null,
}))()`);
/** focus+select a dialog field (real input events, so bind:value follows) */
const setField = (sel, text) => evalIn(cdp, `(() => {
  const i = document.querySelector(${JSON.stringify(sel)});
  i.focus(); i.select();
})()`).then(() => type(text));
const setCheck = (idx, on) => evalIn(cdp, `(() => {
  const c = document.querySelectorAll(".dlg-body input[type=checkbox]")[${idx}];
  if (c.checked !== ${!!on}) c.click();
})()`);
const clickBtn = (id) => evalIn(cdp, `document.querySelector(${JSON.stringify("#" + id)}).click(); true`);
const openFile = () => evalIn(cdp, `(async () => {
  const st = await (${stImport});
  await st.editor.open(${JSON.stringify(FILE)});
})()`).then(() => waitFor(() => evalIn(cdp, `!!document.querySelector(".cm-editor")`), 15000, "CodeMirror view"));

try {
  const step = (m) => console.log(`-- ${m}`);
  step("waiting vite");
  await waitFor(() => fetch(`${ORIGIN}/`).then((r) => (r.ok ? true : null)), 30000, "vite dev");
  step("waiting edge cdp");
  const targets = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.find((t) => t.type === "page");
  }, 20000, "edge cdp");
  cdp = await connect(targets.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  step("installing pre-boot mock + navigating");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT_MOCK });
  await cdp.send("Page.navigate", { url: `${ORIGIN}/?r=${Math.random().toFixed(8)}` });
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell") && !!document.querySelector(".cmdline input")`), 30000, "app UI");
  await waitFor(() => evalIn(cdp, `!!window.__TAURI_INTERNALS__.invoke`), 5000, "mock active");
  await sleep(1200); // let the app settle

  step("opening the test file in the editor");
  await openFile();
  let f = await editorFacts();
  check("file opened with the mock text", f.text === DOC, JSON.stringify(f));

  step("Ctrl+F7 opens the modal replace dialog");
  await ctrlF7(); await sleep(300);
  f = await dlgFacts();
  check("replace dialog is open", f.dlg === true, JSON.stringify(f));
  check("focus lands in the find field", f.focusedFind === true, JSON.stringify(f));

  step("step-by-step replace: one -> 1");
  await setField("#rp-f-find", "one");
  await setField("#rp-f-with", "1");
  await sleep(100);
  await enter(); await sleep(200); // 1st: selects the first match (preview)
  f = await editorFacts();
  check("first press selects the first match (no change yet)", f.selText === "one" && f.text === DOC, JSON.stringify(f));
  await enter(); await sleep(200); // 2nd: replaces it, selects the next
  f = await editorFacts();
  check("second press replaces it and selects the next", f.text === "1 two three\none two three" && f.selText === "one", JSON.stringify(f));
  check("document is now dirty", f.dirty === true, `dirty=${f.dirty}`);

  step("skip leaves the remaining match alone");
  await clickBtn("rp-btn-skip");
  await sleep(200);
  f = await editorFacts();
  check("skip keeps the text and a match selected", f.text === "1 two three\none two three" && f.selText === "one", JSON.stringify(f));

  step("«Заменить всё» finishes the job");
  await clickBtn("rp-btn-all");
  await sleep(300);
  f = await dlgFacts();
  const ef = await editorFacts();
  check("dialog closed after replace all", f.dlg === false, JSON.stringify(f));
  check("all occurrences replaced", ef.text === "1 two three\n1 two three", JSON.stringify(ef));
  check("toast reports the count", f.toast === "Replaced: 1", `toast=${f.toast}`);

  step("parameters remembered on reopen + regex with $1");
  await ctrlF7(); await sleep(250);
  f = await dlgFacts();
  check("last search/replace prefilled", f.find === "one" && f.repl === "1", JSON.stringify(f));
  await setField("#rp-f-find", "t(w)o");
  await setField("#rp-f-with", "2-$1");
  await setCheck(2, true); // regexp
  await sleep(100);
  await clickBtn("rp-btn-all");
  await sleep(300);
  const ef2 = await editorFacts();
  f = await dlgFacts();
  check("regex $1 replacement works", ef2.text === "1 2-w three\n1 2-w three", JSON.stringify(ef2));
  check("toast reports 2 regex replacements", f.toast === "Replaced: 2", `toast=${f.toast}`);

  step("case-sensitive miss toasts and changes nothing");
  await ctrlF7(); await sleep(250);
  await setField("#rp-f-find", "THREE");
  await setCheck(2, false); // regex off — plain text search
  await setCheck(0, true); // case sensitive on
  await sleep(100);
  await clickBtn("rp-btn-all");
  await sleep(300);
  f = await dlgFacts();
  const ef3 = await editorFacts();
  check("case-sensitive miss closes with the not-found toast", f.dlg === false && (f.toast ?? "").includes("Nothing found"), `toast=${f.toast}`);
  check("text unchanged on miss", ef3.text === "1 2-w three\n1 2-w three", JSON.stringify(ef3));

  step("Esc just closes the dialog");
  await ctrlF7(); await sleep(250);
  await esc(); await sleep(250);
  f = await dlgFacts();
  check("Esc closes the replace dialog", f.dlg === false, JSON.stringify(f));

  step("panels mode: Ctrl+F7 stays the sort, not the dialog");
  await esc(); await sleep(500); // dirty doc -> the save-confirm dialog opens
  await esc(); await sleep(500); // second Esc: don't save, close the document
  const mode = await evalIn(cdp, `(async () => {
    const ui = await new Function("u", "return import(u)")("/src/lib/stores/ui.svelte.ts");
    return ui.ui.mode;
  })()`);
  await ctrlF7(); await sleep(300);
  f = await dlgFacts();
  check("Ctrl+F7 on panels opens no dialog", mode === "panels" && f.dlg === false, `mode=${mode} dlg=${f.dlg}`);

  step("F7 in the editor still opens the CodeMirror find panel");
  await openFile();
  await f7(); await sleep(400);
  const panel = await evalIn(cdp, `!!document.querySelector(".cm-panel")`);
  check("F7 opens CodeMirror's own search panel", panel === true, `panel=${panel}`);
} catch (e) {
  console.error(e);
} finally {
  edge.kill();
  try { vite?.kill(); } catch {}
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
}
