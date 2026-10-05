// Dev E2E for 1.11.0 (alnavi-018): jump keys for FTP. In the drive menu
// (Alt+F1/F2) the FTP entry now carries the assigned digit key "2" (shown as
// a chip) and pressing 2 — top row or numpad, any layout — opens the FTP
// list; drive letters still jump as before. In the FTP list every site may
// carry an assigned letter/digit (chip next to the name): pressing it
// connects right away, matched by PHYSICAL key so RU layout works (Ф = A).
// The site form normalizes the hotkey field as you type (Ф -> A, garbage
// dropped) and blocks duplicates with a toast. Loads the app from the vite
// dev server in headless Edge, drives the REAL ui/panels/ftpSites stores,
// dispatches real key events through CDP.
// Usage: node scripts/e2e-1-11-0-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9241;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-1110-"));
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

// real key press through CDP (the window listener is capture-phase and reads
// e.code first, so latin/cyrillic mapping follows the physical key)
async function key(cdp, k, code) {
  const base = { key: k, code: code ?? k, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

const driveRows = (cdp) => evalIn(cdp, `
  [...document.querySelectorAll(".dlg-body.drives .drive")].map((b) => ({
    name: b.querySelector(".d-name")?.textContent ?? "",
    key: b.querySelector(".jump-key")?.textContent ?? null,
  }))
`);
const ftpRows = (cdp) => evalIn(cdp, `
  [...document.querySelectorAll('.dlg-body.list .li')].map((b) => ({
    name: b.querySelector(".ftp-name")?.textContent ?? "",
    key: b.querySelector(".jump-key")?.textContent ?? null,
    kbd: b.classList.contains("kbd"),
  }))
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

  // bootstrap: mock the backend with a per-command switch, import the stores
  // through the exact URLs the app uses (the HMR-instance lesson)
  await evalIn(cdp, `
    (async () => {
      const imp = new Function("u", "return import(u)");
      const base = "${ORIGIN}/src/lib/";
      const src = await (await fetch(base + "register-commands.ts")).text();
      const u = (re) => new URL(src.match(re)[1], base).href;
      const { ui } = await imp(u(/from\\s+"([^"]*stores\\/ui\\.svelte\\.ts[^"]*)"/));
      const { panels } = await imp(base + "stores/panels.svelte.ts");
      const { ftpSites } = await imp(base + "stores/ftpSites.svelte.ts");
      window.__e2e = { ui, panels, ftpSites, log: [] };
      const listing = (p) => ({ path: p, entries: [
        { name: "pub", isDir: true, size: 0, mtime: 0, attrs: "", isSymlink: false, isHidden: false },
      ], freeBytes: 0, totalBytes: 0 });
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        window.__e2e.log.push([cmd, args]);
        switch (cmd) {
          case "drives_list": return Promise.resolve([
            { name: "Local (C:)", mountPoint: "C:\\\\", kind: "fixed", totalBytes: 500000000000, freeBytes: 100000000000 },
            { name: "Data (D:)", mountPoint: "D:\\\\", kind: "fixed", totalBytes: 2000000000000, freeBytes: 900000000000 },
          ]);
          case "list_dir": return Promise.resolve(listing(args.path));
          case "ftp_connect": return Promise.resolve("ftp://anonymous@" + args.host + ":" + (args.port || 21));
          case "ftp_list": return Promise.resolve(listing(args.path));
          case "load_json": return Promise.resolve(null);
          case "save_json": return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          default: return Promise.resolve(null);
        }
      };
      ui.closeDialog();
      ftpSites.sites = [
        { id: "e2e1", name: "Site One", host: "one.e2e.test", port: 21, user: "anonymous", password: "", hotkey: "1" },
        { id: "e2e2", name: "Site Two", host: "two.e2e.test", port: 21, user: "anonymous", password: "", hotkey: "A" },
        { id: "e2e3", name: "Old Site", host: "old.e2e.test", port: 21, user: "anonymous", password: "" },
      ];
      return true;
    })()
  `);
  await sleep(500);

  const openDrives = () => evalIn(cdp, `(() => { const { ui } = window.__e2e; ui.drivesFor = "left"; ui.openDialog("drives"); return ui.dialog; })()`);
  const openFtp = () => evalIn(cdp, `(() => { const { ui } = window.__e2e; ui.openDialog("ftp"); return ui.dialog; })()`);
  const lastConnect = () => evalIn(cdp, `(() => { const l = window.__e2e.log.filter(([c]) => c === "ftp_connect"); return l.length ? l[l.length - 1][1] : null; })()`);

  // A) drive menu renders C:/D: plus the FTP entry with the "2" chip
  // (waitFor: a cold vite may still be compiling the svelte modules)
  await openDrives();
  let rows = await waitFor(() => driveRows(cdp).then((r) => (r.length ? r : null)), 8000, "drives dialog rows");
  check("A: drives list C:/D:/FTP", rows.length === 3 && rows[0].name.includes("C:") && rows[1].name.includes("D:") && rows[2].name === "FTP",
    JSON.stringify(rows));
  check("A: FTP row shows jump-key chip 2", rows[2].key === "2" && rows[0].key === null, `ftp chip=${rows[2].key}`);

  // B) pressing 2 (top row) opens the FTP list
  await key(cdp, "2", "Digit2");
  await sleep(300);
  check("B: key 2 opens the FTP list", await evalIn(cdp, `window.__e2e.ui.dialog`) === "ftp", "");

  // C) FTP rows show per-site chips; the old site (no hotkey) has none
  rows = await ftpRows(cdp);
  check("C: site chips 1/A rendered, old site without hotkey has none",
    rows.length === 3 && rows[0].key === "1" && rows[1].key === "A" && rows[2].key === null,
    JSON.stringify(rows.map((r) => [r.name, r.key])));

  // D) pressing 1 connects that site for real: ftp_connect -> chdir -> close
  await key(cdp, "1", "Digit1");
  await sleep(600);
  const conn = await lastConnect();
  check("D: key 1 connects Site One", conn && conn.host === "one.e2e.test", JSON.stringify(conn));
  check("D: dialog closed, left panel on the ftp root",
    await evalIn(cdp, `window.__e2e.ui.dialog === null && window.__e2e.panels.left.path`) === "ftp://anonymous@one.e2e.test:21",
    await evalIn(cdp, `window.__e2e.panels.left.path`));

  // E) physical-key matching: Cyrillic Ф (code KeyA) hits hotkey A
  await openDrives(); await sleep(300);
  await key(cdp, "2", "Digit2"); await sleep(300);
  await key(cdp, "Ф", "KeyA");
  await sleep(600);
  const conn2 = await lastConnect();
  check("E: Ф (KeyA) connects Site Two via hotkey A", conn2 && conn2.host === "two.e2e.test", JSON.stringify(conn2));

  // F) numpad 2 opens the FTP list from the drive menu too
  await openDrives(); await sleep(300);
  await key(cdp, "2", "Numpad2"); await sleep(300);
  check("F: numpad 2 opens the FTP list", await evalIn(cdp, `window.__e2e.ui.dialog`) === "ftp", "");

  // G) an unassigned digit in the FTP list does nothing
  await key(cdp, "9", "Digit9"); await sleep(250);
  check("G: unassigned 9 leaves the FTP list open", await evalIn(cdp, `window.__e2e.ui.dialog`) === "ftp", "");

  // H) arrows still walk the FTP list (kbd cursor on row 2 after one Down)
  await key(cdp, "ArrowDown", "ArrowDown"); await sleep(250);
  rows = await ftpRows(cdp);
  check("H: ArrowDown moves the kbd cursor", rows.findIndex((r) => r.kbd) === 1, `idx=${rows.findIndex((r) => r.kbd)}`);

  // I) site form: duplicate hotkey blocked with a toast, dialog stays open
  await evalIn(cdp, `(() => { [...document.querySelectorAll(".dlg-actions .btn")].find((b) => b.textContent.includes("Add")).click(); return true; })()`);
  await sleep(300);
  check("I: Add opens the site form", await evalIn(cdp, `window.__e2e.ui.dialog`) === "ftpSite", "");
  await evalIn(cdp, `
    (() => {
      const set = (id, v) => {
        const el = document.getElementById(id);
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set("ftp-f-host", "new.e2e.test");
      set("ftp-f-key", "A");
      return document.getElementById("ftp-f-key").value;
    })()
  `).then((v) => check("I: hotkey field holds A", v === "A", `val=${v}`));
  await evalIn(cdp, `(() => { document.querySelector(".dlg-actions .btn.primary").click(); return true; })()`);
  await sleep(400);
  const toast = await evalIn(cdp, `window.__e2e.ui.toast?.text ?? ""`);
  check("I: duplicate hotkey rejected with a toast", /already used|занята/.test(toast), toast);
  check("I: form still open after rejection", await evalIn(cdp, `window.__e2e.ui.dialog`) === "ftpSite", "");
  check("I: site not saved", await evalIn(cdp, `!window.__e2e.ftpSites.sites.some((s) => s.host === "new.e2e.test")`) === true, "");

  // J) Cyrillic input normalizes to the Latin key (И lives on the B key)
  await evalIn(cdp, `
    (() => {
      const el = document.getElementById("ftp-f-key");
      el.value = "И";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el.value;
    })()
  `).then((v) => check("J: typing И normalizes to B", v === "B", `val=${v}`));
  // J2) garbage chars are dropped outright
  await evalIn(cdp, `
    (() => {
      const el = document.getElementById("ftp-f-key");
      el.value = "!";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el.value;
    })()
  `).then((v) => check("J: garbage char ! dropped", v === "", `val=${v}`));
  await evalIn(cdp, `
    (() => {
      const el = document.getElementById("ftp-f-key");
      el.value = "b";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el.value;
    })()
  `).then((v) => check("J: lowercase b uppercases to B", v === "B", `val=${v}`));

  // K) save & connect with hotkey B: site persists with the hotkey, connects
  await evalIn(cdp, `document.querySelector(".dlg-actions .btn.primary").click(); true`);
  await sleep(500);
  const conn3 = await lastConnect();
  const saved = await evalIn(cdp, `
    (() => {
      const s = window.__e2e.ftpSites.sites.find((x) => x.host === "new.e2e.test");
      // read through the $state proxy into a plain object (CDP can't clone proxies)
      return s ? { host: s.host, hotkey: s.hotkey ?? null } : null;
    })()
  `);
  check("K: saved with hotkey B and connected", conn3 && conn3.host === "new.e2e.test" && saved && saved.hotkey === "B",
    JSON.stringify(saved));
  check("K: dialog closed after connect", await evalIn(cdp, `window.__e2e.ui.dialog`) === null, "");

  // L) the new chip is live in the list; pressing B connects the new site
  await openFtp(); await sleep(300);
  rows = await ftpRows(cdp);
  check("L: new site shows chip B in the list", rows.some((r) => r.name === "new.e2e.test" && r.key === "B"),
    JSON.stringify(rows.map((r) => [r.name, r.key])));
  await key(cdp, "b", "KeyB"); await sleep(600);
  const conn4 = await lastConnect();
  check("L: key B connects the new site", conn4 && conn4.host === "new.e2e.test", JSON.stringify(conn4));

  // M) quick connect has no hotkey field
  await openFtp(); await sleep(300);
  await evalIn(cdp, `(() => { [...document.querySelectorAll(".dlg-actions .btn")].find((b) => b.textContent.includes("Quick")).click(); return true; })()`);
  await sleep(300);
  check("M: quick connect form has no hotkey field", await evalIn(cdp, `document.getElementById("ftp-f-key") === null`) === true, "");

  // N) regression: drive letters still jump — C: selects the C drive
  await openDrives(); await sleep(400);
  await key(cdp, "c", "KeyC"); await sleep(600);
  check("N: letter C still switches the panel to C:\\",
    await evalIn(cdp, `window.__e2e.ui.dialog === null && window.__e2e.panels.left.path`) === "C:\\",
    await evalIn(cdp, `window.__e2e.panels.left.path`));

  // O) cleanup: Esc path intact
  await openFtp(); await sleep(200);
  await key(cdp, "Escape", "Escape"); await sleep(250);
  check("O: Esc closes the FTP list", await evalIn(cdp, `window.__e2e.ui.dialog`) === null, "");
} catch (e) {
  check("script crashed", false, String(e));
} finally {
  edge.kill();
  if (ours) ours.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
