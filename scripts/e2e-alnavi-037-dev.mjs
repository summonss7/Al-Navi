// Dev E2E for alnavi-037: F8 in the editor (Shift+F8 in the viewer) opens
// the encoding picker and re-reads the file in the chosen encoding; Ctrl+Y
// keeps delete-line. Verified against the vite dev build with a mocked
// Tauri backend, driving REAL keys through CDP:
//   - F4 opens the file (auto-detect -> windows-1251 mojibake)
//   - F8 opens the encoding dialog with the cursor on the current encoding
//   - navigating to KOI8-R + Enter re-reads the file (read_text got
//     encoding="koi8-r"), the editor text swaps in place, both lines intact
//     (F8 no longer deletes a line)
//   - Esc closes the picker without touching the text
//   - Ctrl+Y still deletes the current line
//   - with unsaved changes the picker asks for a reload confirm: Esc keeps
//     the edits, Yes re-reads from disk (dirty resets)
//   - viewer: F3 opens, Shift+F8 re-reads in UTF-16LE, the status chip
//     shows the encoding, F8 still toggles hex
// Usage: node scripts/e2e-alnavi-037-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9274;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-037-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AUTO_TEXT = "ЛКЯЮ_моjibake_auto\nsecond line auto";
const KOI8_TEXT = "Привет из KOI8-R\nвторой пункт";
const U16_TEXT = "Привет из UTF-16LE\nстрока два";

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
async function key(cdp, name, vk, mods = 0) {
  const base = { key: name, code: name, windowsVirtualKeyCode: vk, modifiers: mods, location: 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}
const CTRL = 2;
const SHIFT = 8;

async function bootstrap(cdp) {
  await cdp.send("Page.navigate", { url: `${ORIGIN}/?r=${Math.random().toFixed(8)}` });
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell") && !!document.querySelector(".cmdline input")`).catch(() => null), 30000, "app UI");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await evalIn(cdp, `
    (async () => {
      const mk = (name, isDir, size, mtime) => ({ name, isDir, size, mtime, attrs: "", isSymlink: false, isHidden: false });
      const rows = [mk("notes.txt", false, 100, 1000), mk("other.txt", false, 50, 1000)];
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      window.__cbs = {};
      window.__listeners = {};
      window.__e2e = { readTextCalls: [] };
      window.__TAURI_INTERNALS__.transformCallback = (cb) => {
        const id = ++window.__e2eCbSeq;
        window.__cbs[id] = cb;
        return id;
      };
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen":
            window.__listeners[args.event] = args.handler;
            return Promise.resolve(args.handler);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": return Promise.resolve({ path: args.path, entries: rows, freeBytes: 0, totalBytes: 0 });
          case "home_path": return Promise.resolve("D:\\\\e2e");
          case "drives_list": return Promise.resolve([]);
          case "load_json": return Promise.resolve(null);
          case "save_json": return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          case "read_text": {
            window.__e2e.readTextCalls.push({ path: args.path, encoding: args.encoding });
            const enc = args.encoding ?? "auto";
            if (enc === "koi8-r") return Promise.resolve({ text: ${JSON.stringify(KOI8_TEXT)}, encoding: "koi8-r", bom: false, eol: "lf", size: 100, truncated: false });
            if (enc === "utf-16le") return Promise.resolve({ text: ${JSON.stringify(U16_TEXT)}, encoding: "utf-16le", bom: false, eol: "lf", size: 100, truncated: false });
            return Promise.resolve({ text: ${JSON.stringify(AUTO_TEXT)}, encoding: "windows-1251", bom: false, eol: "lf", size: 100, truncated: false });
          }
          default: return Promise.resolve(null);
        }
      };
      const imp = new Function("u", "return import(u)");
      const { panels } = await imp("${ORIGIN}/src/lib/stores/panels.svelte.ts");
      const { editor } = await imp("${ORIGIN}/src/lib/stores/editor.svelte.ts");
      const { ui } = await imp("${ORIGIN}/src/lib/stores/ui.svelte.ts");
      window.__e2e.p = panels;
      window.__e2e.editor = editor;
      window.__e2e.ui = ui;
      await panels.init();
      return { view: panels.left.view.length };
    })()
  `);
  await waitFor(() => evalIn(cdp, `window.__e2e?.p?.left?.view?.length === 3 ? true : null`).catch(() => null), 15000, "left panel loaded");
  await sleep(400);
}

const docFacts = (cdp) => evalIn(cdp, `(() => {
  const d = window.__e2e.editor.active;
  return d ? { text: d.text, encoding: d.encoding, dirty: d.dirty, mode: window.__e2e.ui.mode } : null;
})()`);
const viewFacts = (cdp) => evalIn(cdp, `(() => {
  const d = window.__e2e.editor.activeViewer;
  return d ? { text: d.text, encoding: d.encoding, mode: d.mode, uiMode: window.__e2e.ui.mode } : null;
})()`);
const dialogRows = (cdp) => evalIn(cdp, `(() => {
  if (window.__e2e.ui.dialog !== "encoding") return null;
  const rows = [...document.querySelectorAll(".dlg-body .li")];
  return rows.map((r, i) => ({ label: r.textContent.trim(), kbd: r.classList.contains("kbd"), i }));
})()`);
const cmText = (cdp) => evalIn(cdp, `document.querySelector(".cm-content")?.textContent ?? null`);

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

  step("bootstrapping stores + backend mock");
  await bootstrap(cdp);

  step("F4 opens notes.txt (auto-detect -> windows-1251)");
  await evalIn(cdp, `(() => { const p = window.__e2e.p.left; p.cursor = p.view.findIndex((e) => e.name === "notes.txt"); return p.current?.name; })()`);
  await key(cdp, "F4", 115);
  await waitFor(() => docFacts(cdp).then((f) => (f && f.mode === "editor" ? f : null)), 10000, `editor mode (state=${await evalIn(cdp, `JSON.stringify({ mode: window.__e2e.ui?.mode, docs: window.__e2e.editor?.docs?.length, calls: window.__e2e.readTextCalls })`)})`);
  let f = await docFacts(cdp);
  check("editor opened with auto-detected windows-1251", f.encoding === "windows-1251" && f.text === AUTO_TEXT, JSON.stringify(f));

  step("F8 opens the encoding picker, cursor on the current encoding");
  await key(cdp, "F8", 119);
  await sleep(200);
  let rows = await dialogRows(cdp);
  check("picker shows auto + 7 encodings", rows !== null && rows.length === 8, rows ? rows.map((r) => r.label).join("|") : "no dialog");
  check("keyboard cursor starts on Windows-1251 (current)", rows?.[4]?.kbd === true && /Windows-1251/.test(rows[4].label), rows?.find((r) => r.kbd)?.label ?? "none");

  step("Esc closes the picker, text untouched");
  await key(cdp, "Escape", 27);
  await sleep(150);
  f = await docFacts(cdp);
  check("picker closed by Esc", await evalIn(cdp, `window.__e2e.ui.dialog`) === null);
  check("text unchanged after Esc", f.text === AUTO_TEXT && f.encoding === "windows-1251");

  step("F8 -> KOI8-R: file re-read, content swapped in place");
  await key(cdp, "F8", 119);
  await sleep(150);
  rows = await dialogRows(cdp);
  check("picker reopened", rows !== null);
  await key(cdp, "ArrowDown", 40); // windows-1251 -> koi8-r
  await sleep(120);
  rows = await dialogRows(cdp);
  check("cursor moved to KOI8-R", rows?.[5]?.kbd === true && /KOI8-R/.test(rows[5].label), rows?.find((r) => r.kbd)?.label ?? "none");
  await key(cdp, "Enter", 13);
  await waitFor(() => docFacts(cdp).then((x) => (x && x.encoding === "koi8-r" ? x : null)), 10000, "koi8-r reload");
  f = await docFacts(cdp);
  check("read_text called with encoding=koi8-r", await evalIn(cdp, `window.__e2e.readTextCalls.at(-1)?.encoding`) === "koi8-r");
  check("store text is the decoded KOI8-R text", f.text === KOI8_TEXT, JSON.stringify(f.text));
  const editorCm = await cmText(cdp);
  check("CodeMirror shows the decoded text (rev swap worked)", editorCm?.includes("Привет из KOI8-R") === true, JSON.stringify(editorCm));
  check("F8 did NOT delete a line (both lines present)", f.text === KOI8_TEXT && f.dirty === false);
  check("status-bar encoding select follows", await evalIn(cdp, `document.querySelectorAll(".ed-status select")[1]?.value`) === "koi8-r");

  step("Ctrl+Y still deletes the current line");
  await key(cdp, "y", 89, CTRL);
  await sleep(200);
  f = await docFacts(cdp);
  check("first line gone, doc marked dirty", f.text === "второй пункт" && f.dirty === true, JSON.stringify(f.text));

  step("dirty doc: picker asks to reload, Esc keeps the edits");
  await key(cdp, "F8", 119);
  await sleep(150);
  await key(cdp, "ArrowUp", 38); // koi8-r -> windows-1251
  await sleep(120);
  await key(cdp, "Enter", 13);
  await waitFor(() => evalIn(cdp, `window.__e2e.ui.dialog === "confirm" ? true : null`), 5000, "reload confirm");
  check("reload confirm appeared for the dirty doc", ((await evalIn(cdp, `document.querySelector(".dlg-body")?.textContent`)) ?? "").includes("notes.txt") === true);
  await key(cdp, "Escape", 27);
  await sleep(200);
  f = await docFacts(cdp);
  check("Esc kept the edits (no reload)", f.text === "второй пункт" && f.dirty === true, JSON.stringify(f.text));

  step("dirty doc: Yes reloads from disk in the new encoding");
  await key(cdp, "F8", 119);
  await sleep(150);
  await key(cdp, "ArrowUp", 38); // koi8-r -> windows-1251
  await sleep(120);
  await key(cdp, "ArrowUp", 38); // -> utf-16be
  await sleep(120);
  await key(cdp, "ArrowUp", 38); // -> utf-16le
  await sleep(120);
  await key(cdp, "Enter", 13);
  await waitFor(() => evalIn(cdp, `window.__e2e.ui.dialog === "confirm" ? true : null`), 5000, "reload confirm 2");
  // a CDP-synthesized Enter does not run the browser's default button action
  // (same lesson as alnavi-023) — click the focused «Yes» directly
  await evalIn(cdp, `document.querySelector(".dlg-actions .primary").click()`);
  await waitFor(() => docFacts(cdp).then((x) => (x && x.encoding === "utf-16le" ? x : null)), 10000, `utf-16le reload (state=${JSON.stringify(await docFacts(cdp))})`);
  f = await docFacts(cdp);
  check("reloaded as UTF-16LE, dirty reset", f.text === U16_TEXT && f.dirty === false, JSON.stringify(f.text));

  step("Esc closes the editor doc");
  await key(cdp, "Escape", 27);
  await waitFor(() => evalIn(cdp, `window.__e2e.ui.mode === "panels" ? true : null`), 5000, "back to panels");

  step("viewer: F3 opens, Shift+F8 re-reads in UTF-16LE");
  await key(cdp, "F3", 114);
  await waitFor(() => viewFacts(cdp).then((v) => (v && v.uiMode === "viewer" ? v : null)), 10000, "viewer mode");
  let v = await viewFacts(cdp);
  check("viewer opened auto (windows-1251)", v.encoding === "windows-1251" && v.text === AUTO_TEXT, JSON.stringify(v));
  await waitFor(() => evalIn(cdp, `[...document.querySelectorAll(".v-status .btn.small")].some((b) => b.textContent.trim() === "Windows-1251") ? true : null`), 5000, "encoding chip");
  check("status chip shows the encoding", true);
  await key(cdp, "F8", 119, SHIFT);
  await sleep(200);
  rows = await dialogRows(cdp);
  check("Shift+F8 opened the picker in the viewer", rows !== null && rows[4].kbd === true);
  await key(cdp, "ArrowUp", 38); // -> utf-16be
  await sleep(120);
  await key(cdp, "ArrowUp", 38); // -> utf-16le
  await sleep(120);
  await key(cdp, "Enter", 13);
  await waitFor(() => viewFacts(cdp).then((x) => (x && x.encoding === "utf-16le" ? x : null)), 10000, "viewer utf-16le reload");
  v = await viewFacts(cdp);
  check("viewer text re-read as UTF-16LE", v.text === U16_TEXT && v.mode === "text", JSON.stringify(v.text));
  check("viewer CodeMirror shows the new text", (await cmText(cdp))?.includes("Привет из UTF-16LE") === true);
  check("chip updated to UTF-16 LE", await evalIn(cdp, `[...document.querySelectorAll(".v-status .btn.small")].some((b) => b.textContent.trim() === "UTF-16 LE")`));

  step("F8 in the viewer still toggles hex");
  await key(cdp, "F8", 119);
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".hex-wrap") ? true : null`), 5000, "hex mode");
  check("viewer switched to hex", (await viewFacts(cdp)).mode === "hex");

  step("console errors");
  const errors = cdp.events.filter((e) =>
    (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") ||
    (e.method === "Runtime.exceptionThrown") ||
    (e.method === "Log.entryAdded" && e.params.entry.level === "error"),
  );
  const errText = (e) => {
    if (e.method === "Log.entryAdded") return `${e.params.entry.text} ${e.params.entry.url ?? ""}`;
    return (e.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
  };
  const real = errors.filter((e) => !/favicon|404 \(Not Found\)/.test(errText(e)));
  check("no console errors", real.length === 0, real.map(errText).join(" | "));
  if (real.length !== errors.length) console.log(`(ignored ${errors.length - real.length} dev-harness 404 noise)`);

  cdp.close();
} catch (e) {
  console.error("E2E failed:", e?.message ?? e);
  if (e?.stack) console.error(e.stack.split("\n").slice(0, 4).join("\n"));
} finally {
  edge.kill();
  if (vite) vite.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
