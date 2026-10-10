// Dev E2E for alnavi-034: column (rectangular) selection in the editor via
// Shift+Alt+arrows. Verified against the vite dev build with a mocked Tauri
// backend, driving REAL key events through CDP:
//   - Shift+Alt+Down/Up paint one selection range per line over the
//     rectangle (short lines contribute an empty range, as in FAR)
//   - Shift+Alt+Right/Left widen/narrow the block, including crossing over
//     the anchor column (cursors flip to the left edge)
//   - Shift+Alt+End/Home extend the width to the line end/start
//   - copy puts each row's fragment on its own line (FAR block copy)
//   - a plain move after the block restarts it from the caret
//   - Delete removes every row's fragment; typing into an empty column
//     (multi-cursor) inserts on every line
//   - Shift+Alt+PageDown grows the block by a page (clamped to the doc)
//   - Ctrl+Shift+Left/Right word selection is intact (the chords these
//     bindings replaced were Shift+Alt word-group select)
//   - holding Alt+Shift in the editor swaps the F-key bar to column chips
// Usage: node scripts/e2e-alnavi-034-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9258;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-034-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the document: fixed offsets, a short second line to exercise clamping
//   line1 "abcdefghij"  len 10, starts 0
//   line2 "kl"          len 2,  starts 11
//   line3 "mnopqrstuv"  len 10, starts 14
//   line4 "wxyz"        len 4,  starts 25
//   line5 "0123456789"  len 10, starts 30
const ROWS = ["abcdefghij", "kl", "mnopqrstuv", "wxyz", "0123456789"];
const TEXT = JSON.stringify(ROWS.join("\n"));

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

