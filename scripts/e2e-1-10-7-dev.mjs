// Dev E2E for 1.10.7: the copy/move progress window is centered on the
// screen. The overlay used to override .overlay with align-items:flex-end /
// justify-content:flex-start + paddings, planting the progress card in the
// bottom-left corner; the override is gone and the dialog must sit dead
// center like every other dialog. Loads the app from the vite dev server in
// headless Edge, drives the REAL ui/ops stores (same instances the app uses)
// and measures the rendered .dlg geometry against the viewport: copy phase,
// scan phase, done-with-errors phase (tallest), at 1280x800 and 720x400.
// Regression: the conflict and input (F5 transfer) dialogs stay centered.
// Usage: node scripts/e2e-1-10-7-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9237;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-1107-"));
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

// center deltas of the rendered dialog against the viewport (px, signed)
const dlgCenter = (cdp) => evalIn(cdp, `
  (() => {
    const ov = document.querySelector(".overlay");
    const dlg = ov?.querySelector(".dlg");
    if (!dlg) return null;
    const r = dlg.getBoundingClientRect();
    return {
      dx: Math.round(((r.left + r.right) / 2 - innerWidth / 2) * 10) / 10,
      dy: Math.round(((r.top + r.bottom) / 2 - innerHeight / 2) * 10) / 10,
      w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight,
      overlayStyle: ov.getAttribute("style") ?? "",
    };
  })()
`);

const setOp = (cdp, op) => evalIn(cdp, `
  (() => {
    const { ops, ui } = window.__e2e;
    ops.op = ${JSON.stringify(op)};
    if (ui.dialog !== "progress") ui.openDialog("progress");
    return ui.dialog;
  })()
`);

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
  // HMR-instance lesson)
  await evalIn(cdp, `
    (async () => {
      const imp = new Function("u", "return import(u)");
      const base = "${ORIGIN}/src/lib/";
      const src = await (await fetch(base + "register-commands.ts")).text();
      const u = (re) => new URL(src.match(re)[1], base).href;
      const { ops } = await imp(u(/from\\s+"([^"]*stores\\/ops\\.svelte\\.ts[^"]*)"/));
      const { ui } = await imp(u(/from\\s+"([^"]*stores\\/ui\\.svelte\\.ts[^"]*)"/));
      window.__e2e = { ops, ui };
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__TAURI_INTERNALS__.invoke = () => Promise.resolve(null);
      return true;
    })()
  `);
  await sleep(500);

  const baseOp = {
    id: 1, title: "Копирование", phase: "copy",
    bytesDone: 1048576, bytesTotal: 4194304,
    filesDone: 2, filesTotal: 7, current: "D:\\E2E-1107\\big-file.bin",
    speed: 5242880, cancelled: false, errors: [], paused: false,
  };

  // A) mid-copy progress dialog is centered at 1280x800, no corner overrides left
  await setOp(cdp, baseOp);
  await sleep(400);
  let g = await dlgCenter(cdp);
  check("A: copy progress centered (dx<=1, dy<=1)", Math.abs(g.dx) <= 1 && Math.abs(g.dy) <= 1,
    `dx=${g.dx} dy=${g.dy} dlg=${g.w}x${g.h} vp=${g.vw}x${g.vh}`);
  check("A: overlay has no positioning override", g.overlayStyle === "", JSON.stringify(g.overlayStyle));
  check("A: pause/background/cancel buttons still rendered",
    await evalIn(cdp, `[...document.querySelectorAll(".overlay .dlg-actions .btn")].map((b) => b.textContent.trim()).join("|")`)
      .then((t) => t.length > 0), "");

  // B) scan phase centered
  await setOp(cdp, { ...baseOp, phase: "scan", bytesDone: 0, filesDone: 0, speed: 0, current: "" });
  await sleep(300);
  g = await dlgCenter(cdp);
  check("B: scan phase centered", Math.abs(g.dx) <= 1 && Math.abs(g.dy) <= 1, `dx=${g.dx} dy=${g.dy}`);

  // C) done-with-errors phase (tallest variant) centered
  await setOp(cdp, {
    ...baseOp, phase: "done", cancelled: true,
    errors: Array.from({ length: 6 }, (_, i) => ({ path: `D:\\E2E-1107\\f${i}.txt`, error: "Access is denied" })),
  });
  await sleep(300);
  g = await dlgCenter(cdp);
  check("C: done+errors phase centered", Math.abs(g.dx) <= 1 && Math.abs(g.dy) <= 1, `dx=${g.dx} dy=${g.dy} h=${g.h}`);

  // D) small viewport 720x400 — still centered
  await setOp(cdp, baseOp);
  await sleep(200);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 400, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  g = await dlgCenter(cdp);
  check("D: centered at 720x400", Math.abs(g.dx) <= 1 && Math.abs(g.dy) <= 1, `dx=${g.dx} dy=${g.dy} dlg=${g.w}x${g.h} vp=${g.vw}x${g.vh}`);
  check("D: dialog fits the small viewport", g.w <= g.vw && g.h <= g.vh, `dlg=${g.w}x${g.h} vp=${g.vw}x${g.vh}`);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await sleep(400);

  // E) regression: conflict dialog centered
  await evalIn(cdp, `
    (() => {
      const { ops, ui } = window.__e2e;
      ops.op = ${JSON.stringify(baseOp)};
      ops.conflict = { id: 1, src: "D:\\\\a.txt", dst: "D:\\\\b.txt" };
      ui.openDialog("conflict");
      return true;
    })()
  `);
  await sleep(300);
  g = await dlgCenter(cdp);
  check("E: conflict dialog still centered", Math.abs(g.dx) <= 1 && Math.abs(g.dy) <= 1, `dx=${g.dx} dy=${g.dy}`);

  // F) regression: F5 transfer input dialog centered
  await evalIn(cdp, `
    (() => {
      const { ui } = window.__e2e;
      ui.inputReq = null;
      ui.confirmReq = null;
      ui.packReq = null;
      ui.openDialog("input");
      ui.inputReq = { title: "Копирование", prompt: "в:", value: "D:\\\\dst", resetTo: null, variants: [], resolve: () => {} };
      return ui.dialog;
    })()
  `);
  await sleep(300);
  g = await dlgCenter(cdp);
  check("F: transfer input dialog still centered", Math.abs(g.dx) <= 1 && Math.abs(g.dy) <= 1, `dx=${g.dx} dy=${g.dy}`);

  // G) cleanup: the stores close the dialog (an unrelated startup-error
  // overlay from the mocked backend may legitimately remain)
  await evalIn(cdp, `
    (() => {
      const { ops, ui } = window.__e2e;
      ops.op = null;
      ops.conflict = null;
      ui.inputReq = null;
      ui.closeDialog();
      return ui.dialog === null && ops.op === null;
    })()
  `).then((ok) => check("G: stores close the dialog cleanly", ok === true, ""));
} catch (e) {
  check("script crashed", false, String(e));
} finally {
  edge.kill();
  if (ours) ours.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
