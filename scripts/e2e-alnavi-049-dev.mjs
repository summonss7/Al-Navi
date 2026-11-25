// Dev E2E for alnavi-049: FAR rename templates — "*" and "?" in a typed
// target name borrow characters from the current file name. Verified
// against the vite dev build with a mocked Tauri backend, driving REAL
// keys through CDP (the mock records the resolved targets and the panel
// refreshes through the real op-done flow):
//   - Shift+F6 on file.txt, typed "new.*" -> rename_path(old=...\file.txt,
//     new=...\new.txt): the extension is taken from the old name, and the
//     panel lists the new row
//   - Shift+F6 on report.pdf, typed "*.docx" -> rename keeps the stem
//   - Shift+F6 typed "w?x.*" -> "?" copies one old-name character
//   - Shift+F6 typed "plain.dat" (no wildcards) -> passes through as-is
//   - F6 on one file, typed "*.bak" or a full path "D:\e2e\*.bak" ->
//     move_paths resolves the mask in the target name
//   - F5 copy with "*.bak" -> copy_paths resolves the mask too
//   - a wildcard target never lands in the saved transfer history
// Usage: node scripts/e2e-alnavi-049-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9274;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-049-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const base = { key: name, code: name, windowsVirtualKeyCode: vk, location: 0 };
  if (mods & SHIFT) {
    // Shift+key needs the modifier's own down/up around the key (like Alt)
    await cdp.send("Input.dispatchKeyEvent", { ...base, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: SHIFT, type: "keyDown" });
  }
  await cdp.send("Input.dispatchKeyEvent", { ...base, modifiers: mods, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, modifiers: mods, type: "keyUp" });
  if (mods & SHIFT) {
    await cdp.send("Input.dispatchKeyEvent", { ...base, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0, type: "keyUp" });
  }
}
const SHIFT = 8;
async function type(cdp, text) {
  await cdp.send("Input.insertText", { text });
}

