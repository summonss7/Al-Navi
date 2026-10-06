// E2E alnavi-029 (release exe): Phosphor fonts after the woff2-only build.
// The dist no longer ships woff/ttf/svg fallbacks of Phosphor (and the woff
// twins of JetBrains Mono) — WebView2 only ever fetched woff2, so icons of
// BOTH weights (regular titlebar/panels + duotone help sections) must render
// from the single remaining woff2. Checks here:
//   1. exe boots with the pinned version
//   2. document.fonts has both Phosphor families loaded (font really usable)
//   3. the woff2 assets were actually served (performance resource entries)
//   4. nothing ever requests the removed woff/ttf/svg formats
//   5. no font/CSP errors in the console
//   6. screenshots of the titlebar/panels, a dialog and the F1 help (duotone
//      section icons) land in backups/ for visual review
// Usage: node scripts/e2e-alnavi-029-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.12.12";
const CDP_PORT = 9263;
const CFG = join(process.env.APPDATA, "al-navi");
const SHOTS = join(process.cwd(), "backups");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// the app writes settings/window state into the real config dir — back it up
const backedUp = [];
for (const f of readdirSync(CFG)) {
  if (f.endsWith(".e2e-bak")) continue;
  const p = join(CFG, f);
  cpSync(p, p + ".e2e-bak", { recursive: true });
  backedUp.push(p);
}
function restoreCfg() {
  // best-effort: the dying WebView2 holds EPERM locks on its profile a moment
  for (let i = 0; i < 3; i++) {
    try {
      for (const p of backedUp) cpSync(p + ".e2e-bak", p, { recursive: true });
      return;
    } catch { sleep(700); }
  }
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg.params ?? msg);
  };
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  return {
    ready, events,
    send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); },
    close: () => ws.close(),
  };
}
async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
const waitFor = async (cdp, expr, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await evalIn(cdp, expr);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
};

const VK = { Escape: 27, F1: 112 };
async function key(cdp, k, alt = false) {
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k] ?? 0, modifiers: alt ? 1 : 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown", ...(alt ? { text: "" } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(250);
}

async function shot(cdp, file) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, file), Buffer.from(r.result.data, "base64"));
  return join(SHOTS, file);
}

