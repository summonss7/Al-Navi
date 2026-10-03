// Real-exe E2E for 1.10.3: the F5/F6 destination-variant list must stay
// readable. Drives the built exe over CDP (isolated WEBVIEW2_USER_DATA_FOLDER;
// %APPDATA%\al-navi snapshotted/restored, xfer-history.json seeded with 8 long
// targets so the dialog carries the worst-case ~13 variants the user hit).
// Before the fix every row collapsed to a ~14px sliver (overflow:hidden zeroes
// a flex item's min-height, so rows shrank instead of the list scrolling).
// Usage: node scripts/e2e-1-10-3.mjs [path-to-exe]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const exe = process.argv[2] || join(dirname(dirname(fileURLToPath(import.meta.url))), "src-tauri", "target", "release", "al-navi.exe");
const PORT = 9234;
const profile = mkdtempSync(join(tmpdir(), "alnavi-cdp-"));
const work = mkdtempSync(join(tmpdir(), "alnavi-variants-"));
const CFG = join(process.env.APPDATA, "al-navi");
const SNAP_FILES = ["cmd-history.json", "dir-history.json", "session.json", "window.json", "xfer-history.json"];
const snap = {};
for (const f of SNAP_FILES) {
  const p = join(CFG, f);
  snap[f] = existsSync(p) ? readFileSync(p, "utf8") : null;
}
const restoreCfg = () => {
  for (const f of SNAP_FILES) {
    const p = join(CFG, f);
    try {
      if (snap[f] === null) { if (existsSync(p)) rmSync(p); }
      else writeFileSync(p, snap[f]);
    } catch (e) { console.error("restore failed for", f, e.message); }
  }
};

// sandbox with a file to copy and real dirs for a few history targets
writeFileSync(join(work, "sample.txt"), "card alnavi-004");
mkdirSync(join(work, "sub1"));
mkdirSync(join(work, "sub2"));
// worst-case history: 8 entries, mostly long
const HIST = [
  join(work, "sub1"),
  join(work, "sub2"),
  "C:\\Users\\CUSTOM\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\packages\\bundled-skills",
  "D:\\work\\projects\\very\\deeply\\nested\\directory\\structure\\for\\testing\\variants",
  "E:\\Backups\\Al-Navi\\2026-09\\full-weekly-with-long-names",
  "\\\\NAS\\media\\video\\series\\Some Long Show Name Season 1 Complete",
  "C:\\Users\\CUSTOM\\Downloads",
  "D:\\tmp\\scratch",
];
writeFileSync(join(CFG, "xfer-history.json"), JSON.stringify(HIST, null, 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(150);
  }
}

let child = null;
const launch = () => {
  child = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
    detached: false,
  });
};

