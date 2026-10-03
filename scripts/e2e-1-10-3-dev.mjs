// Dev E2E for 1.10.3: F5/F6 destination-variant list no longer squashes.
// Loads the app from the vite dev server in headless Edge, opens ui.askInput
// with a worst-case variant list (5 presets + 8 long history entries) and
// asserts the DOM geometry at three window sizes: rows keep their full height
// (before the fix overflow:hidden zeroed the flex min-height and every row
// collapsed to a 14px sliver), the list scrolls instead, the dialog stays
// inside the viewport, long paths get the ellipsis, and arrow cycling /
// submit still work after the markup change (path moved into a span).
// Usage: node scripts/e2e-1-10-3-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9233;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-1103-"));
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

// (re)open the transfer-style dialog with the worst-case variant list
const VARIANTS = [
  "D:\\Al-Navi\\src-tauri\\target\\release",
  "D:\\Al-Navi",
  "C:\\Users\\CUSTOM\\Documents",
  "C:\\temp",
  "D:\\",
  "C:\\Users\\CUSTOM\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\packages\\bundled-skills",
  "E:\\Backups\\Al-Navi\\2026-09",
  "\\\\NAS\\media\\video\\series\\Some Long Show Name Season 1 Complete 1080p",
  "C:\\Users\\CUSTOM\\Downloads",
  "D:\\work\\projects\\very\\deeply\\nested\\directory\\structure\\for\\testing",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application",
  "ftp://ftp.gnu.org/gnu/emacs",
  "D:\\tmp\\scratch",
];
function openDialog() {
  return `
    (async () => {
      const imp = new Function("u", "return import(u)");
      const src = await (await fetch("${ORIGIN}/src/lib/register-commands.ts")).text();
      const u = (re) => new URL(src.match(re)[1], "${ORIGIN}/src/lib/").href;
      const { ui } = await imp(u(/from\\s+"([^"]*ui\\.svelte\\.ts[^"]*)"/));
      window.__answer = ui.askInput("Copy 1 file", "Destination", ${JSON.stringify(VARIANTS[0])}, undefined, ${JSON.stringify(VARIANTS)});
      await new Promise(r => setTimeout(r, 120));
      return "opened";
    })()
  `;
}
const measure = `
  (() => {
    const box = document.querySelector(".variants");
    const br = box.getBoundingClientRect();
    const rows = [...document.querySelectorAll(".variants .li")].map(el => {
      const r = el.getBoundingClientRect();
      const span = el.querySelector(".path");
      return { top: Math.round(r.top), h: Math.round(r.height), textH: span ? Math.round(span.getBoundingClientRect().height) : -1 };
    });
    const dlg = document.querySelector(".dlg").getBoundingClientRect();
    const actions = document.querySelector(".dlg-actions").getBoundingClientRect();
    const input = document.querySelector(".dlg-body input").getBoundingClientRect();
    const longSpan = [...document.querySelectorAll(".variants .li .path")].find(s => s.textContent.length > 60);
    return {
      nRows: rows.length,
      minHeight: Math.min(...rows.map(r => r.h)),
      maxTextH: Math.max(...rows.map(r => r.textH)),
      rowsOverlap: rows.slice(1).some((r, i) => r.top < rows[i].top + rows[i].h - 1),
      listClientH: box.clientHeight,
      listScrollH: box.scrollHeight,
      listScrolls: box.scrollHeight > box.clientHeight + 1,
      dlgInside: dlg.top >= 0 && dlg.bottom <= innerHeight && dlg.left >= 0 && dlg.right <= innerWidth,
      actionsInsideDlg: actions.bottom <= dlg.bottom + 1,
      inputAboveList: input.bottom <= br.top + 1,
      longEll: longSpan ? getComputedStyle(longSpan).textOverflow + "/" + getComputedStyle(longSpan).whiteSpace : "none",
    };
  })()
`;

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

  for (const [w, h] of [[1280, 800], [900, 560], [720, 400]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    await evalIn(cdp, openDialog());
    const m = await evalIn(cdp, measure);
    const tag = `${w}x${h}`;
    check(`${tag}: 13 rows rendered`, m.nRows === 13, String(m.nRows));
    check(`${tag}: rows keep full height (>= text)`, m.minHeight >= m.maxTextH, `min row ${m.minHeight}px vs text ${m.maxTextH}px`);
    check(`${tag}: rows do not overlap`, !m.rowsOverlap);
    check(`${tag}: list scrolls its overflow`, m.listScrolls, `client ${m.listClientH} / scroll ${m.listScrollH}`);
    check(`${tag}: dialog inside viewport`, m.dlgInside);
    check(`${tag}: actions bar inside dialog`, m.actionsInsideDlg);
    check(`${tag}: input above the list`, m.inputAboveList);
    if (w === 1280) check("long path gets ellipsis+nowrap", m.longEll === "ellipsis/nowrap", m.longEll);
    await evalIn(cdp, `document.querySelector(".dlg-actions .btn:not(.primary)").click(); "closed"`);
    await sleep(150);
  }

  // keyboard flow after the markup change: bare ArrowDown cycles variants into
  // the field, highlights the row, and deep cycling scrolls the list to it
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(150);
  await evalIn(cdp, openDialog());
  const cyc = await evalIn(cdp, `
    (async () => {
      const inp = document.querySelector(".dlg-body input");
      inp.focus();
      const press = async (key) => {
        inp.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 30)); // let the rune effect flush + scrollIntoView run
      };
      await press("ArrowDown");
      // the prefill matched variant 0 (highlight starts there), so the first
      // ArrowDown cycles to variant 1
      const first = { val: inp.value, kbd: document.querySelector(".variants .li.kbd .path")?.textContent };
      for (let i = 0; i < 11; i++) await press("ArrowDown");
      const deep = { kbd: document.querySelector(".variants .li.kbd .path")?.textContent, scrollTop: Math.round(document.querySelector(".variants").scrollTop) };
      return { first, deep };
    })()
  `);
  check("ArrowDown puts the next variant into the field", cyc.first.val === VARIANTS[1], JSON.stringify(cyc.first.val));
  check("cycled row highlighted", cyc.first.kbd === VARIANTS[1], JSON.stringify(cyc.first.kbd));
  check("12x ArrowDown reaches variant 12", cyc.deep.kbd === VARIANTS[12], JSON.stringify(cyc.deep.kbd));
  check("list scrolled the highlight into view", cyc.deep.scrollTop > 0, "scrollTop=" + cyc.deep.scrollTop);

  // submit takes the cycled variant: the askInput promise resolves with it
  const answer = await evalIn(cdp, `
    (async () => {
      document.querySelector(".dlg-actions .btn.primary").click();
      return await window.__answer;
    })()
  `);
  check("Enter/OK submits the highlighted variant", answer === VARIANTS[12], JSON.stringify(answer));
  const closed = await evalIn(cdp, `(() => !!document.querySelector(".overlay .dlg"))()`);
  check("dialog closed after submit", !closed);

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
