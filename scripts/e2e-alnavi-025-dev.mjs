// Dev E2E for alnavi-025: the Ctrl+Shift+F4 scratchpad (a text file in RAM).
// From the panels: the chord must open an editor document with no path and
// the scratch flag — typing goes in, but the doc never turns dirty. A second
// chord press focuses the SAME pad (no duplicate). F2 refuses with a toast
// (no dialog, path stays null). Ctrl+Tab walks the ring editor->panels and
// back. Esc closes instantly — no save prompt, the doc is gone; a reopen
// starts empty. Shift+F2 turns the pad into a real file (write_text through
// the mock, scratch flag cleared). Real key events via CDP.
// Usage: node scripts/e2e-alnavi-025-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9251;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-025-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = await fetch(`${ORIGIN}/`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
const ours = alive && alive.includes("Al-Navi") ? null : spawn("npm", ["run", "dev"], { shell: true, stdio: "ignore" });
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
    await sleep(250);
  }
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
  return { ready, send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); }, close: () => ws.close() };
}
async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

const VK = { F2: 113, F4: 115, Tab: 9, Escape: 27, Enter: 13 };
const MOD = { ctrl: 2, shift: 8 };
async function key(cdp, k, { ctrl = false, shift = false } = {}) {
  let modifiers = 0;
  if (ctrl) modifiers += MOD.ctrl;
  if (shift) modifiers += MOD.shift;
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k] ?? 0, modifiers };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(100);
}
async function type(cdp, text) {
  for (const ch of text) {
    let code;
    if (/[a-z]/i.test(ch)) code = "Key" + ch.toUpperCase();
    else if (ch === " ") code = "Space";
    const base = { key: ch, code, windowsVirtualKeyCode: ch === " " ? 32 : ch.toUpperCase().charCodeAt(0) };
    await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown", text: ch });
    await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    await sleep(20);
  }
  await sleep(120);
}