async function bootstrap(cdp) {
  await cdp.send("Page.navigate", { url: `${ORIGIN}/?r=${Math.random().toFixed(8)}` });
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell") && !!document.querySelector(".cmdline input")`).catch(() => null), 30000, "app UI");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await evalIn(cdp, `
    (async () => {
      const mk = (name, isDir, size, mtime) => ({ name, isDir, size, mtime, attrs: "", isSymlink: false, isHidden: false });
      const rows = [
        mk("alpha", true, 0, 1000),
        mk("file.txt", false, 900, 1000),
        mk("report.pdf", false, 800, 1000),
        mk("Makefile", false, 100, 1000),
      ];
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      window.__cbs = {};
      window.__listeners = {};
      window.__e2e = { renames: [], moves: [], copies: [], saved: [] };
      window.__rows = rows;
      window.__TAURI_INTERNALS__.transformCallback = (cb) => {
        const id = ++window.__e2eCbSeq;
        window.__cbs[id] = cb;
        return id;
      };
      const renameInRows = (oldPath, newPath) => {
        const oldName = oldPath.split(/[\\\\\\\\/]/).pop();
        const newName = newPath.split(/[\\\\\\\\/]/).pop();
        const r = rows.find((x) => x.name === oldName);
        if (r) r.name = newName;
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
          case "save_json":
            window.__e2e.saved.push(JSON.stringify(args.value));
            return Promise.resolve(null);
          case "path_exists": return Promise.resolve(true);
          case "free_space": return Promise.resolve([0, 0]);
          case "rename_path":
            window.__e2e.renames.push({ old: args.old, new: args.new });
            renameInRows(args.old, args.new);
            return Promise.resolve(null);
          case "move_paths":
            window.__e2e.moves.push({ paths: args.paths, dest: args.dest });
            renameInRows(args.paths[0], args.dest);
            return Promise.resolve(7);
          case "copy_paths":
            window.__e2e.copies.push({ paths: args.paths, dest: args.dest });
            renameInRows(args.paths[0], args.dest);
            return Promise.resolve(8);
          case "op_control": return Promise.resolve(null);
          default: return Promise.resolve(null);
        }
      };
      // deliver a backend op:progress event through the real listen callback
      window.__emitOp = (id) => {
        const lid = window.__listeners["op:progress"];
        if (!lid || !window.__cbs[lid]) throw new Error("no op:progress listener registered");
        window.__cbs[lid]({ event: "op:progress", id: lid, payload: {
          id, phase: "done", bytesDone: 1, bytesTotal: 1, filesDone: 1, filesTotal: 1,
          current: "", speed: 0, cancelled: false, errors: [],
        } });
      };
      const imp = new Function("u", "return import(u)");
      const { panels } = await imp("${ORIGIN}/src/lib/stores/panels.svelte.ts");
      const { ops } = await imp("${ORIGIN}/src/lib/stores/ops.svelte.ts");
      window.__e2e.p = panels;
      await panels.init();
      // the app's own onMount init chain dies on the missing invoke before
      // the mock is in place — the op:progress listener must be re-armed
      // here, or move/copy dialogs would never hear their done event
      await ops.init();
      return { view: panels.left.view.length };
    })()
  `);
  await waitFor(() => evalIn(cdp, `window.__e2e?.p?.left?.view?.length === 5 ? true : null`).catch(() => null), 15000, "left panel loaded");
  await sleep(400);
}

const rowNames = (cdp) => evalIn(cdp, `(() => {
  const panel = document.querySelectorAll(".panel")[0];
  return [...panel.querySelectorAll(".vlist .row .name")].map((n) => n.textContent);
})()`);
const cursorTo = (cdp, name) => evalIn(cdp, `(() => { const p = window.__e2e.p.left; p.cursor = p.view.findIndex((e) => e.name === ${JSON.stringify(name)}); return p.current?.name; })()`);
const waitForExpr = (cdp, expr, ms, label) => waitFor(() => evalIn(cdp, expr).catch(() => null), ms, label);
// the input dialog: a chord opens it focused with the old name preselected;
// typing replaces it. Wait for the DIALOG input to BE the active element —
// the always-focused cmdline input is an INPUT too and would race the
// check; do not refocus it (a manual .focus() collapses the preselection).
// Enter carries text:"\r" for the implicit form submit (like 048-exe does)
async function inDialog(cdp, keys, text, list, expected, label) {
  await key(cdp, keys.name, keys.vk, keys.mods);
  await waitForExpr(cdp, `document.activeElement === document.querySelector(".dlg input") ? true : null`, 5000, "input dialog");
  await type(cdp, text);
  const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, location: 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...enter, type: "keyDown", text: "\r" });
  await cdp.send("Input.dispatchKeyEvent", { ...enter, type: "keyUp" });
  const got = await waitForExpr(cdp, `window.__e2e.${list}.length ? JSON.stringify(window.__e2e.${list}.at(-1)) : null`, 5000, list);
  check(label, got === JSON.stringify(expected), got);
  await sleep(300);
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

  step("bootstrapping stores + backend mock");
  await bootstrap(cdp);

  step("Shift+F6 + \"new.*\": the extension comes from the old name");
  await cursorTo(cdp, "file.txt");
  await inDialog(cdp, { name: "F6", vk: 117, mods: SHIFT }, "new.*", "renames",
    { old: "D:\\e2e\\file.txt", new: "D:\\e2e\\new.txt" }, "rename_path old->...\\new.txt");
  let names = await rowNames(cdp);
  check("panel shows new.txt", names.includes("new.txt"), JSON.stringify(names));

  step("Shift+F6 + \"*.docx\": the stem comes from the old name");
  await cursorTo(cdp, "report.pdf");
  await inDialog(cdp, { name: "F6", vk: 117, mods: SHIFT }, "*.docx", "renames",
    { old: "D:\\e2e\\report.pdf", new: "D:\\e2e\\report.docx" }, "rename_path old->...\\report.docx");

  step("Shift+F6 + \"w?x.*\": ? copies one character");
  await cursorTo(cdp, "report.docx");
  await inDialog(cdp, { name: "F6", vk: 117, mods: SHIFT }, "w?x.*", "renames",
    { old: "D:\\e2e\\report.docx", new: "D:\\e2e\\wex.docx" }, "rename_path old->...\\wex.docx");

  step("Shift+F6 without wildcards: the name passes through unchanged");
  await cursorTo(cdp, "wex.docx");
  await inDialog(cdp, { name: "F6", vk: 117, mods: SHIFT }, "plain.dat", "renames",
    { old: "D:\\e2e\\wex.docx", new: "D:\\e2e\\plain.dat" }, "rename_path old->...\\plain.dat");

  step("F6 + \"*.bak\" on one file: the move target resolves the mask");
  await cursorTo(cdp, "new.txt");
  await inDialog(cdp, { name: "F6", vk: 117 }, "*.bak", "moves",
    { paths: ["D:\\e2e\\new.txt"], dest: "D:\\e2e\\new.bak" }, "move_paths dest=...\\new.bak");
  await evalIn(cdp, `window.__emitOp(7)`);
  await waitForExpr(cdp, `!document.querySelector(".dlg")`, 5000, "progress dialog closed");

  step("F6 + full typed path with a mask");
  await cursorTo(cdp, "plain.dat");
  await inDialog(cdp, { name: "F6", vk: 117 }, "D:\\e2e\\*.bak", "moves",
    { paths: ["D:\\e2e\\plain.dat"], dest: "D:\\e2e\\plain.bak" }, "move_paths dest=...\\plain.bak");
  await evalIn(cdp, `window.__emitOp(7)`);
  await waitForExpr(cdp, `!document.querySelector(".dlg")`, 5000, "progress dialog closed");

  step("F5 copy + \"*.bak\": copy-with-rename resolves the mask too");
  await cursorTo(cdp, "Makefile");
  await inDialog(cdp, { name: "F5", vk: 116 }, "*.bak", "copies",
    { paths: ["D:\\e2e\\Makefile"], dest: "D:\\e2e\\Makefile.bak" }, "copy_paths dest=...\\Makefile.bak");
  await evalIn(cdp, `window.__emitOp(8)`);
  await waitForExpr(cdp, `!document.querySelector(".dlg")`, 5000, "progress dialog closed");

  step("a wildcard target never lands in the transfer history");
  const saved = await evalIn(cdp, `JSON.stringify(window.__e2e.saved)`);
  check("no saved target carries * or ?", !/[*?]/.test(saved ?? ""), (saved ?? "").slice(0, 120));

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

  cdp.close();
} catch (e) {
  console.error("SUITE ERROR:", e.stack ?? e.message);
} finally {
  edge.kill();
  if (vite) vite.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