// ---- script body
try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-029-"));
  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
    stdio: "ignore",
  });
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => ({ json: async () => [] }))).json();
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    if (wsUrl) break;
    await sleep(500);
  }
  check("1. exe launches (CDP target up)", !!wsUrl);
  if (!wsUrl) throw new Error("no CDP target");
  const cdp = connect(wsUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  await sleep(3500);
  await waitFor(cdp, `!!document.querySelector(".panel, .panels")`, 15000, "app UI");

  // ---- version pin
  const version = (await evalIn(cdp, `(document.querySelector(".version")?.textContent ?? "").trim()`));
  check(`2. title bar pins v${VERSION_PIN}`, version.includes(VERSION_PIN), version || "(none)");

  // ---- fonts really usable in the DOM: both Phosphor families load on demand
  const fonts = await evalIn(cdp, `(() => {
    const fam = (n) => [...document.fonts].filter(f => f.family.replace(/['"]/g, "") === n);
    return Promise.all([
      document.fonts.load('16px "Phosphor"', "ph-x"),
      document.fonts.load('16px "Phosphor-Duotone"', "ph-x"),
    ]).then(([reg, duo]) => ({
      regularLoaded: fam("Phosphor").filter(f => f.status === "loaded").length,
      duotoneLoaded: fam("Phosphor-Duotone").filter(f => f.status === "loaded").length,
      loadCalls: [reg.length, duo.length],
      status: document.fonts.status,
    }));
  })()`);
  check("3. Phosphor regular face loaded", fonts?.regularLoaded >= 1, `faces=${fonts?.regularLoaded}, load()=${fonts?.loadCalls?.[0]}`);
  check("4. Phosphor-Duotone face loaded", fonts?.duotoneLoaded >= 1, `faces=${fonts?.duotoneLoaded}, load()=${fonts?.loadCalls?.[1]}`);

  // ---- woff2 assets actually served, removed formats never requested
  const res = await evalIn(cdp, `performance.getEntriesByType("resource")
    .filter(r => /\\.(woff2?|ttf|svg)($|\\?)/i.test(r.name))
    .map(r => ({ file: r.name.split("/").pop(), status: r.responseStatus, size: r.transferSize }))`);
  const phos = (res ?? []).filter(r => /^Phosphor/i.test(r.file));
  const servedOk = phos.length >= 2 && phos.every(r => (r.status === undefined ? r.size > 0 : r.status === 200));
  check("5. both Phosphor woff2 served (perf entries, 200/bytes)", servedOk, JSON.stringify(phos));
  const legacy = (res ?? []).filter(r => /\\.(woff|ttf|svg)$/i.test(r.file));
  check("6. no woff/ttf/svg font requests at all", legacy.length === 0, legacy.map(r => r.file).join(",") || "none");

  // ---- screenshots: titlebar/panels (regular icons), a dialog, F1 (duotone)
  mkdirSync(SHOTS, { recursive: true });
  await shot(cdp, `e2e-029-panels-v${VERSION_PIN}.png`);
  check("7. titlebar/panels screenshot saved", existsSync(join(SHOTS, `e2e-029-panels-v${VERSION_PIN}.png`)), `backups/e2e-029-panels-v${VERSION_PIN}.png`);

  await key(cdp, "F1", true); // Alt+F1 = drives dialog (duotone icons in dialog headers)
  await waitFor(cdp, `!!document.querySelector(".overlay .dlg")`, 8000, "drives dialog");
  await shot(cdp, `e2e-029-dialog-v${VERSION_PIN}.png`);
  check("8. Alt+F1 dialog screenshot saved", existsSync(join(SHOTS, `e2e-029-dialog-v${VERSION_PIN}.png`)), `backups/e2e-029-dialog-v${VERSION_PIN}.png`);
  await key(cdp, "Escape");

  await key(cdp, "F1"); // help: duotone section icons
  await waitFor(cdp, `!!document.querySelector(".overlay .dlg .ph-duotone")`, 8000, "help dialog with duotone icons");
  const duoIcons = await evalIn(cdp, `document.querySelectorAll(".overlay .dlg [class*='ph-duotone']").length`);
  check("9. F1 help renders duotone section icons", duoIcons >= 8, `${duoIcons} duotone icon nodes`);
  await shot(cdp, `e2e-029-help-v${VERSION_PIN}.png`);
  check("10. F1 help screenshot saved", existsSync(join(SHOTS, `e2e-029-help-v${VERSION_PIN}.png`)), `backups/e2e-029-help-v${VERSION_PIN}.png`);
  await key(cdp, "Escape");

  // ---- console / browser log clean of font & CSP trouble
  await sleep(500);
  const bad = cdp.events
    .map((e) => [e.args?.map?.((a) => a.value ?? a.description ?? "").join(" "), e.text].filter(Boolean).join(" "))
    .filter((s) => /font|csp|refused|failed to (load|fetch)|denied/i.test(s))
    .filter((s) => !/favicon/i.test(s));
  check("11. no font/CSP errors in console or browser log", bad.length === 0, bad.slice(0, 2).join(" | ") || "clean");

  cdp.close();
  child.kill();
} catch (e) {
  check("script crashed", false, String(e));
} finally {
  const fails = results.filter((x) => !x.ok).length;
  console.log(`\n${fails ? fails + " FAILED" : "ALL " + results.length + " PASSED"}`);
  try { spawn("taskkill", ["/IM", "Al-Navi.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1200);
  restoreCfg();
  process.exit(fails ? 1 : 0);
}
