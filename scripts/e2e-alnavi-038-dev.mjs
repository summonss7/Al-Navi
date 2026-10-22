// Dev E2E for alnavi-038: the FAR "cut all → switch encoding → paste → save"
// workflow works directly — after picking a concrete encoding in the editor
// (F8 or the status-bar select) a second dialog step offers:
//   «Перекодировать» (default): the text stays as-is, the document is marked
//     dirty and F2 writes the file in the new encoding — no re-read, no
//     mojibake (the bug being fixed: F8 used to reload the bytes from disk
//     and turn a readable file into кракозябры)
//   «Перечитать с диска»: the old 037 reload behavior, one arrow down
// "auto" and the viewer (Shift+F8) still reload straight away. Esc at the
// action step walks back to the encoding list. Verified against the vite dev
// build with a mocked Tauri backend, driving REAL keys through CDP.
// Usage: node scripts/e2e-alnavi-038-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9275;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-038-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AUTO_TEXT = "Текст в windows-1251\nвторая строка";
const KOI8_TEXT = "Привет из KOI8-R\nвторой пункт";
const CP866_TEXT = "Текст в CP866\nстрока два";

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
      const rows = [mk("notes.txt", false, 100, 1000)];
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      window.__cbs = {};
      window.__listeners = {};
      window.__e2e = { readTextCalls: [], writeCalls: [] };
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
            if (enc === "cp866") return Promise.resolve({ text: ${JSON.stringify(CP866_TEXT)}, encoding: "cp866", bom: false, eol: "lf", size: 100, truncated: false });
            return Promise.resolve({ text: ${JSON.stringify(AUTO_TEXT)}, encoding: "windows-1251", bom: false, eol: "lf", size: 100, truncated: false });
          }
          case "write_text": {
            window.__e2e.writeCalls.push({ path: args.path, content: args.content, encoding: args.encoding, eol: args.eol });
            return Promise.resolve();
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
  await waitFor(() => evalIn(cdp, `window.__e2e?.p?.left?.view?.length === 2 ? true : null`).catch(() => null), 15000, "left panel loaded");
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
const toastText = (cdp) => evalIn(cdp, `document.querySelector(".toast")?.textContent ?? null`);
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

  step("F4 opens notes.txt (auto -> windows-1251, readable)");
  await evalIn(cdp, `(() => { const p = window.__e2e.p.left; p.cursor = p.view.findIndex((e) => e.name === "notes.txt"); return p.current?.name; })()`);
  await key(cdp, "F4", 115);
  await waitFor(() => docFacts(cdp).then((f) => (f && f.mode === "editor" ? f : null)), 10000, "editor mode");
  let f = await docFacts(cdp);
  check("editor opened readable in windows-1251", f.encoding === "windows-1251" && f.text === AUTO_TEXT, JSON.stringify(f));

  step("F8 -> KOI8-R -> Enter opens the ACTION step, cursor on «Перекодировать»");
  await key(cdp, "F8", 119);
  await sleep(200);
  let rows = await dialogRows(cdp);
  check("encoding list shown first (8 rows)", rows !== null && rows.length === 8, rows ? rows.length + " rows" : "no dialog");
  await key(cdp, "ArrowDown", 40); // windows-1251 -> koi8-r
  await sleep(120);
  await key(cdp, "Enter", 13);
  await sleep(250);
  rows = await dialogRows(cdp);
  check("action step: 2 rows (convert/reload)", rows !== null && rows.length === 2, rows ? rows.map((r) => r.label).join(" | ") : "no dialog");
  check("cursor defaults to the convert row", rows?.[0]?.kbd === true && rows?.[1]?.kbd !== true, rows?.find((r) => r.kbd)?.label ?? "none");
  check("action row names the target encoding", /KOI8-R/.test(rows?.[0]?.label ?? ""), rows?.[0]?.label);

  step("Esc steps back to the encoding list, cursor on the picked row");
  await key(cdp, "Escape", 27);
  await sleep(200);
  rows = await dialogRows(cdp);
  check("back at the encoding list", rows !== null && rows.length === 8, rows ? rows.length + " rows" : "closed");
  check("cursor returned to KOI8-R row", rows?.[5]?.kbd === true && /KOI8-R/.test(rows[5].label), rows?.find((r) => r.kbd)?.label ?? "none");
  await key(cdp, "Escape", 27);
  await sleep(150);
  check("second Esc closes the dialog", await evalIn(cdp, `window.__e2e.ui.dialog`) === null);

  step("convert: F8 -> KOI8-R -> Enter -> Enter keeps the text, marks dirty");
  const readsBefore = await evalIn(cdp, `window.__e2e.readTextCalls.length`);
  await key(cdp, "F8", 119);
  await sleep(150);
  await key(cdp, "ArrowDown", 40); // -> koi8-r
  await sleep(120);
  await key(cdp, "Enter", 13);
  await sleep(200);
  await key(cdp, "Enter", 13); // default action = convert
  await sleep(250);
  f = await docFacts(cdp);
  check("text unchanged (no mojibake, no reload)", f.text === AUTO_TEXT && f.dirty === true, JSON.stringify({ text: f.text, dirty: f.dirty }));
  check("encoding switched to koi8-r", f.encoding === "koi8-r", f.encoding);
  check("no read_text during convert", await evalIn(cdp, `window.__e2e.readTextCalls.length`) === readsBefore);
  const toast = await toastText(cdp);
  check("toast prompts F2 save", /KOI8-R/.test(toast ?? "") && /F2/.test(toast ?? ""), toast);
  check("CodeMirror still shows the readable text", (await cmText(cdp))?.includes(AUTO_TEXT.split("\n")[0]) === true);
  check("status select follows the new encoding", await evalIn(cdp, `document.querySelectorAll(".ed-status select")[1]?.value`) === "koi8-r");

  step("F2 saves: write_text called with encoding=koi8-r and the full text");
  await key(cdp, "F2", 113);
  await waitFor(() => evalIn(cdp, `window.__e2e.writeCalls.length ? true : null`), 5000, "write_text call");
  const w = await evalIn(cdp, `window.__e2e.writeCalls.at(-1)`);
  check("write_text got the new encoding and the kept text", w?.encoding === "koi8-r" && w?.content === AUTO_TEXT, JSON.stringify(w));
  f = await docFacts(cdp);
  check("dirty cleared after the save", f.dirty === false);

  step("status select -> cp866: opens the action step directly");
  await evalIn(cdp, `(() => {
    const sel = document.querySelectorAll(".ed-status select")[1];
    sel.value = "cp866";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await sleep(250);
  rows = await dialogRows(cdp);
  check("select change opened the action step", rows !== null && rows.length === 2 && /CP866/.test(rows[0].label), rows ? rows.map((r) => r.label).join(" | ") : "no dialog");
  check("select reverted its label until the action lands", await evalIn(cdp, `document.querySelectorAll(".ed-status select")[1]?.value`) === "koi8-r");

  step("Esc cancels: encoding stays koi8-r, select keeps showing it");
  await key(cdp, "Escape", 27); // back to the list (came from the select too)
  await sleep(150);
  await key(cdp, "Escape", 27); // close
  await sleep(150);
  f = await docFacts(cdp);
  check("cancel kept everything as it was", f.encoding === "koi8-r" && f.text === AUTO_TEXT, JSON.stringify({ enc: f.encoding }));

  step("reload path still there: F8 -> cp866 -> Enter -> Down -> Enter re-reads");
  await key(cdp, "F8", 119);
  await sleep(150);
  // cursor starts on koi8-r (idx 5) -> cp866 is idx 6: one Down
  await key(cdp, "ArrowDown", 40);
  await sleep(120);
  await key(cdp, "Enter", 13);
  await sleep(200);
  await key(cdp, "ArrowDown", 40); // action step: convert -> reload
  await sleep(120);
  await key(cdp, "Enter", 13);
  await waitFor(() => docFacts(cdp).then((x) => (x && x.encoding === "cp866" ? x : null)), 10000, "cp866 reload");
  f = await docFacts(cdp);
  check("re-read in cp866 swapped the text (reload row works)", f.text === CP866_TEXT && f.dirty === false, JSON.stringify(f.text));
  check("read_text was called for the reload", await evalIn(cdp, `window.__e2e.readTextCalls.at(-1)?.encoding`) === "cp866");

  step("«Авто-определение» still reloads straight away (no action step)");
  await key(cdp, "F8", 119);
  await sleep(150);
  await key(cdp, "Home", 36); // cursor to the top = auto
  await sleep(120);
  await key(cdp, "Enter", 13);
  await waitFor(() => docFacts(cdp).then((x) => (x && x.encoding === "windows-1251" ? x : null)), 10000, "auto re-detect");
  f = await docFacts(cdp);
  check("auto re-detect reloaded without the action step", f.text === AUTO_TEXT && f.encoding === "windows-1251");

  step("Esc closes the editor doc");
  await key(cdp, "Escape", 27);
  await waitFor(() => evalIn(cdp, `window.__e2e.ui.mode === "panels" ? true : null`), 5000, "back to panels");

  step("viewer: Shift+F8 still re-reads straight away (no action step)");
  await key(cdp, "F3", 114);
  await waitFor(() => viewFacts(cdp).then((v) => (v && v.uiMode === "viewer" ? v : null)), 10000, "viewer mode");
  await key(cdp, "F8", 119, SHIFT);
  await sleep(200);
  rows = await dialogRows(cdp);
  check("viewer picker shows the plain 8-row list", rows !== null && rows.length === 8, rows ? rows.length + " rows" : "no dialog");
  await key(cdp, "ArrowDown", 40); // windows-1251 -> koi8-r
  await sleep(120);
  await key(cdp, "Enter", 13);
  await waitFor(() => viewFacts(cdp).then((x) => (x && x.encoding === "koi8-r" ? x : null)), 10000, "viewer koi8-r reload");
  const v = await viewFacts(cdp);
  check("viewer re-read as KOI8-R (no action dialog in between)", v.text === KOI8_TEXT, JSON.stringify(v.text));

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
