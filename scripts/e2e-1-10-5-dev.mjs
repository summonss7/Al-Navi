// Dev E2E for 1.10.5: the editor status bar shows the character under the
// caret (decimal + hex code point, ASCII for Latin / Unicode otherwise, \n \t
// and caret notation for controls) and the document totals — characters (a
// surrogate pair counts once), lines, spaces. Loads the app from the vite dev
// server in headless Edge, installs a fake read_text backend into
// window.__TAURI_INTERNALS__.invoke and drives the REAL editor store + the
// mounted CodeMirror view, reading the rendered status bar. Also regression-
// checks the selection size and that the bar doesn't overflow at 1280x800 and
// 720x400 (the totals ellipsize, the EOL/encoding selects stay whole).
// Usage: node scripts/e2e-1-10-5-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9235;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-1105-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fixtures: latin (plain counts), cyrillic (code points > 0x7F), tab+emoji
// (control escape + surrogate pair counted as ONE character)
const DOC1 = "Hello World\nLine 2"; // 18 chars, 2 lines, 2 spaces
const DOC2 = "Привет, мир!\nвторая строка"; // 26 chars, 2 lines, 2 spaces
const DOC3 = "a\tb😀"; // 4 chars, 1 line, 0 spaces
const P = {
  d1: "D:\\E2E-1105\\a.txt",
  d2: "D:\\E2E-1105\\b-rus.txt",
  d3: "D:\\E2E-1105\\c-emoji.txt",
};
const FS = {
  [P.d1]: DOC1,
  [P.d2]: DOC2,
  [P.d3]: DOC3,
};

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

