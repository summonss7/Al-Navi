// Dev E2E for alnavi-033: the Alt+F7 search dialog must prefill the folder
// from the CURRENT panel, not from the last executed search. The bug: root
// came from search-history.json first (`lp?.root || defaultSearchRoot()`),
// so a stale root like C:\Windows kept overriding whatever panel the user
// was looking at. Now root follows the panel (FAR behavior); the persisted
// root survives only as the last-resort fallback when NO panel has a local
// path (both FTP/search results). Mask/text/flags/dates/sizes still restore
// from the last search. This script drives the vite dev build with a mocked
// Tauri backend and REAL key events (Alt+F7 opens, Tab switches panels,
// Esc closes):
//   - seeded search-history.json (root C:\Windows) + session.json with two
//     distinct panel paths
//   - Alt+F7: root = the ACTIVE panel's folder, NOT C:\Windows; the other
//     last-search params (mask/text/regex/case/dirs/size/date) still applied
//   - Tab to the other panel, reopen: root = that panel's folder
//   - submit as-is: the search starts from the prefilled root and the
//     active panel becomes search://
//   - reopen on the search panel: root falls back to the INACTIVE panel
//   - both panels search://: root = the search origin
//   - origin nulled + both search://: root = the persisted last-search root
//     (the deliberate last resort)
// Usage: node scripts/e2e-alnavi-033-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9261;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-033-"));
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