// CDP modifiers bitmask: Alt=1, Ctrl=2, Shift=8
const M = { alt: 1, ctrl: 2, shift: 8 };
async function key(cdp, name, vk, mods = 0) {
  const base = { key: name, code: name, windowsVirtualKeyCode: vk, modifiers: mods, location: 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}
const col = (cdp, name) => // Shift+Alt+<arrow>
  key(cdp, "Arrow" + name, { Left: 37, Up: 38, Right: 39, Down: 40 }[name], M.alt | M.shift);

// live selection: ranges as [from,to], main head, doc text
const selState = (cdp) => evalIn(cdp, `(() => {
  const v = window.__e2e?.currentView?.();
  if (!v) return null;
  return {
    ranges: v.state.selection.ranges.map((r) => [r.from, r.to]),
    mainHead: v.state.selection.main.head,
    doc: v.state.doc.toString(),
  };
})()`);
const setSel = (cdp, pos) => evalIn(cdp, `window.__e2e.currentView().dispatch({ selection: { anchor: ${pos} } })`);

async function bootstrap(cdp) {
  await cdp.send("Page.navigate", { url: `${ORIGIN}/?r=${Math.random().toFixed(8)}` });
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell") && !!document.querySelector(".cmdline input")`).catch(() => null), 30000, "app UI");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(cdp, `
    (async () => {
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      window.__TAURI_INTERNALS__.transformCallback = () => ++window.__e2eCbSeq;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen": return Promise.resolve(++window.__e2eCbSeq);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": return Promise.resolve({ path: args.path, entries: [], freeBytes: 0, totalBytes: 0 });
          case "home_path": return Promise.resolve("D:\\\\e2e");
          case "load_json": return Promise.resolve(null);
          case "save_json": return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          case "read_text":
            if (args.path !== "D:\\\\e2e\\\\block.txt") return Promise.reject(new Error("no such file"));
            return Promise.resolve({ text: ${TEXT}, encoding: "utf-8", bom: false, eol: "lf", size: 45, truncated: false });
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
  await evalIn(cdp, `window.__e2e.editor.open("D:\\\\e2e\\\\block.txt")`);
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".cm-editor") && document.activeElement?.classList?.contains("cm-content") ? true : null`).catch(() => null), 15000, "editor mounted + focused");
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

  step("scenario 1: walking the rectangle with the arrows");
  await bootstrap(cdp);
  await setSel(cdp, 3); // line1, col3
  await col(cdp, "Down"); await col(cdp, "Down");
  let s = await selState(cdp);
  check("2x Down: zero-width column, one range per line, short line empty", eq(s.ranges, [[3, 3], [13, 13], [17, 17]]), JSON.stringify(s.ranges));
  check("main cursor on the head line's right edge", s.mainHead === 17, `mainHead=${s.mainHead}`);
  await col(cdp, "Right"); await col(cdp, "Right");
  s = await selState(cdp);
  check("2x Right: block widened on every line", eq(s.ranges, [[3, 5], [13, 13], [17, 19]]), JSON.stringify(s.ranges));
  const copied = await evalIn(cdp, `(() => {
    const v = window.__e2e.currentView();
    const dt = new DataTransfer();
    v.contentDOM.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt }));
    return dt.getData("text/plain");
  })()`);
  check("copy joins the rows with newlines, empty row kept (FAR block copy)", copied === "de\n\npq", JSON.stringify(copied));
  await col(cdp, "Left"); await col(cdp, "Left");
  s = await selState(cdp);
  check("2x Left: narrowed back to the zero-width column", eq(s.ranges, [[3, 3], [13, 13], [17, 17]]), JSON.stringify(s.ranges));
  await col(cdp, "Left"); await col(cdp, "Left"); await col(cdp, "Left");
  s = await selState(cdp);
  check("crossover: head left of anchor flips to the LEFT edge", eq(s.ranges, [[0, 3], [11, 13], [14, 17]]) && s.mainHead === 14, `ranges=${JSON.stringify(s.ranges)} mainHead=${s.mainHead}`);
  await key(cdp, "End", 35, M.alt | M.shift);
  s = await selState(cdp);
  check("Shift+Alt+End: width to the line end", eq(s.ranges, [[3, 10], [13, 13], [17, 24]]), JSON.stringify(s.ranges));
  await key(cdp, "Home", 36, M.alt | M.shift);
  s = await selState(cdp);
  check("Shift+Alt+Home: width back over the anchor column", eq(s.ranges, [[0, 3], [11, 13], [14, 17]]), JSON.stringify(s.ranges));

  step("scenario 2: plain move collapses the block and restarts it from the caret");
  await key(cdp, "ArrowDown", 40); // collapses to the main caret, then moves
  s = await selState(cdp);
  check("plain Down collapsed the multi-selection", s.ranges.length === 1 && s.mainHead === 25, `ranges=${JSON.stringify(s.ranges)} mainHead=${s.mainHead}`);
  await col(cdp, "Up");
  s = await selState(cdp);
  check("fresh block: 2 empty ranges around the caret", eq(s.ranges, [[14, 14], [25, 25]]) && s.mainHead === 14, `ranges=${JSON.stringify(s.ranges)} mainHead=${s.mainHead}`);

  step("scenario 3: word selection without Alt is intact (replaced binding's sibling)");
  await setSel(cdp, 0);
  await key(cdp, "ArrowRight", 39, M.ctrl | M.shift);
  s = await selState(cdp);
  check("Ctrl+Shift+Right still selects the word", eq(s.ranges, [[0, 10]]), JSON.stringify(s.ranges));

  step("scenario 4: PageDown grows the block by a page, clamped to the doc");
  await setSel(cdp, 0);
  await key(cdp, "PageDown", 34, M.alt | M.shift);
  s = await selState(cdp);
  check("block spans every line of the small doc", s.ranges.length === 5 && eq(s.ranges[4], [30, 30]), `ranges=${JSON.stringify(s.ranges)}`);

  step("scenario 5: cut splices every row, empty row untouched");
  await bootstrap(cdp);
  await setSel(cdp, 3);
  await col(cdp, "Down"); await col(cdp, "Down"); await col(cdp, "Right");
  const cut = await evalIn(cdp, `(() => {
    const v = window.__e2e.currentView();
    const dt = new DataTransfer();
    v.contentDOM.dispatchEvent(new ClipboardEvent("cut", { clipboardData: dt }));
    return dt.getData("text/plain");
  })()`);
  s = await selState(cdp);
  check("cut text keeps the empty row", cut === "d\n\np", JSON.stringify(cut));
  check("cut removed every row's fragment, short line not merged", s.doc === "abcefghij\nkl\nmnoqrstuv\nwxyz\n0123456789", JSON.stringify(s.doc));

  step("scenario 6: Delete removes every row's fragment");
  await bootstrap(cdp);
  await setSel(cdp, 3);
  await col(cdp, "Down"); await col(cdp, "Down"); await col(cdp, "Right");
  await key(cdp, "Delete", 46);
  s = await selState(cdp);
  check("rows spliced, short line not merged", s.doc === "abcefghij\nkl\nmnoqrstuv\nwxyz\n0123456789", JSON.stringify(s.doc));
  check("one caret per row remains (multi-cursor editing)", s.ranges.length === 3, `ranges=${s.ranges.length}`);

  step("scenario 6: typing into an empty column inserts on every line");
  await bootstrap(cdp);
  await setSel(cdp, 0);
  await col(cdp, "Down"); // empty column over lines 1-2 = multi-cursor
  s = await selState(cdp);
  check("empty column = one caret per line", eq(s.ranges, [[0, 0], [11, 11]]), JSON.stringify(s.ranges));
  await cdp.send("Input.insertText", { text: "X" });
  s = await selState(cdp);
  check("typed on both lines", s.doc === "Xabcdefghij\nXkl\nmnopqrstuv\nwxyz\n0123456789", JSON.stringify(s.doc));

  step("scenario 7: Alt+Shift held shows the column chips");
  const hold = { key: "", code: "", windowsVirtualKeyCode: 0, modifiers: 0, location: 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...hold, key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, modifiers: M.alt, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...hold, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: M.alt | M.shift, type: "keyDown" });
  const chips = await evalIn(cdp, `[...document.querySelectorAll(".fkeys kbd")].map((k) => k.textContent)`);
  await cdp.send("Input.dispatchKeyEvent", { ...hold, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: M.alt, type: "keyUp" });
  await cdp.send("Input.dispatchKeyEvent", { ...hold, key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, modifiers: 0, type: "keyUp" });
  check("F-key bar swapped to the Alt+Shift column row", chips.includes("Alt+Shift+↑↓←→") && chips.includes("Alt+Shift+Home/End"), JSON.stringify(chips));

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