try {
  const step = (m) => console.log(`-- ${m}`);
  step("waiting vite");
  await waitFor(() => fetch(`${ORIGIN}/`).then((r) => (r.ok ? true : null)), 30000, "vite dev");
  step("waiting edge cdp");
  const targets = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.find((t) => t.type === "page");
  }, 20000, "edge cdp");
  const cdp = await connect(targets.webSocketDebuggerUrl);
  await cdp.ready;

  step("navigating");
  await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  await sleep(2500);
  // headless pages start without renderer focus; the flag must be set AFTER
  // the navigation (a new document resets it)
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  step("bootstrapping stores + backend mock");
  await evalIn(cdp, `
    (async () => {
      const rows = [];
      for (let i = 1; i <= 10; i++) {
        rows.push({ name: "file" + String(i).padStart(2, "0") + ".txt", isDir: false, size: 100 * i, mtime: 0, attrs: "", isSymlink: false, isHidden: false });
      }
      window.__e2eWrites = [];
      window.__e2eCbSeq = 0;
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__TAURI_INTERNALS__.transformCallback = () => ++window.__e2eCbSeq;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen": return Promise.resolve(++window.__e2eCbSeq);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": return Promise.resolve({ path: args.path, entries: rows, freeBytes: 0, totalBytes: 0 });
          case "home_path": return Promise.resolve("D:\\\\e2e");
          case "drives_list": return Promise.resolve([
            { name: "Local (C:)", mountPoint: "C:\\\\", kind: "fixed", totalBytes: 500000000000, freeBytes: 100000000000 },
          ]);
          case "load_json": return Promise.resolve(null);
          case "save_json": return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          case "write_text": window.__e2eWrites.push({ path: args.path, text: args.content }); return Promise.resolve(null);
          default: return Promise.resolve(null);
        }
      };
      const imp = new Function("u", "return import(u)");
      // full ".svelte.ts" URLs — the app resolves its $lib specifiers to these;
      // a bare ".svelte" URL would create a SECOND store instance and every
      // assertion below would read a disconnected copy
      const { panels } = await imp("${ORIGIN}/src/lib/stores/panels.svelte.ts");
      const { editor } = await imp("${ORIGIN}/src/lib/stores/editor.svelte.ts");
      const { ui } = await imp("${ORIGIN}/src/lib/stores/ui.svelte.ts");
      window.__e2e = { panels, editor, ui };
      await panels.init();
      return window.__e2e.panels.left.view.length;
    })()
  `);

  const state = () => evalIn(cdp, `
    (() => {
      const { editor, ui } = window.__e2e;
      const d = editor.active;
      return {
        mode: ui.mode,
        dialog: ui.dialog,
        toast: ui.toast ? ui.toast.text : null,
        docs: editor.docs.map((x) => ({ id: x.id, path: x.path, name: x.name, scratch: !!x.scratch, dirty: x.dirty, text: x.text })),
        hasEditorDom: !!document.querySelector(".editor .cm-editor"),
        tabDot: !!document.querySelector(".doc-tab.on .dot"),
      };
    })()
  `);

  step("Ctrl+Shift+F4 opens the scratchpad");
  await key(cdp, "F4", { ctrl: true, shift: true });
  let s = await state();
  check("mode switched to editor", s.mode === "editor", JSON.stringify({ mode: s.mode }));
  check("one doc: no path, scratch flag, empty", s.docs.length === 1 && s.docs[0].path === null && s.docs[0].scratch === true && s.docs[0].text === "",
    JSON.stringify(s.docs));
  check("CodeMirror editor is rendered", s.hasEditorDom === true);
  const firstId = s.docs[0]?.id;

  step("typing text");
  // CodeMirror owns the caret in editor mode; give it a beat to focus
  await sleep(400);
  await type(cdp, "hello scratch");
  s = await state();
  check("typed text lives in the doc", s.docs.length === 1 && s.docs[0].text === "hello scratch", JSON.stringify(s.docs[0]?.text));
  check("scratch never turns dirty (no save prompt can appear)", s.docs[0]?.dirty === false && s.tabDot === false,
    `dirty=${s.docs[0]?.dirty} tabDot=${s.tabDot}`);

  step("second Ctrl+Shift+F4 focuses the same pad");
  await key(cdp, "F4", { ctrl: true, shift: true });
  s = await state();
  check("no duplicate: still one doc, same id, text kept", s.docs.length === 1 && s.docs[0].id === firstId && s.docs[0].text === "hello scratch",
    `docs=${s.docs.length} id=${s.docs[0]?.id}`);

  step("F2 refuses to save with a toast");
  await key(cdp, "F2");
  s = await state();
  check("toast shown (memory-only hint)", typeof s.toast === "string" && s.toast.length > 0 && s.toast.includes("Shift+F2"), JSON.stringify(s.toast));
  check("no dialog opened, path stays null", s.dialog === null && s.docs[0]?.path === null, JSON.stringify({ dialog: s.dialog, path: s.docs[0]?.path }));
  check("nothing was written to disk through the mock", (await evalIn(cdp, `window.__e2eWrites.length`)) === 0);

  step("Ctrl+Tab ring: editor -> panels -> back");
  await key(cdp, "Tab", { ctrl: true });
  s = await state();
  check("Ctrl+Tab collapses to the panels (doc stays in memory)", s.mode === "panels" && s.docs.length === 1 && s.docs[0].text === "hello scratch",
    JSON.stringify({ mode: s.mode }));
  await key(cdp, "Tab", { ctrl: true, shift: true });
  s = await state();
  check("Ctrl+Shift+Tab returns to the scratchpad", s.mode === "editor" && s.docs[0]?.id === firstId, JSON.stringify({ mode: s.mode }));

  step("Esc closes instantly, text discarded");
  await key(cdp, "Escape");
  s = await state();
  check("closed with no save prompt: doc gone, back on panels", s.mode === "panels" && s.docs.length === 0 && s.dialog === null,
    JSON.stringify({ mode: s.mode, docs: s.docs.length, dialog: s.dialog }));

  step("reopen starts empty");
  await key(cdp, "F4", { ctrl: true, shift: true });
  s = await state();
  check("a fresh pad is empty (previous text discarded)", s.docs.length === 1 && s.docs[0].id !== firstId && s.docs[0].text === "",
    JSON.stringify(s.docs));

  step("Shift+F2 converts the pad into a real file");
  await sleep(300);
  await type(cdp, "keep me");
  await key(cdp, "F2", { shift: true });
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".overlay input")`), 5000, "save-as dialog");
  check("save-as dialog opened", true);
  // prefill is "new-file.txt" for a pathless doc
  const prefill = await evalIn(cdp, `document.querySelector(".overlay input").value`);
  check("prefill offers new-file.txt", prefill === "new-file.txt", JSON.stringify(prefill));
  // headless doesn't synthesize Enter activation (alnavi-023 lesson) and CDP
  // typing of punctuation into the field is unreliable — set the value like
  // an IME would and click OK
  await evalIn(cdp, `
    (() => {
      const i = document.querySelector(".overlay input");
      i.focus();
      i.value = "D:\\\\e2e\\\\saved.txt";
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()
  `);
  await evalIn(cdp, `document.querySelector(".dlg-actions .btn.primary").click(); true`);
  await sleep(600);
  s = await state();
  const writes = await evalIn(cdp, `window.__e2eWrites`);
  check("write_text went through the mock once", Array.isArray(writes) && writes.length === 1 && writes[0].path === "D:\\e2e\\saved.txt" && writes[0].text === "keep me",
    JSON.stringify(writes));
  check("doc converted: path set, scratch cleared, not dirty", s.docs.length === 1 && s.docs[0].path === "D:\\e2e\\saved.txt" && s.docs[0].scratch === false && s.docs[0].dirty === false,
    JSON.stringify(s.docs));

  step("the chord still makes a NEW pad next to a real file doc");
  await key(cdp, "F4", { ctrl: true, shift: true });
  s = await state();
  check("second doc is a fresh scratchpad", s.docs.length === 2 && s.docs[1].scratch === true && s.docs[1].path === null && s.docs[1].text === "",
    JSON.stringify(s.docs.map((d) => ({ p: d.path, sc: d.scratch }))));
  await key(cdp, "Escape"); // close the scratch again — no prompt for it
  s = await state();
  check("Esc closed only the scratch, the file doc remains", s.docs.length === 1 && s.docs[0].path === "D:\\e2e\\saved.txt" && s.mode === "editor",
    JSON.stringify({ mode: s.mode, docs: s.docs.length }));

  step("done");
} catch (e) {
  check("script crashed", false, String(e));
} finally {
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
  edge.kill();
  if (ours) ours.kill();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