// Alt+F7 / Tab / Esc as real key events. Alt is a separate keyDown/keyUp
// held around the key (032-style chord): a bare modifiers bit on the F7
// event alone does not reach the app as altKey in this harness
const VK = { F7: 118, Tab: 9, Escape: 27, Alt: 18 };
async function key(cdp, k, { alt = false } = {}) {
  if (alt) {
    await cdp.send("Input.dispatchKeyEvent", { key: "Alt", code: "Alt", windowsVirtualKeyCode: VK.Alt, location: 1, modifiers: 0, type: "keyDown" });
    await sleep(80);
  }
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k], modifiers: alt ? 1 : 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(120);
  if (alt) {
    await cdp.send("Input.dispatchKeyEvent", { key: "Alt", code: "Alt", windowsVirtualKeyCode: VK.Alt, location: 1, modifiers: 0, type: "keyUp" });
    await sleep(80);
  }
  await sleep(150);
}
const searchDialog = `(() => ({
  open: !!document.getElementById("search-form"),
  root: document.getElementById("sr-f-root")?.value ?? null,
}))()`;

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
      // the stale last search the bug reproduced on: root C:\\Windows
      window.__e2eLastSearch = {
        root: "C:\\\\Windows", mask: "*mts*", text: "Al-Navi",
        useRegex: true, textCaseSensitive: true,
        dateFrom: ${Date.UTC(2025, 0, 31)}, dateTo: null,
        sizeFrom: 2048, sizeTo: null, findDirs: false,
      };
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      window.__TAURI_INTERNALS__.transformCallback = () => ++window.__e2eCbSeq;
      window.__e2eSearch = null;
      window.__e2eSaved = [];
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen": return Promise.resolve(++window.__e2eCbSeq);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": return Promise.resolve({ path: args.path, entries: rows, freeBytes: 0, totalBytes: 0 });
          case "home_path": return Promise.resolve("D:\\\\e2e");
          case "drives_list": return Promise.resolve([
            { name: "Local (C:)", mountPoint: "C:\\\\", kind: "fixed", totalBytes: 500000000000, freeBytes: 100000000000 },
          ]);
          case "load_json":
            if (args.name === "search-history.json") return Promise.resolve(window.__e2eLastSearch);
            if (args.name === "session.json") return Promise.resolve({ leftPath: "D:\\\\e2e-left", rightPath: "D:\\\\e2e-right" });
            return Promise.resolve(null);
          case "save_json":
            window.__e2eSaved.push({ name: args.name, data: args.data });
            return Promise.resolve(null);
          case "search_start":
            window.__e2eSearch = args.params;
            return Promise.resolve(7);
          case "free_space": return Promise.resolve([0, 0]);
          default: return Promise.resolve(null);
        }
      };
      const imp = new Function("u", "return import(u)");
      // full ".svelte.ts" URLs — a bare ".svelte" URL would create a SECOND
      // store instance and the assertions would read a disconnected copy
      const { panels } = await imp("${ORIGIN}/src/lib/stores/panels.svelte.ts");
      const { ui } = await imp("${ORIGIN}/src/lib/stores/ui.svelte.ts");
      const { searchStore } = await imp("${ORIGIN}/src/lib/stores/search.svelte.ts");
      window.__e2e = { panels, ui, searchStore };
      await panels.init();
      await searchStore.init();
      return window.__e2e.panels.left.view.length + "/" + window.__e2e.searchStore.lastParams?.root;
    })()
  `);

  step("Alt+F7 on the left panel: root must be the panel folder, not C:\\Windows");
  await key(cdp, "F7", { alt: true });
  await sleep(500);
  let dlg = await evalIn(cdp, searchDialog);
  check("dialog opened by the real Alt+F7", !!dlg?.open, JSON.stringify(dlg));
  check("root = the ACTIVE panel folder (D:\\e2e-left), not the stale C:\\Windows",
    dlg?.root === "D:\\e2e-left", `root=${dlg?.root}`);

  step("the other last-search params still restore");
  const pre = await evalIn(cdp, `(() => ({
    mask: document.getElementById("sr-f-mask")?.value ?? null,
    text: document.getElementById("sr-f-text")?.value ?? null,
    regex: document.querySelectorAll("#search-form input[type=checkbox]")[0]?.checked ?? null,
    case: document.querySelectorAll("#search-form input[type=checkbox]")[1]?.checked ?? null,
    dirs: document.querySelectorAll("#search-form input[type=checkbox]")[2]?.checked ?? null,
    sfrom: document.getElementById("sr-f-sfrom")?.value ?? null,
    dfrom: document.getElementById("sr-f-dfrom")?.value ?? null,
  }))()`);
  const wantDate = ((ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })(Date.UTC(2025, 0, 31));
  check("mask/text/regex/case/dirs/size/date restored from the last search",
    pre?.mask === "*mts*" && pre?.text === "Al-Navi" && pre?.regex === true && pre?.case === true
    && pre?.dirs === false && pre?.sfrom === "2048" && pre?.dfrom === wantDate,
    JSON.stringify(pre));

  step("Esc closes; Tab switches the panel; reopen: root = the other panel");
  await key(cdp, "Escape");
  await sleep(300);
  let closed = await evalIn(cdp, `!document.getElementById("search-form")`);
  check("Esc closed the dialog", !!closed);
  await key(cdp, "Tab");
  await sleep(300);
  await key(cdp, "F7", { alt: true });
  await sleep(500);
  dlg = await evalIn(cdp, searchDialog);
  check("root follows the now-active right panel (D:\\e2e-right)", dlg?.root === "D:\\e2e-right", `root=${dlg?.root}`);

  step("submit as-is: search starts from the prefilled root, panel -> search://");
  await evalIn(cdp, `document.getElementById("search-form").requestSubmit()`);
  await sleep(500);
  const started = await evalIn(cdp, `(() => ({
    dialogOpen: !!document.getElementById("search-form"),
    params: window.__e2eSearch,
    activePath: window.__e2e.panels.active.path,
    stored: window.__e2e.searchStore.params?.root ?? null,
    saved: window.__e2eSaved.filter((s) => s.name === "search-history.json").pop()?.data?.root ?? null,
  }))()`);
  check("search_start got the panel root (D:\\e2e-right)", started?.params?.root === "D:\\e2e-right", JSON.stringify(started?.params?.root));
  check("dialog closed, active panel shows search://", !started?.dialogOpen && started?.activePath === "search://", `active=${started?.activePath}`);
  check("store params + history save carry the same root",
    started?.stored === "D:\\e2e-right" && started?.saved === "D:\\e2e-right",
    `stored=${started?.stored} saved=${started?.saved}`);

  step("reopen while the search panel is active: root falls back to the inactive panel");
  await key(cdp, "F7", { alt: true });
  await sleep(500);
  dlg = await evalIn(cdp, searchDialog);
  check("root = the inactive left panel (D:\\e2e-left)", dlg?.root === "D:\\e2e-left", `root=${dlg?.root}`);
  await key(cdp, "Escape");
  await sleep(300);

  step("both panels on search://: root = the search origin");
  await evalIn(cdp, `window.__e2e.panels.left.load("search://"); true`);
  await sleep(300);
  await key(cdp, "F7", { alt: true });
  await sleep(500);
  dlg = await evalIn(cdp, searchDialog);
  check("root = the search origin (D:\\e2e-right)", dlg?.root === "D:\\e2e-right", `root=${dlg?.root}`);
  await key(cdp, "Escape");
  await sleep(300);

  step("origin unknown + both search://: the persisted root is the last resort");
  await evalIn(cdp, `window.__e2e.searchStore.lastParams = { root: "C:\\\\Windows", mask: "*", useRegex: false, text: null, textCaseSensitive: false, dateFrom: null, dateTo: null, sizeFrom: null, sizeTo: null, findDirs: true }; window.__e2e.searchStore.originPath = null; true`);
  await sleep(200);
  await key(cdp, "F7", { alt: true });
  await sleep(500);
  dlg = await evalIn(cdp, searchDialog);
  check("root = the persisted last-search root (last resort)", dlg?.root === "C:\\Windows", `root=${dlg?.root}`);
  await key(cdp, "Escape");
  await sleep(200);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error("FAILED:", failed.map((f) => f.name).join("; "));
    process.exitCode = 1;
  }
} finally {
  edge.kill();
  if (ours) ours.kill();
}
