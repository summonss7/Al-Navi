// Unit-level E2E for 1.10.0 pure modules against the vite dev server:
// imports src/lib/multiRename.ts and the userMenu store by URL in a headless
// Edge page (the pattern from the e2e memory: direct module imports with the
// full ".svelte.ts" URL, no Tauri backend involved).
// Usage: node scripts/e2e-1-10-0-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9227;
const ORIGIN = `http://localhost:${PORT}`; // the dev server binds to ::1
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-dev-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// reuse a dev server left running by a previous session if it serves this app
const alive = await fetch(`${ORIGIN}/`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
const ours = alive && alive.includes("Al-Navi") ? null : spawn("npm", ["run", "dev"], { shell: true, stdio: "ignore" });
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
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
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const ready = new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws error"));
  });
  return {
    ready,
    send(method, params = {}) {
      return new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
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
  const nav = await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  if (nav.errorText) throw new Error("nav: " + nav.errorText);
  await sleep(2500);

  // ---- applyMultiRename unit cases ----
  const unit = await evalIn(cdp, `
    (async () => {
      const imp = new Function("u", "return import(u)");
      const m = await imp("${ORIGIN}/src/lib/multiRename.ts");
      const t = (names) => names.map((n) => ({ path: "D:\\\\T\\\\" + n, name: n }));
      const f = m.defaultMrForm();
      const run = (targets, form) => m.applyMultiRename(targets, { ...f, ...form });
      const out = {};

      // default form: everything unchanged
      out.defaultUnchanged = run(t(["a.txt", "b.txt"]), {}).map((r) => r.status);

      // mask narrows the set
      out.masked = run(t(["a.txt", "b.dat"]), { mask: "*.txt" }).map((r) => r.oldName);

      // comma-OR mask
      out.maskOr = run(t(["a.txt", "b.dat", "c.log"]), { mask: "*.txt, *.log" }).map((r) => r.oldName);

      // counter: start 5, step 10, 3 digits, ext kept via [E]
      out.counter = run(t(["x.txt", "y.txt", "z.txt"]), {
        nameTmpl: "photo-[C]", extTmpl: "[E]", countStart: 5, countStep: 10, countDigits: 3,
      }).map((r) => r.newName);

      // find/replace over the combined name, case-insensitive then sensitive
      out.replaceCi = run(t(["Report.TXT"]), { find: "R", replace: "X" }).map((r) => r.newName);
      out.replaceCs = run(t(["Report.TXT"]), { find: "r", replace: "X", caseSensitive: true }).map((r) => r.newName);

      // invalid names: template yielding "/" and empty (ext-only on extensionless)
      out.invalid = run(t(["a.txt"]), { nameTmpl: "x/y", extTmpl: "[E]" }).map((r) => r.status);
      out.emptyInvalid = run(t(["Makefile"]), { nameTmpl: "[E]", extTmpl: "[E]" }).map((r) => r.status);

      // duplicate targets inside the batch
      out.dup = run(t(["one.txt", "two.txt"]), { nameTmpl: "same" }).map((r) => r.status);

      // trailing dot is invalid on Windows (no extension part appended)
      out.trailingDot = run(t(["a.txt"]), { nameTmpl: "bad.", extTmpl: "" }).map((r) => r.status);
      return out;
    })()
  `);
  check("default form keeps names unchanged", JSON.stringify(unit.defaultUnchanged) === JSON.stringify(["unchanged", "unchanged"]), JSON.stringify(unit.defaultUnchanged));
  check("mask *.txt narrows targets", JSON.stringify(unit.masked) === JSON.stringify(["a.txt"]), JSON.stringify(unit.masked));
  check("comma mask is OR", JSON.stringify(unit.maskOr) === JSON.stringify(["a.txt", "c.log"]), JSON.stringify(unit.maskOr));
  check("counter start/step/digits", JSON.stringify(unit.counter) === JSON.stringify(["photo-005.txt", "photo-015.txt", "photo-025.txt"]), JSON.stringify(unit.counter));
  check("replace is case-insensitive by default", JSON.stringify(unit.replaceCi) === JSON.stringify(["XepoXt.TXT"]), JSON.stringify(unit.replaceCi));
  check("replace honors case flag", JSON.stringify(unit.replaceCs) === JSON.stringify(["RepoXt.TXT"]), JSON.stringify(unit.replaceCs));
  check("slash in template is invalid", unit.invalid[0] === "invalid", JSON.stringify(unit.invalid));
  check("empty result is invalid", unit.emptyInvalid[0] === "invalid", JSON.stringify(unit.emptyInvalid));
  check("duplicate new names flagged", JSON.stringify(unit.dup) === JSON.stringify(["ok", "dup"]), JSON.stringify(unit.dup));
  check("trailing dot is invalid", unit.trailingDot[0] === "invalid", JSON.stringify(unit.trailingDot));

  // ---- userMenu store + placeholder expansion ----
  // the dev server appends HMR ?t= suffixes to rewritten imports, so a plain
  // panels.svelte.ts import would be a DIFFERENT store instance than the one
  // userMenu.svelte.ts closed over — resolve the exact URL it imports
  const ph = await evalIn(cdp, `
    (async () => {
      const imp = new Function("u", "return import(u)");
      const base = "${ORIGIN}/src/lib/stores/";
      const src = await (await fetch(base + "userMenu.svelte.ts")).text();
      const m = src.match(/from\\s+"([^"]*panels\\.svelte\\.ts[^"]*)"/);
      const panelsUrl = new URL(m[1], base).href;
      const { panels } = await imp(panelsUrl);
      const { expandUserPlaceholders } = await imp(base + "userMenu.svelte.ts");
      // seed the active panel: a cursor file + its directory
      const p = panels.active;
      const t = p.tabs.find((x) => x.id === p.activeTabId) || p.tabs[0];
      t.path = "D:\\\\Docs";
      const entry = (name, isDir = false) => ({ name, isDir, size: 1, mtime: 0, attrs: "", isSymlink: false, isHidden: false });
      p.view = [entry("report 2026.pdf")];
      const out = {};
      out.full = expandUserPlaceholders("run !! now");
      out.stem = expandUserPlaceholders("convert ! to pdf");
      out.dir = expandUserPlaceholders("cd !\\\\");
      // ".." under the cursor -> placeholders resolve to empty strings
      p.view = [entry("..", true)];
      out.up = expandUserPlaceholders("x!y!!z");
      // a name containing its own "!" must not be re-expanded (single pass)
      p.view = [entry("a!b.txt")];
      out.selfBang = expandUserPlaceholders("[!!]");
      return out;
    })()
  `);
  check("!! expands to full name", ph.full === "run report 2026.pdf now", ph.full);
  check("! expands to stem", ph.stem === "convert report 2026 to pdf", ph.stem);
  check("!\\ expands to panel dir", ph.dir === "cd D:\\Docs\\", ph.dir);
  check("'..' cursor -> empty substitution", ph.up === "xyz", ph.up);
  check("'!' inside a name is not re-expanded", ph.selfBang === "[a!b.txt]", ph.selfBang);

  cdp.close();
} catch (e) {
  check("script ran", false, String(e));
} finally {
  edge.kill();
  if (ours) ours.kill();
  // the browser releases its profile dir asynchronously — best effort only
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 500);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
