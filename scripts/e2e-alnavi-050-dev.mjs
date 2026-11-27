// Dev E2E for alnavi-050: copying/moving onto an existing name froze the
// app — the backend emits op:conflict from its transfer thread before the
// copy_paths/move_paths invoke resolves, so the store still held the -1
// placeholder id and dropped the dialog request (the Rust side then waited
// for an answer forever). The mock below reproduces that exact ordering —
// the conflict event is delivered while the invoke promise is still pending:
//   - F5 copy onto an existing name: the conflict dialog OPENS (pre-fix it
//     never did), the -1 placeholder adopts the real op id from the event
//   - Enter on the autofocused primary button answers resolve_conflict with
//     the REAL id and action "overwrite"; the op then finishes cleanly
//   - Esc answers "skip" (dialog.close routes a conflict to skip)
//   - F6 move gets the same treatment: dialog opens mid-race, Esc -> skip
// Usage: node scripts/e2e-alnavi-050-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9275;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-050-"));
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
async function key(cdp, name, vk) {
  const base = { key: name, code: name, windowsVirtualKeyCode: vk, location: 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}
async function type(cdp, text) {
  await cdp.send("Input.insertText", { text });
}
async function clickAt(cdp, x, y) {
  const base = { x, y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  await sleep(300);
}
// NB: a CDP-synthesized Enter does not run the browser's default button
// activation (the e2e-smoke lesson) — click dialog buttons with a real mouse
async function clickEl(cdp, expr) {
  const r = await evalIn(cdp, `(() => { const el = ${expr}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
  if (!r) return false;
  await clickAt(cdp, r.x, r.y);
  return true;
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
        mk("twice.txt", false, 300, 1000),
      ];
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      window.__cbs = {};
      window.__listeners = {};
      window.__e2e = { copies: [], moves: [], resolves: [], opSeq: 0, saved: [] };
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
          case "save_json":
            window.__e2e.saved.push(JSON.stringify(args.value));
            return Promise.resolve(null);
          case "path_exists": return Promise.resolve(true);
          case "free_space": return Promise.resolve([0, 0]);
          case "resolve_conflict":
            window.__e2e.resolves.push({ id: args.id, action: args.action });
            return Promise.resolve(null);
          case "op_control": return Promise.resolve(null);
          case "copy_paths":
          case "move_paths": {
            const rec = { paths: args.paths, dest: args.dest };
            if (cmd === "copy_paths") window.__e2e.copies.push(rec); else window.__e2e.moves.push(rec);
            // alnavi-050 race: the real backend emits op:conflict from its
            // transfer thread before the invoke that returns the op id
            // resolves — deliver the event NOW, keep the invoke pending
            const id = ++window.__e2e.opSeq;
            window.__emitConflict(id, args.paths[0], args.dest);
            return new Promise((res) => { window.__e2e.releaseTransfer = () => res(id); });
          }
          default: return Promise.resolve(null);
        }
      };
      // deliver a backend op:conflict through the real listen callback,
      // recording the store's op id before/after the event (the race proof)
      window.__emitConflict = (id, src, dst) => {
        const lid = window.__listeners["op:conflict"];
        if (!lid || !window.__cbs[lid]) throw new Error("no op:conflict listener registered");
        window.__e2e.idAtEvent = window.__e2e.ops?.op?.id ?? null;
        window.__cbs[lid]({ event: "op:conflict", id: lid, payload: { id, src, dst, isDir: false } });
        window.__e2e.idAfterEvent = window.__e2e.ops?.op?.id ?? null;
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
      window.__e2e.ops = ops;
      await panels.init();
      // the passive panel must be another directory: a target that resolves
      // back to the source is a self-copy no-op in the app logic
      window.__e2e.p.right.tab.path = "D:\\\\e2e2";
      // the app's own onMount init chain dies on the missing invoke before
      // the mock is in place — the op listener must be re-armed here
      await ops.init();
      return { view: panels.left.view.length };
    })()
  `);
  await waitFor(() => evalIn(cdp, `window.__e2e?.p?.left?.view?.length === 4 ? true : null`).catch(() => null), 15000, "left panel loaded");
  await sleep(400);
}

const waitForExpr = (cdp, expr, ms, label) => waitFor(() => evalIn(cdp, expr).catch(() => null), ms, label);
const cursorTo = (cdp, name) => evalIn(cdp, `(() => { const p = window.__e2e.p.left; p.cursor = p.view.findIndex((e) => e.name === ${JSON.stringify(name)}); return p.current?.name; })()`);
// the F5/F6 input dialog: a chord opens it focused with the single-file
// prefill (destBase + name) preselected; pressing Enter unchanged keeps the
// "to the other panel" target — exactly the user scenario of copying onto
// an existing name. The conflict event fires while the invoke is pending.
async function transferViaDialog(cdp, keys, label) {
  await key(cdp, keys.name, keys.vk);
  await waitForExpr(cdp, `document.activeElement === document.querySelector(".dlg input") ? true : null`, 5000, "input dialog");
  const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, location: 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...enter, type: "keyDown", text: "\r" });
  await cdp.send("Input.dispatchKeyEvent", { ...enter, type: "keyUp" });
  // the conflict dialog must open even though the invoke is still pending
  const opened = await waitForExpr(cdp, `document.querySelector(".dlg-title.warn") ? true : null`, 5000, "conflict dialog");
  check(`${label}: conflict dialog opens mid-race`, !!opened, "");
  return opened;
}
async function finishOp(cdp, id) {
  await evalIn(cdp, `window.__e2e.releaseTransfer()`);
  await evalIn(cdp, `window.__emitOp(${id})`);
  await waitForExpr(cdp, `!document.querySelector(".dlg")`, 5000, "progress dialog closed");
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

  step("F5 copy onto an existing name: dialog opens while the invoke is pending");
  await cursorTo(cdp, "file.txt");
  await transferViaDialog(cdp, { name: "F5", vk: 116 }, "F5 copy");
  const race1 = await evalIn(cdp, `JSON.stringify({ at: window.__e2e.idAtEvent, after: window.__e2e.idAfterEvent, conflict: window.__e2e.ops.conflict })`);
  const r1 = JSON.parse(race1);
  check("the event arrived while the store still held the -1 placeholder", r1.at === -1, `idAtEvent=${r1.at}`);
  check("the placeholder adopted the real op id from the event", r1.after === 1, `idAfterEvent=${r1.after}`);
  check("the dialog shows the conflicting pair", r1.conflict?.src?.endsWith("file.txt") && r1.conflict?.dst?.endsWith("file.txt"), r1.conflict ? `${r1.conflict.src} -> ${r1.conflict.dst}` : "no conflict");

  step("click on the autofocused primary button answers overwrite with the real id");
  const clicked = await clickEl(cdp, `document.querySelector(".overlay .dlg .btn.primary")`);
  const answer1 = await waitForExpr(cdp, `window.__e2e.resolves.length ? JSON.stringify(window.__e2e.resolves[0]) : null`, 5000, "resolve_conflict");
  check("resolve_conflict carries the real id + overwrite", clicked && answer1 === JSON.stringify({ id: 1, action: "overwrite" }), answer1);
  await finishOp(cdp, 1);
  check("the op finished and the progress dialog closed", true, "");

  step("F5 copy again: Esc answers skip");
  await cursorTo(cdp, "file.txt");
  await transferViaDialog(cdp, { name: "F5", vk: 116 }, "F5 copy #2");
  await key(cdp, "Escape", 27);
  const answer2 = await waitForExpr(cdp, `window.__e2e.resolves.length > 1 ? JSON.stringify(window.__e2e.resolves[1]) : null`, 5000, "resolve_conflict #2");
  check("Esc resolves the conflict as skip", answer2 === JSON.stringify({ id: 2, action: "skip" }), answer2);
  await finishOp(cdp, 2);

  step("F6 move onto an existing name: same race, Esc answers skip");
  await cursorTo(cdp, "twice.txt");
  await transferViaDialog(cdp, { name: "F6", vk: 117 }, "F6 move");
  const race3 = await evalIn(cdp, `JSON.stringify({ at: window.__e2e.idAtEvent, after: window.__e2e.idAfterEvent })`);
  const r3 = JSON.parse(race3);
  check("move: the event still beat the invoke (-1 placeholder)", r3.at === -1, `idAtEvent=${r3.at}`);
  check("move: the real id was adopted", r3.after === 3, `idAfterEvent=${r3.after}`);
  await key(cdp, "Escape", 27);
  const answer3 = await waitForExpr(cdp, `window.__e2e.resolves.length > 2 ? JSON.stringify(window.__e2e.resolves[2]) : null`, 5000, "resolve_conflict #3");
  check("move Esc resolves as skip with the real id", answer3 === JSON.stringify({ id: 3, action: "skip" }), answer3);
  await finishOp(cdp, 3);

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
