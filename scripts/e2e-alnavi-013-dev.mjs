// Dev E2E for alnavi-013: lazy CodeMirror languages + lazy editor/viewer areas.
// Runs against the vite dev build with a mocked Tauri backend and verifies:
//   - the startup module graph carries no CodeMirror / EditorArea / ViewerArea
//     (panel boot stays lean — the cm core and grammars are on-demand chunks)
//   - editor.open() of a .rs file pulls the rust grammar on demand: the text
//     is in the DOM right away (no blank flash), syntax marks appear within a
//     sane budget, and lang-rust is fetched only after the open
//   - a second .rs doc reuses the cached grammar (no second module fetch)
//   - a .py doc pulls lang-python; switching back to the .rs doc re-colorizes
//   - a plain .txt doc stays unhighlighted with no language module fetch
//   - editor.view() of a .json file drives the same lazy path in the viewer
//   - zero console errors / uncaught exceptions through all of the above
// Usage: node scripts/e2e-alnavi-013-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9263;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-013-"));
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
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    events.push(msg);
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

// samples per extension: enough keywords/strings for visible syntax marks
const FILES = {
  "main.rs": 'fn main() {\n    let answer = 42; // the answer\n    println!("hello {}", answer);\n}\n',
  "lib.rs": 'pub fn square(x: i64) -> i64 {\n    x * x // mutates nothing\n}\n',
  "app.py": 'def hello(name):\n    # classic\n    return f"hi {name}"\n',
  "notes.txt": "plain notes: nothing to highlight here 2026-10-06\n",
  "config.json": '{\n  "retries": 3,\n  "tags": ["a", "b"],\n  "verbose": true\n}\n',
};

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
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell") && !!document.querySelector(".cmdline input")`).catch(() => null), 30000, "app UI");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  step("collect console errors");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  const consoleErrors = () =>
    cdp.events.filter((e) =>
      (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") ||
      (e.method === "Runtime.exceptionThrown") ||
      (e.method === "Log.entryAdded" && e.params.entry.level === "error"),
    );

  step("bootstrapping stores + backend mock");
  await evalIn(cdp, `
    (async () => {
      const rows = [{ name: "..", isDir: true, size: 0, mtime: 0, attrs: "", isSymlink: false, isHidden: false }];
      for (const n of ${JSON.stringify(Object.keys(FILES))}) {
        rows.push({ name: n, isDir: false, size: FILES_SIZE, mtime: 0, attrs: "", isSymlink: false, isHidden: false });
      }
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      const TEXTS = ${JSON.stringify(FILES)};
      window.__TAURI_INTERNALS__.transformCallback = () => ++window.__e2eCbSeq;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen": return Promise.resolve(++window.__e2eCbSeq);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": return Promise.resolve({ path: args.path, entries: rows, freeBytes: 0, totalBytes: 0 });
          case "home_path": return Promise.resolve("D:\\\\e2e");
          case "load_json": return Promise.resolve(null);
          case "save_json": return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          case "read_text": {
            const name = args.path.split(/[\\\\/]/).pop();
            const text = TEXTS[name] ?? "missing";
            return Promise.resolve({ text, encoding: "utf-8", bom: false, eol: "lf", size: text.length, truncated: false });
          }
          default: return Promise.resolve(null);
        }
      };
      const imp = new Function("u", "return import(u)");
      const { panels } = await imp("${ORIGIN}/src/lib/stores/panels.svelte.ts");
      const { editor } = await imp("${ORIGIN}/src/lib/stores/editor.svelte.ts");
      window.__e2e = { panels, editor };
      await panels.init();
      return window.__e2e.panels.left.view.length;
    })()`.replace("FILES_SIZE", "100"));

  step("startup graph is lean");
  const bootRes = (needle) => evalIn(cdp, `performance.getEntriesByType("resource").filter((e) => e.name.includes(${JSON.stringify(needle)})).length`);
  check("no CodeMirror fetched at boot", (await bootRes("@codemirror")) === 0, `count=${await bootRes("@codemirror")}`);
  check("no lezer fetched at boot", (await bootRes("@lezer")) === 0, `count=${await bootRes("@lezer")}`);
  check("no EditorArea/ViewerArea fetched at boot", (await bootRes("EditorArea")) === 0 && (await bootRes("ViewerArea")) === 0, "");

  step("open .rs in the editor (first grammar load)");
  const t0 = await evalIn(cdp, `performance.now()`);
  await evalIn(cdp, `window.__e2e.editor.open("D:\\\\e2e\\\\main.rs")`);
  // the area chunk may need a moment; the text must be in the DOM as soon as
  // the editor renders at all — that is the "no blank flash" guarantee
  const textReady = await waitFor(() => evalIn(cdp, `(() => {
    const host = document.querySelector(".cm-content");
    return host && host.textContent.includes("the answer") ? performance.now() : null;
  })()`).catch(() => null), 20000, "editor text");
  check("editor text visible after open", true);
  const marked = async () => evalIn(cdp, `document.querySelectorAll('.cm-content span[class^="ͼ"]').length`);
  await waitFor(async () => (await marked()) > 0, 15000, "syntax marks");
  const t1 = await evalIn(cdp, `performance.now()`);
  check("rust syntax marks appear (lazy chunk applied)", (await marked()) > 0, `marks=${await marked()}, open→text=${Math.round(textReady - t0)}ms, open→color=${Math.round(t1 - t0)}ms`);
  const rustFetches = () => evalIn(cdp, `performance.getEntriesByType("resource").filter((e) => e.name.includes("lang-rust")).length`);
  check("lang-rust fetched exactly once on demand", (await rustFetches()) === 1, `fetches=${await rustFetches()}`);

  step("second .rs doc reuses the cached grammar");
  await evalIn(cdp, `window.__e2e.editor.open("D:\\\\e2e\\\\lib.rs")`);
  await waitFor(() => evalIn(cdp, `document.querySelector(".cm-content")?.textContent.includes("square") ? 1 : null`).catch(() => null), 10000, "second doc text");
  await waitFor(async () => (await marked()) > 0, 5000, "second doc marks");
  check("no extra lang-rust fetch for the cached grammar", (await rustFetches()) === 1, `fetches=${await rustFetches()}`);
  check("second .rs doc colorized", (await marked()) > 0, `marks=${await marked()}`);

  step("python doc + switching back to rust");
  await evalIn(cdp, `window.__e2e.editor.open("D:\\\\e2e\\\\app.py")`);
  await waitFor(() => evalIn(cdp, `document.querySelector(".cm-content")?.textContent.includes("classic") ? 1 : null`).catch(() => null), 10000, "py text");
  await waitFor(async () => (await marked()) > 0, 15000, "py marks");
  const pyFetches = () => evalIn(cdp, `performance.getEntriesByType("resource").filter((e) => e.name.includes("lang-python")).length`);
  check("lang-python fetched once", (await pyFetches()) === 1, `fetches=${await pyFetches()}`);
  check("python doc colorized", (await marked()) > 0, `marks=${await marked()}`);
  await evalIn(cdp, `(() => { const d = window.__e2e.editor.docs.find((x) => x.path.endsWith("main.rs")); window.__e2e.editor.activate(d.id); return true; })()`);
  await waitFor(() => evalIn(cdp, `document.querySelector(".cm-content")?.textContent.includes("the answer") ? 1 : null`).catch(() => null), 10000, "back to rust");
  check("rust doc re-colorized after switch (cache, no flicker wait)", (await marked()) > 0, `marks=${await marked()}`);

  step("plain .txt stays grammar-free");
  await evalIn(cdp, `window.__e2e.editor.open("D:\\\\e2e\\\\notes.txt")`);
  await waitFor(() => evalIn(cdp, `document.querySelector(".cm-content")?.textContent.includes("plain notes") ? 1 : null`).catch(() => null), 10000, "txt text");
  await sleep(600); // a stray fetch would have started; txt must not load any grammar
  const langFetches = await evalIn(cdp, `performance.getEntriesByType("resource").filter((e) => e.name.includes("lang-")).map((e) => e.name.split("/").slice(-3, -1).join("/")).join(",")`);
  check("no grammar module for .txt", !langFetches.includes("lang-"), `fetched=[${langFetches}]`);

  step("viewer with .json (same lazy path, read-only)");
  await evalIn(cdp, `window.__e2e.editor.view("D:\\\\e2e\\\\config.json")`);
  await waitFor(() => evalIn(cdp, `document.querySelector(".cm-content")?.textContent.includes("retries") ? 1 : null`).catch(() => null), 15000, "viewer text");
  await waitFor(async () => (await marked()) > 0, 15000, "viewer marks");
  const jsonFetches = await evalIn(cdp, `performance.getEntriesByType("resource").filter((e) => e.name.includes("lang-json")).length`);
  check("viewer colorized with lang-json on demand", (await marked()) > 0 && jsonFetches === 1, `marks=${await marked()}, fetches=${jsonFetches}`);

  step("console stayed clean");
  // favicon.ico 404 is a dev-server artifact, not an app error
  const errs = consoleErrors().filter((e) => !(e.method === "Log.entryAdded" && e.params.entry.url?.includes("favicon")));
  check("no console errors / uncaught exceptions", errs.length === 0, errs.map((e) => e.method === "Log.entryAdded" ? e.params.entry.text : JSON.stringify(e.params.args?.[0]?.value ?? e.params)).slice(0, 3).join(" | "));
} catch (e) {
  check("script completed without harness errors", false, String(e));
} finally {
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  edge.kill();
  if (ours) ours.kill();
  process.exit(fails ? 1 : 0);
}
