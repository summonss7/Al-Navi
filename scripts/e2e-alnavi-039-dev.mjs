// Dev E2E for alnavi-039: in-app update checks against the Aila update
// center (manifest v2). With a mocked Tauri backend it drives REAL keys and
// clicks through CDP:
//   - the F9 menu carries «Проверить обновления»; it opens the update dialog
//     and a "latest" answer renders the explicit «✓ You have the latest
//     version» line with the current version
//   - an "available" answer renders «Version X is available», the notes with
//     markdown stripped (## gone, - → •) and the download size; «Обновить»
//     invokes updater_download with the asset's url/sha256/size, live
//     progress events drive the progress bar, the session/window state is
//     persisted BEFORE updater_apply, and apply receives the temp path
//   - silent startup gating: a fresh lastCheck skips the check entirely, a
//     stale one re-checks; a silent "available" opens the dialog while a
//     silent network failure stays completely quiet
//   - a manual network failure shows the degraded error state with «Повторить»
// Usage: node scripts/e2e-alnavi-039-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9283;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-039-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LATEST = { status: "latest", current: "1.2.3", latest: "1.2.3", notes: null, publishedAt: "2026-10-22T12:00:00+03:00", asset: null, error: null };
const AVAILABLE = {
  status: "available",
  current: "1.2.3",
  latest: "99.0.0",
  notes: "## 99.0.0 (test)\n- первый пункт\n- второй пункт",
  publishedAt: "2026-10-22T12:00:00+03:00",
  asset: { name: "Al-Navi-99.0.0-fake.exe", url: "https://example.com/Al-Navi-99.0.0.exe", size: 10 * 1048576, sha256: "aa" + "0".repeat(62) },
  error: null,
};
const NETERR = { status: "network-error", current: "1.2.3", latest: null, notes: null, publishedAt: null, asset: null, error: "connect timeout" };

const alive = await fetch(`${ORIGIN}/`).then((r) => (r.ok ? true : null)).catch(() => null);
const vite = alive ? null : spawn("npm", ["run", "dev"], { shell: true, stdio: "ignore" });
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
  return {
    ready,
    send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); },
    close: () => ws.close(),
  };
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
  await waitFor(() => evalIn(cdp, `!!document.querySelector(".app-shell")`).catch(() => null), 30000, "app UI");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.send("Runtime.enable");
  await evalIn(cdp, `
    (async () => {
      const mk = (name, isDir, size, mtime) => ({ name, isDir, size, mtime, attrs: "", isSymlink: false, isHidden: false });
      const rows = [mk("notes.txt", false, 100, 1000)];
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      window.__cbs = {};
      window.__listeners = {};
      window.__e2e = { checkCalls: 0, downloadCalls: [], applyCalls: [], savedJsons: [], saveOrder: [] };
      window.__TAURI_INTERNALS__.transformCallback = (cb) => {
        const id = ++window.__e2eCbSeq;
        window.__cbs[id] = cb;
        return id;
      };
      // the fake manifest the check "returns", switchable per test
      window.__updCheck = ${JSON.stringify(LATEST)};
      window.__updStateFile = null; // update-state.json content, null = never checked
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen":
            window.__listeners[args.event] = args.handler;
            return Promise.resolve(args.handler);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": return Promise.resolve({ path: args.path, entries: rows, freeBytes: 0, totalBytes: 0 });
          case "home_path": return Promise.resolve("D:\\\\e2e");
          case "drives_list": return Promise.resolve([]);
          case "free_space": return Promise.resolve([0, 0]);
          case "load_json":
            if (args.name === "update-state.json") return Promise.resolve(window.__updStateFile);
            return Promise.resolve(null);
          case "save_json": {
            window.__e2e.savedJsons.push({ name: args.name, data: args.data });
            window.__e2e.saveOrder.push(args.name);
            if (args.name === "update-state.json") window.__updStateFile = args.data;
            return Promise.resolve();
          }
          case "app_info": return Promise.resolve({ version: "1.2.3", buildTime: "2026-10-22 23:00" });
          case "updater_check": {
            window.__e2e.checkCalls += 1;
            return new Promise((res) => setTimeout(() => res(window.__updCheck), 150));
          }
          case "updater_download": {
            window.__e2e.downloadCalls.push({ url: args.url, sha256: args.sha256, size: args.size });
            const emit = (downloaded, total) => {
              const id = window.__listeners["updater:progress"];
              if (id) window.__cbs[id]({ event: "updater:progress", id, payload: { downloaded, total } });
            };
            return new Promise((res) => {
              setTimeout(() => emit(5 * 1048576, 10 * 1048576), 120);
              setTimeout(() => { emit(10 * 1048576, 10 * 1048576); res("C:\\\\Temp\\\\alnavi-update-4242.exe"); }, 360);
            });
          }
          case "updater_apply": {
            window.__e2e.applyCalls.push(args.path);
            window.__e2e.applyAt = window.__e2e.saveOrder.length;
            return Promise.resolve();
          }
          default: return Promise.resolve(null);
        }
      };
      const imp = new Function("u", "return import(u)");
      const { panels } = await imp("${ORIGIN}/src/lib/stores/panels.svelte.ts");
      const { ui } = await imp("${ORIGIN}/src/lib/stores/ui.svelte.ts");
      // the update store must be the SAME module record the app graph uses:
      // after a file edit vite serves it with an HMR ?t= suffix, and a plain
      // URL import would create a second, disconnected instance (alnavi-035
      // lesson). Take the exact URL from the compiled App.svelte imports.
      const appSrc = await (await fetch("/src/App.svelte")).text();
      const updMatch = appSrc.match(/from "([^"]*update\\.svelte\\.ts[^"]*)"/);
      const { update } = await imp(updMatch ? updMatch[1] : "${ORIGIN}/src/lib/stores/update.svelte.ts");
      window.__e2e.p = panels;
      window.__e2e.ui = ui;
      window.__e2e.upd = update;
      await panels.init();
      return true;
    })()
  `);
  await waitFor(() => evalIn(cdp, `window.__e2e?.p?.left?.view?.length === 2 ? true : null`).catch(() => null), 15000, "left panel loaded");
  await sleep(400);
}