async function findTarget(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && !t.url.startsWith("about:"));
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("CDP target not found");
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
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}
async function key(cdp, { key: k, code, keyCode, up = false }) {
  await cdp.send("Input.dispatchKeyEvent", {
    key: k, code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    type: up ? "keyUp" : "keyDown",
  });
}
const press = (cdp, k) => key(cdp, { ...k, up: false }).then(() => key(cdp, { ...k, up: true }));
const pressF5 = (cdp) => press(cdp, { key: "F5", code: "F5", keyCode: 116 });
const pressDown = (cdp) => press(cdp, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
const pressEsc = (cdp) => press(cdp, { key: "Escape", code: "Escape", keyCode: 27 });

try {
  launch();
  const target = await findTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  console.log(`connected: ${target.title ?? target.url}`);
  await sleep(2000);

  // ---- boot + version ----
  const boot = await evalIn(cdp, `(() => ({
    tauri: !!window.__TAURI_INTERNALS__,
    version: (document.body.textContent.match(/1\\.10\\.3/) || [])[0] ?? null,
  }))()`);
  check("app booted with real backend", !!boot?.tauri, JSON.stringify(boot));
  check("version 1.10.3 in UI", boot?.version === "1.10.3");

  // ---- cd the panel to the work dir, cursor onto the file ----
  await cdp.send("Input.insertText", { text: `cd ${work}` });
  await press(cdp, { key: "Enter", code: "Enter", keyCode: 13 });
  await sleep(900);
  await press(cdp, { key: "Home", code: "Home", keyCode: 36 });
  await sleep(150);
  await pressDown(cdp); // ".." -> sample.txt
  await sleep(150);
  const row = await evalIn(cdp, `document.querySelector(".panel.active .row.cursor")?.textContent?.replace(/\\s+/g, " ").trim() ?? ""`);
  check("cursor on a real entry (not '..')", row.length > 0 && !row.startsWith(".."), row.slice(0, 40));

  // ---- F5 opens the transfer dialog with the seeded variants ----
  await pressF5(cdp);
  await sleep(600);
  const m = await evalIn(cdp, `
    (() => {
      const box = document.querySelector(".variants");
      const inp = document.querySelector(".dlg-body input");
      if (!box || !inp) return { missing: true };
      const br = box.getBoundingClientRect();
      const rows = [...box.querySelectorAll(".li")].map(el => {
        const r = el.getBoundingClientRect();
        const span = el.querySelector(".path");
        return { top: Math.round(r.top), h: Math.round(r.height), textH: span ? Math.round(span.getBoundingClientRect().height) : -1 };
      });
      const dlg = document.querySelector(".dlg").getBoundingClientRect();
      const actions = document.querySelector(".dlg-actions").getBoundingClientRect();
      const longSpan = [...box.querySelectorAll(".li .path")].find(s => s.textContent.length > 60);
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
        inputAboveList: inp.getBoundingClientRect().bottom <= br.top + 1,
        longEll: longSpan ? getComputedStyle(longSpan).textOverflow + "/" + getComputedStyle(longSpan).whiteSpace : "none",
        fieldVal: inp.value,
      };
    })()
  `);
  check("dialog opened with variants", !m.missing && m.nRows >= 10, m.missing ? "no .variants" : `rows=${m.nRows}`);
  check("rows keep full height (>= text)", m.minHeight >= m.maxTextH, `min row ${m.minHeight}px vs text ${m.maxTextH}px`);
  check("rows do not overlap", m.rowsOverlap === false);
  check("list scrolls its overflow", m.listScrolls === true, `client ${m.listClientH} / scroll ${m.listScrollH}`);
  check("dialog inside viewport", m.dlgInside === true);
  check("actions bar inside dialog", m.actionsInsideDlg === true);
  check("input above the list", m.inputAboveList === true);
  check("long history path ellipsized", m.longEll === "ellipsis/nowrap", m.longEll);
  check("field prefilled with dest", typeof m.fieldVal === "string" && m.fieldVal.length > 0, JSON.stringify(m.fieldVal).slice(0, 60));

  // ---- deep arrow cycling scrolls the highlight into view ----
  for (let i = 0; i < 12; i++) { await pressDown(cdp); await sleep(60); }
  await sleep(300);
  const cyc = await evalIn(cdp, `
    (() => ({
      kbd: document.querySelector(".variants .li.kbd .path")?.textContent ?? null,
      scrollTop: Math.round(document.querySelector(".variants").scrollTop),
      field: document.querySelector(".dlg-body input").value,
    }))()
  `);
  check("deep cycling highlights the last variant", cyc.kbd === HIST[7], JSON.stringify(cyc.kbd));
  check("list scrolled the highlight into view", cyc.scrollTop > 0, "scrollTop=" + cyc.scrollTop);
  check("field holds the highlighted variant", cyc.field === HIST[7], JSON.stringify(cyc.field));

  // ---- Esc cancels: dialog closed, nothing copied ----
  await pressEsc(cdp);
  await sleep(400);
  const after = await evalIn(cdp, `(() => ({
    dlgGone: !document.querySelector(".overlay .dlg"),
    sampleStillThere: null,
  }))()`);
  check("Esc closes the dialog", after.dlgGone === true);
  const ops = await evalIn(cdp, `(() => !document.querySelector(".overlay"))()`);
  check("no operation started", ops === true);

  cdp.close();
} catch (e) {
  check("script ran", false, String(e));
} finally {
  try { if (child?.pid) child.kill(); } catch {}
  restoreCfg();
  setTimeout(() => {
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    try { rmSync(work, { recursive: true, force: true }); } catch {}
  }, 800);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