try {
  await waitFor(() => fetch(`${ORIGIN}/`).then((r) => (r.ok ? true : null)), 30000, "vite dev");
  const targets = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.find((t) => t.type === "page");
  }, 20000, "edge cdp");
  const cdp = await connect(targets.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  await sleep(2500);

  // bootstrap: mock the backend, import the stores through the exact URLs
  // register-commands.ts uses (vite rewrites $lib/* to /src/lib/* — the
  // HMR-instance lesson), open doc1
  await evalIn(cdp, `
    (async () => {
      const imp = new Function("u", "return import(u)");
      const base = "${ORIGIN}/src/lib/";
      const src = await (await fetch(base + "register-commands.ts")).text();
      const u = (re) => new URL(src.match(re)[1], base).href;
      const { editor } = await imp(u(/from\\s+"([^"]*editor\\.svelte\\.ts[^"]*)"/));
      const cm = await imp(u(/import\\("([^"]*editor\\/cm[^"]*)"/));
      window.__e2e = { editor, cm };

      const FS = ${JSON.stringify(FS)};
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => new Promise((resolve, reject) => {
        if (cmd === "read_text") {
          if (!(args.path in FS)) { reject(new Error("no such file: " + args.path)); return; }
          const text = FS[args.path];
          resolve({ text, encoding: "utf-8", bom: false, eol: "lf", size: text.length, truncated: false });
          return;
        }
        resolve(null);
      });
      await window.__e2e.editor.open(${JSON.stringify(P.d1)});
      return true;
    })()
  `);
  await sleep(700);

  const bar = () => evalIn(cdp, `
    (async () => {
      const bar = document.querySelector(".ed-status:not(.top)");
      if (!bar) return null;
      await new Promise((r) => setTimeout(r, 350)); // the caret tracker ticks every 300ms
      return {
        chip: bar.querySelector(".char-chip")?.textContent ?? null,
        totals: bar.querySelector(".totals")?.textContent ?? null,
        sel: [...bar.querySelectorAll("span")].map((s) => s.textContent).find((t) => /^Sel /.test(t ?? "")) ?? null,
        line: bar.querySelector("span.mono")?.textContent ?? null,
      };
    })()
  `);
  const caret = (n, selection) => evalIn(cdp, `
    (async () => {
      const v = window.__e2e.cm.currentView();
      v.dispatch(${selection ? `{ selection: ${selection} }` : `{ selection: { anchor: ${n} } }`});
      return v.state.selection.main.head;
    })()
  `);
  const open = (p) => evalIn(cdp, `window.__e2e.editor.open(${JSON.stringify(p)})`);

  // A) totals of doc1 and the chip at the initial caret (0 -> 'H')
  let s = await bar();
  check("A: doc1 totals Chars 18 / Lines 2 / Spaces 2", /Chars 18 .*Lines 2 .*Spaces 2/.test(s.totals ?? ""), JSON.stringify(s.totals));
  check("A: chip shows 'H' 72 0x48 at caret 0", (s.chip ?? "").includes("'H' 72 0x48"), JSON.stringify(s.chip));

  // B) 'W' inside the line
  await caret(6); s = await bar();
  check("B: chip shows 'W' 87 0x57", (s.chip ?? "").includes("'W' 87 0x57"), JSON.stringify(s.chip));

  // C) newline under the caret (end of line 1)
  await caret(11); s = await bar();
  check("C: newline escapes as '\\\\n' 10 0x0A", (s.chip ?? "").includes("'\\n' 10 0x0A"), JSON.stringify(s.chip));

  // D) caret at the very end -> the LAST character, not past it
  await caret(DOC1.length); s = await bar();
  check("D: at doc end the chip falls back to '2' 50 0x32", (s.chip ?? "").includes("'2' 50 0x32"), JSON.stringify(s.chip));

  // E) tab escape + emoji surrogate pair (counted as ONE character)
  await open(P.d3); await sleep(500);
  await caret(1); s = await bar();
  check("E: tab escapes as '\\\\t' 9 0x09", (s.chip ?? "").includes("'\\t' 9 0x09"), JSON.stringify(s.chip));
  await caret(3); s = await bar();
  check("E: emoji code point '😀' 128512 0x1F600", (s.chip ?? "").includes("'😀' 128512 0x1F600"), JSON.stringify(s.chip));
  check("E: surrogate pair counts once — Chars 4 / Lines 1 / Spaces 0", /Chars 4 .*Lines 1 .*Spaces 0/.test(s.totals ?? ""), JSON.stringify(s.totals));

  // F) cyrillic: Unicode code point, not a mangled UTF-16 half
  await open(P.d2); await sleep(500);
  await caret(0); s = await bar();
  check("F: cyrillic 'П' 1055 0x41F", (s.chip ?? "").includes("'П' 1055 0x41F"), JSON.stringify(s.chip));
  check("F: doc2 totals Chars 26 / Lines 2 / Spaces 2", /Chars 26 .*Lines 2 .*Spaces 2/.test(s.totals ?? ""), JSON.stringify(s.totals));

  // G) totals follow edits live (append " !" -> +2 chars, +1 space)
  await open(P.d1); await sleep(500);
  await evalIn(cdp, `
    (async () => {
      const v = window.__e2e.cm.currentView();
      v.dispatch({ changes: { from: v.state.doc.length, insert: " !" } });
      await new Promise((r) => setTimeout(r, 250));
      return true;
    })()
  `);
  s = await bar();
  check("G: after typing totals are Chars 20 / Lines 2 / Spaces 3", /Chars 20 .*Lines 2 .*Spaces 3/.test(s.totals ?? ""), JSON.stringify(s.totals));

  // H) selection size still shown next to the chip (regression)
  await caret(0, "{ anchor: 0, head: 5 }"); s = await bar();
  check("H: 'Sel 5' still rendered", /^Sel 5/.test(s.sel ?? ""), JSON.stringify(s.sel));

  // I) tab switch: totals swap with the active document
  await evalIn(cdp, `
    (async () => {
      const { editor } = window.__e2e;
      editor.activate(editor.docs.find((d) => d.path === ${JSON.stringify(P.d2)}).id);
      await new Promise((r) => setTimeout(r, 400));
      return true;
    })()
  `);
  s = await bar();
  check("I: after switching to doc2 totals are Chars 26 again", /Chars 26 .*Lines 2 .*Spaces 2/.test(s.totals ?? ""), JSON.stringify(s.totals));

  // J) the bar never overflows: totals ellipsize, selects stay whole
  const geom = async () => evalIn(cdp, `
    (async () => {
      await new Promise((r) => setTimeout(r, 250));
      const bar = document.querySelector(".ed-status:not(.top)");
      const sel = [...bar.querySelectorAll("select")];
      const last = sel[sel.length - 1]?.getBoundingClientRect();
      return {
        overflow: bar.scrollWidth - bar.clientWidth,
        selRight: last?.right ?? -1,
        vw: innerWidth,
        totalsW: bar.querySelector(".totals").getBoundingClientRect().width,
      };
    })()
  `);
  let g = await geom();
  check("J: no overflow at 1280x800, selects inside the viewport", g.overflow <= 1 && g.selRight <= g.vw, JSON.stringify(g));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 400, deviceScaleFactor: 0, mobile: false });
  g = await geom();
  check("J: no overflow at 720x400 (totals shrink, selects intact)", g.overflow <= 1 && g.selRight <= g.vw, JSON.stringify(g));
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  cdp.close();
} catch (e) {
  check("script ran", false, String(e));
} finally {
  edge.kill();
  if (ours) ours.kill();
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 500);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
