// Dev E2E for alnavi-035: line numbers must not mix with the text when an
// in-editor search wraps around to the top of the file. The gutter is sticky
// and floats above the horizontally scrolled content (z-index 200); with a
// transparent background the beginnings of long lines slid under the numbers
// and both painted into the same pixels. Verified against the vite dev build
// with a mocked Tauri backend, driving REAL key events through CDP:
//   - F7 opens the search panel; typing the query commits it (keyup)
//   - Enter walks the matches: line 2 → 100 → 2950 → 2990, the 5th Enter
//     wraps around back to line 2 (cursor + scrollTop prove the wrap)
//   - the wrap keeps the horizontal scroll (scrollLeft > 0), so the first
//     lines' text geometry sits under the gutter — and the gutter must be
//     OPAQUE so the text is hidden behind the numbers, IDE-style, instead of
//     showing through them
//   - with no horizontal scroll the text still starts right of the gutter
// Usage: node scripts/e2e-alnavi-035-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9270;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-035-"));
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
    await sleep(100);
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
async function key(cdp, name, vk, mods = 0) {
  const base = { key: name, code: name, windowsVirtualKeyCode: vk, modifiers: mods, location: 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

async function bootstrap(cdp) {
  await cdp.send("Page.navigate", { url: `${ORIGIN}/?r=${Math.random().toFixed(8)}` });
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell") && !!document.querySelector(".cmdline input")`).catch(() => null), 30000, "app UI");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // the document: 3000 lines x ~900 chars, matches at lines 2, 100, 2950, 2990,
  // each at column ~860 — far right, so every match jump scrolls horizontally
  await evalIn(cdp, `
    (async () => {
      const lines = [];
      for (let i = 1; i <= 3000; i++) {
        const head = "line " + i + ": обычная строка файла с текстом и всяким разным содержимым";
        const tail = ".".repeat(900 - head.length - 20);
        if (i === 2 || i === 100 || i === 2950 || i === 2990) lines.push(head + tail + " искомыйтекст здесь");
        else lines.push(head + tail + " конец строки");
      }
      const DOC = lines.join("\\n");
      window.__DOC = DOC;
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      window.__TAURI_INTERNALS__.transformCallback = () => ++window.__e2eCbSeq;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen": return Promise.resolve(++window.__e2eCbSeq);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": return Promise.resolve({ path: args.path, entries: [], freeBytes: 0, totalBytes: 0 });
          case "home_path": return Promise.resolve("D:\\\\e2e");
          case "drives_list": return Promise.resolve([]);
          case "load_json": return Promise.resolve(null);
          case "save_json": return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          case "read_text":
            if (args.path !== "D:\\\\e2e\\\\long.txt") return Promise.reject(new Error("no such file"));
            return Promise.resolve({ text: DOC, encoding: "utf-8", bom: false, eol: "lf", size: DOC.length, truncated: false });
          default: return Promise.resolve(null);
        }
      };
      const imp = new Function("u", "return import(u)");
      const { editor } = await imp("${ORIGIN}/src/lib/stores/editor.svelte.ts");
      // import cm by the exact URL the component uses (vite ?t= URLs are a
      // DIFFERENT module instance with their own module-level view)
      const comp = await (await fetch("${ORIGIN}/src/components/EditorArea.svelte")).text();
      const cmUrl = comp.match(/from "([^"]*\\/lib\\/editor\\/cm\\.ts[^"]*)"/)[1];
      const { currentView } = await imp(new URL(cmUrl, "${ORIGIN}/").href);
      window.__e2e = { editor, currentView };
      await editor.init();
      return true;
    })()
  `);
  await evalIn(cdp, `window.__e2e.editor.open("D:\\\\e2e\\\\long.txt")`);
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".cm-editor") && document.activeElement?.classList?.contains("cm-content") ? true : null`).catch(() => null), 20000, "editor mounted + focused");
  await sleep(1200); // fonts + first measure settle
}

// live view facts: cursor line, scroll offsets, gutter geometry vs first text
const state = (cdp) => evalIn(cdp, `(() => {
  const v = window.__e2e.currentView();
  if (!v) return null;
  const gut = document.querySelector(".cm-gutters");
  const scroller = document.querySelector(".cm-scroller");
  const firstLine = document.querySelector(".cm-content .cm-line");
  const g = gut.getBoundingClientRect();
  const rng = document.createRange();
  rng.selectNodeContents(firstLine);
  const t = rng.getBoundingClientRect();
  return {
    cursorLine: v.state.doc.lineAt(v.state.selection.main.head).number,
    scrollLeft: Math.round(scroller.scrollLeft),
    scrollTop: Math.round(scroller.scrollTop),
    gutterBg: getComputedStyle(gut).backgroundColor,
    gutterRight: +g.right.toFixed(1),
    firstTextLeft: +t.left.toFixed(1),
  };
})()`);
const isOpaque = (bg) => typeof bg === "string" && !/rgba\([^)]*,\s*0\)$/.test(bg.replace(/\s/g, ""));

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

  step("scenario 1: open, search, walk the matches, wrap to the top");
  await bootstrap(cdp);
  let s = await state(cdp);
  check("opened at the top, no horizontal scroll", s.cursorLine === 1 && s.scrollLeft === 0, JSON.stringify(s));
  check("gutter is opaque at rest (nothing can ever show through)", isOpaque(s.gutterBg), s.gutterBg);

  await key(cdp, "F7", 118); // editor.search → the CM search panel
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".cm-panel input")`).catch(() => null), 10000, "search panel");
  check("F7 opened the search panel", true);
  // type the query with real key events: each keyUp commits the query
  for (const ch of "искомыйтекст") {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: 0 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: 0 });
  }
  await sleep(300);

  const walk = [];
  for (let i = 1; i <= 5; i++) {
    await key(cdp, "Enter", 13);
    await sleep(700);
    walk.push((await state(cdp)).cursorLine);
  }
  check("Enter walked the matches 2,100,2950,2990 then wrapped to 2", JSON.stringify(walk) === JSON.stringify([2, 100, 2950, 2990, 2]), JSON.stringify(walk));

  s = await state(cdp);
  check("wrap scrolled back to the very top of the file", s.cursorLine === 2 && s.scrollTop <= 100, JSON.stringify({ line: s.cursorLine, scrollTop: s.scrollTop }));
  check("wrap kept the horizontal scroll (matches sit far right)", s.scrollLeft > 0, `scrollLeft=${s.scrollLeft}`);
  check("line beginnings sit under the gutter zone", s.firstTextLeft < s.gutterRight, `text@${s.firstTextLeft} < gutter@${s.gutterRight}`);
  check("gutter is OPAQUE — the slid-under text hides behind the numbers", isOpaque(s.gutterBg), s.gutterBg);

  step("scenario 2: no horizontal scroll — text starts right of the gutter");
  // the opening check of scenario 1 already proves this state (text@60.4 >
  // gutter@54.4 at scrollLeft=0); re-assert from a fresh open for clarity
  await bootstrap(cdp);
  s = await state(cdp);
  check("a fresh open keeps the text clear of the numbers", s.scrollLeft === 0 && s.firstTextLeft >= s.gutterRight - 1, JSON.stringify(s));

  cdp.close();
} catch (e) {
  check("script crashed", false, String(e));
} finally {
  edge.kill();
  if (ours) ours.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
