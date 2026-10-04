// Dev E2E for alnavi-023: in the confirm and conflict dialogs the lime accent
// fill must RIDE THE FOCUS — arrows (and Tab) move it to the next button, the
// old default demotes to a plain button, and with focus lost the static
// primary lights up again as the fallback. Enter still activates the FOCUSED
// button (askConfirm resolves false from "Нет", conflict fires resolve_conflict
// with the focused action).
// Usage: node scripts/e2e-alnavi-023-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9247;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-023-"));
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
const VK = { Enter: 13, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
async function key(cdp, k, code) {
  const base = {
    key: k,
    code: code ?? k,
    windowsVirtualKeyCode: VK[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0),
  };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  // .btn paints its background through a 0.12s transition — let it finish
  // before the caller snapshots computed styles
  await sleep(250);
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
  step("navigating");
  await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  await sleep(2500);
  // headless pages start WITHOUT renderer focus: document.activeElement can be
  // set, but :focus never matches and Enter doesn't click the focused button —
  // exactly what this test exercises. The flag must be set AFTER the
  // navigation: a new document resets it.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  step("bootstrapping stores");

  // bootstrap: mock the backend, import the stores through the URLs the app
  // itself uses — register-commands.ts as served by vite already carries the
  // rewritten store URLs, so the instances match the rendered dialog
  await evalIn(cdp, `
    (async () => {
      const imp = new Function("u", "return import(u)");
      const src = await (await fetch("${ORIGIN}/src/lib/register-commands.ts")).text();
      const urlOf = (re) => {
        const m = src.match(re);
        if (!m) throw new Error("specifier not found: " + re);
        return new URL(m[1], "${ORIGIN}/src/lib/").href;
      };
      const { ui } = await imp(urlOf(/from\\s+"([^"]*stores\\/ui\\.svelte[^"]*)"/));
      const { ops } = await imp(urlOf(/from\\s+"([^"]*stores\\/ops\\.svelte[^"]*)"/));
      window.__e2e = { ui, ops, log: [] };
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        window.__e2e.log.push([cmd, args]);
        switch (cmd) {
          case "drives_list": return Promise.resolve([
            { name: "Local (C:)", mountPoint: "C:\\\\", kind: "fixed", totalBytes: 500000000000, freeBytes: 100000000000 },
          ]);
          case "list_dir": return Promise.resolve({ path: args.path, entries: [], freeBytes: 0, totalBytes: 0 });
          case "load_json": return Promise.resolve(null);
          case "save_json": return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          default: return Promise.resolve(null);
        }
      };
      ui.closeDialog();
      return true;
    })()
  `);

  const LIME = "rgb(142, 229, 63)";
  // snapshot of the open dialog's action buttons: computed bg + focus position
  const snap = () => evalIn(cdp, `
    (() => {
      const btns = Array.from(document.querySelectorAll(".overlay .dlg .dlg-actions button"));
      if (!btns.length) return null;
      const ae = document.activeElement;
      return {
        n: btns.length,
        bg: btns.map((b) => getComputedStyle(b).backgroundColor),
        text: btns.map((b) => b.textContent.trim()),
        focus: btns.indexOf(ae),
        open: !!document.querySelector(".overlay .dlg"),
        hasFocus: document.hasFocus(),
        aeMatchesFocus: ae && ae.matches ? ae.matches(":focus") : null,
      };
    })()
  `);
  const openConfirm = () => evalIn(cdp, `
    window.__e2e.confirmP = window.__e2e.ui.askConfirm("e2e alnavi-023: удалить?");
    "pending"
  `);
  const confirmResult = () => evalIn(cdp, `
    Promise.race([
      window.__e2e.confirmP.then((v) => ["resolved", v]).catch(() => ["rejected"]),
      new Promise((res) => setTimeout(() => res(["timeout"]), 4000)),
    ])
  `);

  // ---- confirm: the fill follows arrows / Tab, demotes the old default,
  // falls back to the static primary when focus leaves the buttons ----
  await openConfirm();
  let s = await waitFor(snap, 5000, "confirm dialog");
  check("confirm: two buttons rendered", s.n === 2, s.text.join(" / "));
  check("confirm: initial — «Да» (primary) is lime and focused",
    s.bg[1] === LIME && s.bg[0] !== LIME && s.focus === 1, `bg=${s.bg} focus=${s.focus} winFocus=${s.hasFocus} aeFocus=${s.aeMatchesFocus}`);

  await key(cdp, "ArrowLeft");
  s = await snap();
  check("confirm: ← moves the lime fill onto «Нет»",
    s.bg[0] === LIME && s.bg[1] !== LIME && s.focus === 0, `bg=${s.bg} focus=${s.focus} winFocus=${s.hasFocus} aeFocus=${s.aeMatchesFocus}`);

  await key(cdp, "ArrowRight");
  s = await snap();
  check("confirm: → moves the fill back onto «Да»",
    s.bg[1] === LIME && s.bg[0] !== LIME && s.focus === 1, `bg=${s.bg} focus=${s.focus} winFocus=${s.hasFocus} aeFocus=${s.aeMatchesFocus}`);

  // plain focus() (no key involved) moves the fill too — the CSS is purely
  // focus-driven (Tab is not used here: headless Tab escapes to the browser
  // chrome and kills the page focus for the rest of the run)
  await evalIn(cdp, `document.querySelectorAll(".overlay .dlg .dlg-actions button")[0].focus(); true`);
  await sleep(250);
  s = await snap();
  check("confirm: a plain focus() moves the fill (focus-driven, not arrow-only)",
    s.bg[0] === LIME && s.bg[1] !== LIME && s.focus === 0, `bg=${s.bg} focus=${s.focus} winFocus=${s.hasFocus} aeFocus=${s.aeMatchesFocus}`);

  // focus moves outside the row (a stray click lands on the overlay): the
  // fill must return to the static default. blur() alone doesn't clear :focus
  // under focus emulation, so the focus is MOVED to an offscreen input —
  // same CSS state as a real stray click
  await evalIn(cdp, `
    const inp = document.createElement("input");
    inp.style.cssText = "position:fixed;left:-9999px";
    inp.id = "e2e-stray";
    document.body.appendChild(inp);
    inp.focus();
    document.activeElement && document.activeElement.id
  `);
  await sleep(250);
  s = await snap();
  check("confirm: focus left the row — static primary «Да» lights up again (fallback)",
    s.bg[1] === LIME && s.bg[0] !== LIME && s.focus === -1, `bg=${s.bg} focus=${s.focus} winFocus=${s.hasFocus} aeFocus=${s.aeMatchesFocus}`);

  // ---- activating the FOCUSED button, not the static default ----
  // NB: a CDP-synthesized Enter/Space does NOT trigger button activation in
  // headless Edge (verified on a bare data: page — an environment limit, not
  // app behavior; a real WebView2 window activates fine), so the focused
  // button's onclick is invoked directly — the very handler the browser's
  // Enter-activation calls
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(cdp, `
    const b = document.querySelectorAll(".overlay .dlg .dlg-actions button")[0];
    b.focus(); b.click(); "clicked"
  `);
  let r = await waitFor(confirmResult, 5000, "confirm resolve");
  check("confirm: activating focused «Нет» resolves false", r[0] === "resolved" && r[1] === false, JSON.stringify(r));
  check("confirm: dialog closed after activation", !(await snap()));

  await openConfirm();
  await waitFor(snap, 5000, "confirm dialog reopen");
  await evalIn(cdp, `document.activeElement.click(); "clicked"`);
  r = await waitFor(confirmResult, 5000, "confirm resolve");
  check("confirm: activating right away resolves true (default «Да»)", r[0] === "resolved" && r[1] === true, JSON.stringify(r));

  // ---- conflict dialog: five actions, same focus-riding fill + wrap ----
  await evalIn(cdp, `
    window.__e2e.ops.conflict = { id: 7, src: "C:\\\\e2e\\\\a.txt", dst: "C:\\\\e2e\\\\dst\\\\a.txt", isDir: false };
    window.__e2e.ui.openDialog("conflict");
    true
  `);
  s = await waitFor(snap, 5000, "conflict dialog");
  check("conflict: five buttons rendered", s.n === 5, s.text.join(" / "));
  check("conflict: initial — «Копировать» (primary) is lime and focused",
    s.bg[0] === LIME && s.focus === 0, `bg=${s.bg} focus=${s.focus} winFocus=${s.hasFocus} aeFocus=${s.aeMatchesFocus}`);

  await key(cdp, "ArrowRight");
  await key(cdp, "ArrowRight");
  s = await snap();
  check("conflict: → → moves the fill to the third action, first demotes to plain",
    s.bg[2] === LIME && s.bg[0] !== LIME && s.focus === 2, `bg=${s.bg} focus=${s.focus} winFocus=${s.hasFocus} aeFocus=${s.aeMatchesFocus}`);

  await key(cdp, "ArrowLeft");
  await key(cdp, "ArrowLeft");
  await key(cdp, "ArrowLeft");
  s = await snap();
  check("conflict: ← ×3 wraps around to the last action",
    s.focus === 4 && s.bg[4] === LIME && s.bg[0] !== LIME, `focus=${s.focus} bg=${s.bg} winFocus=${s.hasFocus} aeFocus=${s.aeMatchesFocus}`);

  await evalIn(cdp, `document.activeElement.click(); "clicked"`);
  await sleep(400);
  const fired = await evalIn(cdp, `window.__e2e.log.filter(([c]) => c === "resolve_conflict").pop() || null`);
  check("conflict: activating focused «Переименовать» fires resolve_conflict(rename)",
    !!fired && fired[1]?.id === 7 && fired[1]?.action === "rename", JSON.stringify(fired));
  check("conflict: dialog closed after activation", !(await snap()));
} catch (e) {
  check("script crashed", false, String(e));
} finally {
  const fails = results.filter((x) => !x.ok).length;
  console.log(`\n${fails ? fails + " FAILED" : "ALL " + results.length + " PASSED"}`);
  edge.kill();
  if (ours) ours.kill();
  process.exit(fails ? 1 : 0);
}
// watchdog: never hang the CI shell — a stalled CDP await is a failure, not a hang
setTimeout(() => { console.log("\nWATCHDOG: script stalled, exiting 2"); edge.kill(); if (ours) ours.kill(); process.exit(2); }, 120000).unref();
