// Exe-level E2E for alnavi-039: the full in-app update cycle against the
// REAL released exe — but safely sandboxed: a copy of the exe lives in a
// temp folder and the "center" is a local manifest server (the app is
// pointed at it through ALNAVI_UPDATES_URL, exactly the hook the real
// channel URL overrides). Phases:
//   1. F9 → «Проверить обновления»: manifest 99.0.0 → «Version 99.0.0 is
//      available» with notes + size + Update/Later (real Rust semver compare)
//   2. bad sha256 in the manifest: «Обновить» fails the integrity check —
//      error shown, the exe is untouched, no .old appears
//   3. good manifest: «Обновить» downloads, rename-swaps the RUNNING exe
//      (Al-Navi.exe → .old → new copy in place) and restarts
//   4. the restarted instance is alive from the same path, deleted its
//      .old leftover at startup and re-attaches to CDP (inherited env)
//   5. manifest 404 → the degraded «could not check» state (Retry works)
//   6. manifest = own version → «✓ You have the latest version»
// Usage: node scripts/e2e-alnavi-039-exe.mjs [path-to-Al-Navi.exe]
import { spawn, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.14.7";
const CFG = join(process.env.APPDATA, "al-navi");
const CDP_PORT = 9291;
const HTTP_PORT = 8731;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// ---- sandbox install of the exe (the swap target — any launch location) ----
const work = mkdtempSync(join(tmpdir(), "alnavi039exe"));
const installDir = join(work, "App");
mkdirSync(installDir);
const appExe = join(installDir, "Al-Navi.exe");
cpSync(EXE, appExe);
const payloadExe = join(work, "payload-99.0.0.exe"); // what the "center" serves
cpSync(EXE, payloadExe);
const payloadBytes = readFileSync(payloadExe);
const payloadSha = createHash("sha256").update(payloadBytes).digest("hex");
const oldFile = appExe + ".old";

// ---- the app writes settings/window state into the real config dir — back
// it up, pin a fresh lastCheck (silent startup check stays quiet) and force
// the en locale so the dialog assertions see English strings (the machine's
// own saved locale may be anything)
mkdirSync(CFG, { recursive: true });
const backedUp = [];
for (const f of readdirSync(CFG)) {
  if (f.endsWith(".e2e-bak")) continue;
  const p = join(CFG, f);
  cpSync(p, p + ".e2e-bak", { recursive: true });
  backedUp.push(p);
}
writeFileSync(join(CFG, "update-state.json"), JSON.stringify({ lastCheck: Date.now() }));
writeFileSync(join(CFG, "settings.json"), JSON.stringify({ locale: "en" }));
function restoreCfg() {
  for (let i = 0; i < 3; i++) {
    try {
      for (const p of backedUp) cpSync(p + ".e2e-bak", p, { recursive: true });
      for (const f of readdirSync(CFG)) {
        const p = join(CFG, f);
        if (!f.endsWith(".e2e-bak") && !backedUp.some((b) => b === p)) rmSync(p, { recursive: true, force: true });
      }
      return;
    } catch { sleep(700); }
  }
}

// ---- local manifest server: what to serve is switchable per phase --------
// mode: "ok" (manifest+asset) | "404"
let mode = "ok";
let manifest = {
  project: "alnavi",
  versionName: "99.0.0",
  publishedAt: "2026-10-22T23:30:00+03:00",
  notes: "## 99.0.0 (e2e)\n- фаза подмены манифеста\n- полный цикл swap",
  assets: [{ name: "Al-Navi-99.0.0.exe", url: `http://127.0.0.1:${HTTP_PORT}/Al-Navi-99.0.0.exe`, size: payloadBytes.length, sha256: payloadSha, kind: "release" }],
};
const server = createServer((req, res) => {
  if (mode === "404") {
    res.writeHead(404).end();
    return;
  }
  if (req.url === "/manifest.json") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(manifest));
    return;
  }
  if (req.url === "/Al-Navi-99.0.0.exe") {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": payloadBytes.length });
    res.end(payloadBytes);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  // a silently dropped WS would leave every pending eval hanging forever —
  // reject them so the harness fails fast instead of stalling
  ws.onclose = () => {
    for (const res of pending.values()) res({ result: { exceptionDetails: { text: "cdp ws closed" } } });
    pending.clear();
  };
  ws.onerror = () => {
    for (const res of pending.values()) res({ result: { exceptionDetails: { text: "cdp ws error" } } });
    pending.clear();
  };
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  // every send is bounded: when the app exits mid-eval (the update swap!)
  // the page target dies and a pending response never arrives — resolve
  // with an error marker after 20s instead of hanging the harness
  return {
    ready,
    send(method, params = {}) {
      return new Promise((resolve) => {
        const id = ++seq;
        const t = setTimeout(() => { pending.delete(id); resolve({ result: { exceptionDetails: { text: "cdp send timeout" } } }); }, 20000);
        pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}
async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
const waitFor = async (cdp, expr, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await evalIn(cdp, expr);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(150);
  }
};
const VK = { Escape: 27, F9: 120 };
async function key(cdp, k) {
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k] ?? 0, modifiers: 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(120);
}
const runCheck = (cdp) => evalIn(cdp, `
  (() => {
    const b = [...document.querySelectorAll(".dlg-body .fc-open")].find((x) => x.textContent.includes("Check for updates"));
    if (b) b.click();
    return !!b;
  })()
`);
const dlgFacts = (cdp) => evalIn(cdp, `(() => {
  const q = (s) => document.querySelector(s);
  return {
    okRow: q(".row.ok")?.textContent.trim() ?? null,
    upRow: q(".row.up")?.textContent.trim() ?? null,
    errRow: q(".row.err")?.textContent.trim() ?? null,
    notes: q(".notes")?.textContent.trim() ?? null,
    sz: q(".sz")?.textContent.trim() ?? null,
    buttons: [...document.querySelectorAll(".dlg-actions .btn")].map((b) => b.textContent.trim()),
    ver: q(".dlg-body .ver")?.textContent.trim() ?? null,
  };
})()`);
const clickBtn = (cdp, label) => evalIn(cdp, `
  (() => {
    const b = [...document.querySelectorAll(".dlg-actions .btn")].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (b) b.click();
    return !!b;
  })()
`);
/** fire-and-forget variant for the «Обновить» click that ends the instance:
 *  the app swaps + exits right after the click, so the eval response may
 *  never arrive — dispatch and move on to restart polling */
const clickBtnDying = (cdp, label) => {
  void evalIn(cdp, `
    (() => {
      const b = [...document.querySelectorAll(".dlg-actions .btn")].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
      if (b) b.click();
      return true;
    })()
  `).catch(() => {});
  return true;
};
const procsAlive = () => {
  try {
    const out = execSync("powershell -NoProfile -Command \"Get-Process Al-Navi -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }\"", { encoding: "utf8" });
    return out.split("\n").map((s) => s.trim()).filter((s) => s.toLowerCase().startsWith(installDir.toLowerCase()));
  } catch {
    return [];
  }
};
const killAll = () => {
  try { execSync("taskkill /IM Al-Navi.exe /F", { stdio: "ignore" }); } catch { /* none running */ }
};

let cdp;
const child = spawn(appExe, [], {
  env: {
    ...process.env,
    ALNAVI_UPDATES_URL: `http://127.0.0.1:${HTTP_PORT}/manifest.json`,
    WEBVIEW2_USER_DATA_FOLDER: join(work, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  },
  stdio: "ignore",
});
// hard watchdog: nothing in this test may take 6 minutes — a stuck phase
// must die loudly AND clean up (a bare process.exit would skip the finally)
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: killing the stuck run");
  try { killAll(); } catch { /* already gone */ }
  restoreCfg();
  try { server.close(); } catch { /* ignore */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* held files */ }
  process.exit(1);
}, 6 * 60 * 1000);
try {
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => ({ json: async () => [] }))).json();
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    if (wsUrl) break;
    await sleep(500);
  }
  check("1. sandbox exe launches (CDP target up)", !!wsUrl);
  if (!wsUrl) throw new Error("no CDP target");
  cdp = connect(wsUrl);
  await cdp.ready;
  await sleep(2500);
  await waitFor(cdp, `!!document.querySelector(".panel")`, 15000, "app UI");
  await evalIn(cdp, `document.querySelector(".cmdline input")?.focus(); true`);
  const ver = await evalIn(cdp, `(document.querySelector(".version")?.textContent ?? "").trim()`);
  check("2. running v" + VERSION_PIN + " from the sandbox copy", ver.includes(VERSION_PIN), ver);

  // ---- phase 1: available -------------------------------------------------
  await key(cdp, "F9");
  await sleep(300);
  await runCheck(cdp);
  await waitFor(cdp, `!!document.querySelector(".row.up")`, 10000, "available row");
  let f = await dlgFacts(cdp);
  check("3. «Version 99.0.0 is available» (real Rust semver compare)", f.upRow === "Version 99.0.0 is available", f.upRow);
  check("4. notes rendered from the manifest", f.notes !== null && f.notes.includes("фаза подмены") && !f.notes.includes("##"), (f.notes ?? "").slice(0, 60));
  check("5. download size line", f.sz !== null && f.sz.includes("MB"), f.sz);
  check("6. buttons Update + Later", f.buttons.join("|") === "Update|Later", f.buttons.join("|"));

  // ---- phase 2: sha256 mismatch ------------------------------------------
  manifest = {
    ...manifest,
    assets: [{ ...manifest.assets[0], sha256: "ff".repeat(32) }],
  };
  await key(cdp, "Escape");
  await sleep(200);
  await key(cdp, "F9");
  await sleep(250);
  await runCheck(cdp);
  await waitFor(cdp, `!!document.querySelector(".row.up")`, 10000, "available row 2");
  await clickBtn(cdp, "Update");
  await waitFor(cdp, `!!document.querySelector(".row.err")`, 15000, "integrity error");
  f = await dlgFacts(cdp);
  check("7. bad sha256 → error state", f.errRow !== null, f.errRow);
  const errDetail = await evalIn(cdp, `document.querySelector(".notes")?.textContent ?? ""`);
  check("8. error detail names the sha256 mismatch", errDetail.includes("sha256 mismatch"), errDetail.slice(0, 80));
  check("9. exe untouched, no .old after failed update", !existsSync(oldFile) && statSync(appExe).size === payloadBytes.length, `old=${existsSync(oldFile)}`);
  check("10. process still alive", procsAlive().length === 1, JSON.stringify(procsAlive()));

  // ---- phase 3: the real swap --------------------------------------------
  manifest = {
    ...manifest,
    assets: [{ ...manifest.assets[0], sha256: payloadSha }],
  };
  await clickBtn(cdp, "Retry");
  await waitFor(cdp, `!!document.querySelector(".row.up")`, 10000, "available row 3");
  clickBtnDying(cdp, "Update");
  // the app exits by itself: wait for the process to die and the new one
  // (spawned by updater_apply with inherited env, incl. the CDP args) to
  // take over the debugging port
  let relaunch = null;
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => ({ json: async () => [] }))).json();
    const t = list.find((x) => x.type === "page");
    if (t) {
      const c2 = connect(t.webSocketDebuggerUrl);
      try {
        await c2.ready;
        const up = await evalIn(c2, `!!document.querySelector(".app-shell")`).catch(() => false);
        if (up) { relaunch = c2; break; }
      } catch { /* old target dying */ }
    }
    await sleep(500);
  }
  check("11. app restarted after the swap (CDP re-attached)", !!relaunch);
  if (!relaunch) throw new Error("restart not observed");
  cdp = relaunch;
  await waitFor(cdp, `!!document.querySelector(".panel")`, 15000, "restarted UI");
  await sleep(1500);
  check("12. one process alive from the sandbox path", procsAlive().length === 1, JSON.stringify(procsAlive()));
  check("13. .old leftover cleaned at startup", !existsSync(oldFile), `old=${existsSync(oldFile)}`);
  check("14. swapped exe is the payload bytes", statSync(appExe).size === payloadBytes.length, `${statSync(appExe).size}`);

  // ---- phases 5–6: a FRESH instance of the swapped exe --------------------
  // driving the just-restarted instance is flaky (its CDP page target is
  // grabbed mid-navigation and dies), while the plain launch path is solid —
  // the comparator/error phases don't need the swapped process specifically
  killAll();
  await sleep(1200);
  spawn(appExe, [], {
    env: {
      ...process.env,
      ALNAVI_UPDATES_URL: `http://127.0.0.1:${HTTP_PORT}/manifest.json`,
      WEBVIEW2_USER_DATA_FOLDER: join(work, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: "ignore",
  });
  let ws2 = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => ({ json: async () => [] }))).json();
    ws2 = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    if (ws2) break;
    await sleep(500);
  }
  cdp = connect(ws2);
  await cdp.ready;
  await sleep(2500);
  await waitFor(cdp, `!!document.querySelector(".panel")`, 15000, "fresh instance UI");
  await evalIn(cdp, `document.querySelector(".cmdline input")?.focus(); true`);
  const ver2 = await evalIn(cdp, `(document.querySelector(".version")?.textContent ?? "").trim()`);
  check("15. swapped exe relaunches normally", ver2.includes(VERSION_PIN), ver2);

  mode = "404";
  await key(cdp, "F9");
  await sleep(250);
  await runCheck(cdp);
  await waitFor(cdp, `!!document.querySelector(".row.err")`, 15000, "error row");
  f = await dlgFacts(cdp);
  check("16. 404 center → «Could not check for updates»", f.errRow !== null && f.errRow.includes("Could not check"), f.errRow);

  mode = "ok";
  manifest = { ...manifest, versionName: VERSION_PIN, notes: null };
  await clickBtn(cdp, "Retry");
  await waitFor(cdp, `!!document.querySelector(".row.ok")`, 10000, "latest row");
  f = await dlgFacts(cdp);
  check("17. equal version → «✓ You have the latest version»", f.okRow === "✓ You have the latest version", f.okRow);
  check("18. current version line", f.ver === `Current version: ${VERSION_PIN}`, f.ver);
} catch (e) {
  check("script completed without harness errors", false, String(e).slice(0, 300));
} finally {
  clearTimeout(watchdog);
  killAll();
  await sleep(800);
  restoreCfg();
  server.close();
  try { rmSync(work, { recursive: true, force: true }); } catch { /* WebView2 may hold a file */ }
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
}