const dlgFacts = (cdp) => evalIn(cdp, `(() => {
  const u = window.__e2e.ui;
  if (u.dialog !== "update") return null;
  const q = (s) => document.querySelector(s);
  return {
    title: q(".dlg-title")?.textContent.trim() ?? "",
    row: q(".dlg-body .row")?.textContent.trim() ?? "",
    okRow: q(".row.ok")?.textContent.trim() ?? null,
    upRow: q(".row.up")?.textContent.trim() ?? null,
    ver: q(".dlg-body .ver")?.textContent.trim() ?? null,
    sz: q(".dlg-body .sz")?.textContent.trim() ?? null,
    notes: q(".notes")?.textContent.trim() ?? null,
    bar: q(".bar")?.textContent ?? null,
    fillWidth: q(".bar .fill")?.style.width ?? null,
    pct: q(".dlg-body .ver.mono:last-of-type")?.textContent.trim() ?? null,
    buttons: [...document.querySelectorAll(".dlg-actions .btn")].map((b) => b.textContent.trim()),
    status: window.__e2e.upd.status,
  };
})()`);
const clickMenuBtn = (cdp, label) => evalIn(cdp, `
  (() => {
    const b = [...document.querySelectorAll(".dlg-body .fc-open")].find((x) => x.textContent.trim().includes(${JSON.stringify(label)}));
    if (b) b.click();
    return !!b;
  })()
`);
const clickDlgBtn = (cdp, label) => evalIn(cdp, `
  (() => {
    const b = [...document.querySelectorAll(".dlg-actions .btn")].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (b) b.click();
    return !!b;
  })()
`);

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

  step("bootstrapping stores + backend mock");
  await bootstrap(cdp);

  step("F9 menu carries the updates section with «Check for updates»");
  await key(cdp, "F9", 120);
  await sleep(250);
  let clicked = await evalIn(cdp, `[...document.querySelectorAll(".dlg-body .grp")].some((g) => g.textContent.trim() === "Updates")`);
  check("F9 menu has the Updates group", clicked === true);

  step("menu button opens the dialog; latest answer renders the explicit line");
  clicked = await clickMenuBtn(cdp, "Check for updates");
  await waitFor(() => dlgFacts(cdp).then((f) => (f && f.okRow ? f : null)), 8000, "latest row");
  let f = await dlgFacts(cdp);
  check("menu button opened the update dialog", clicked === true && f !== null, f?.title);
  check("«✓ You have the latest version» shown", f.okRow === "✓ You have the latest version", f.okRow);
  check("current version shown", f.ver === "Current version: 1.2.3", f.ver);
  check("latest closes with a single Close button", f.buttons.join("|") === "Close", f.buttons.join("|"));
  await key(cdp, "Escape", 27);
  await sleep(150);
  check("Esc closes the dialog", await evalIn(cdp, `window.__e2e.ui.dialog`) === null);

  step("available: version + stripped notes + size + Update/Later");
  await evalIn(cdp, `window.__updCheck = ${JSON.stringify(AVAILABLE)}`);
  await evalIn(cdp, `window.__e2e.upd.check(true)`);
  await waitFor(() => dlgFacts(cdp).then((f) => (f && f.upRow ? f : null)), 8000, "available row");
  f = await dlgFacts(cdp);
  check("«Version 99.0.0 is available» shown", f.upRow === "Version 99.0.0 is available", f.upRow);
  check("notes rendered without markdown soup", f.notes !== null && f.notes.includes("• первый пункт") && !f.notes.includes("##") && !f.notes.includes("- первый"), f.notes);
  check("download size shown", f.sz !== null && f.sz.includes("10.0 MB"), f.sz);
  check("buttons: Update + Later", f.buttons.join("|") === "Update|Later", f.buttons.join("|"));

  step("«Обновить»: download args, progress bar, persistence before apply");
  // the app's startup init ran before the mock existed, so its progress
  // listener never registered — one fresh-lastCheck init hooks it without
  // firing an extra check
  await evalIn(cdp, `window.__updStateFile = { lastCheck: Date.now() }; window.__e2e.upd.init()`);
  await sleep(200);
  await clickDlgBtn(cdp, "Update");
  await waitFor(() => dlgFacts(cdp).then((d) => (d && d.status === "restarting" ? d : null)), 8000, "restarting");
  const dl = await evalIn(cdp, `window.__e2e.downloadCalls[0]`);
  check("updater_download called with url+sha256+size", dl && dl.url === AVAILABLE.asset.url && dl.sha256 === AVAILABLE.asset.sha256 && dl.size === 10 * 1048576, JSON.stringify(dl));
  const apply = await evalIn(cdp, `({ path: window.__e2e.applyCalls[0], saved: window.__e2e.savedJsons.map((s) => s.name), applyAt: window.__e2e.applyAt })`);
  check("updater_apply got the temp path", apply.path === "C:\\Temp\\alnavi-update-4242.exe", apply.path);
  // window.json is skipped in the dev harness (windowState is null in a plain
  // browser — no real Tauri window); the real-exe cycle covers it
  check("session persisted BEFORE apply", apply.saved.includes("session.json") && apply.applyAt === apply.saved.length, JSON.stringify(apply));
  check("lastCheck persisted in update-state.json", apply.saved.includes("update-state.json"), JSON.stringify(apply.saved));
  const barSeen = await evalIn(cdp, `window.__e2e.upd.total === 10485760 && window.__e2e.upd.downloaded === 10485760`);
  check("progress events reached the store (10 MB / 10 MB)", barSeen === true);
  await key(cdp, "Escape", 27);
  await sleep(120);

  step("silent gating: fresh lastCheck -> no check call");
  await evalIn(cdp, `window.__updStateFile = { lastCheck: Date.now() }; window.__updCheck = ${JSON.stringify(AVAILABLE)};`);
  const before = await evalIn(cdp, `window.__e2e.checkCalls`);
  await evalIn(cdp, `window.__e2e.upd.init()`);
  await sleep(500);
  check("no silent re-check within 24h", await evalIn(cdp, `window.__e2e.checkCalls`) === before);
  check("no dialog without a check", await evalIn(cdp, `window.__e2e.ui.dialog`) === null);

  step("silent gating: stale lastCheck -> check + banner dialog on available");
  await evalIn(cdp, `window.__updStateFile = { lastCheck: Date.now() - 25 * 3600 * 1000 };`);
  await evalIn(cdp, `window.__e2e.upd.init()`);
  await waitFor(() => dlgFacts(cdp).then((d) => (d && d.upRow ? d : null)), 8000, "auto dialog");
  f = await dlgFacts(cdp);
  check("stale check re-ran and auto-opened the dialog", f !== null && f.upRow === "Version 99.0.0 is available", f?.upRow ?? "no dialog");
  await key(cdp, "Escape", 27);
  await sleep(120);

  step("silent network failure stays completely quiet");
  await evalIn(cdp, `window.__updStateFile = { lastCheck: Date.now() - 25 * 3600 * 1000 }; window.__updCheck = ${JSON.stringify(NETERR)};`);
  await evalIn(cdp, `window.__e2e.upd.init()`);
  await sleep(600);
  const quiet = await evalIn(cdp, `({ dialog: window.__e2e.ui.dialog, status: window.__e2e.upd.status })`);
  check("silent failure: no dialog, status idle", quiet.dialog === null && quiet.status === "idle", JSON.stringify(quiet));

  step("manual network failure -> degraded error + Retry works");
  await evalIn(cdp, `window.__e2e.upd.check(true)`);
  await waitFor(() => dlgFacts(cdp).then((d) => (d && d.status === "error" ? d : null)), 8000, "error state");
  f = await dlgFacts(cdp);
  check("error state shows the unreachable-center line", f.row.includes("Could not check for updates"), f.row);
  check("error buttons: Retry + Close", f.buttons.join("|") === "Retry|Close", f.buttons.join("|"));
  await evalIn(cdp, `window.__updCheck = ${JSON.stringify(LATEST)}`);
  await clickDlgBtn(cdp, "Retry");
  await waitFor(() => dlgFacts(cdp).then((d) => (d && d.okRow ? d : null)), 8000, "latest after retry");
  f = await dlgFacts(cdp);
  check("Retry re-checks and lands on «latest version»", f.okRow === "✓ You have the latest version", f.okRow);
  await key(cdp, "Escape", 27);
  await sleep(120);
  check("dialog closed after retry flow", await evalIn(cdp, `window.__e2e.ui.dialog`) === null);
} catch (e) {
  check("script completed without harness errors", false, String(e));
} finally {
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  if (vite) vite.kill();
  try { edge.kill(); } catch { /* already gone */ }
  process.exit(fails ? 1 : 0);
}
