// exe-level E2E for alnavi-026: in the REAL released exe the F1 help must be
// complete and restyled: every audited chord present (Alt+F5/F6 archives,
// Shift+F8 delete-current, Ctrl+F1/F2 one-panel toggle, Ctrl+Shift+0..9 pin,
// Alt+F12 dir history, F9/F10 app keys), 8 card sections in a 2-column
// masonry with icons, the footer modifier hint, no raw i18n keys leaking,
// Esc closing. The app's real config (%APPDATA%\al-navi) is backed up and
// restored.
// Usage: node scripts/e2e-alnavi-026-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const CFG = join(process.env.APPDATA, "al-navi");
const CDP_PORT = 9266;
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
const VK = { F1: 112, Escape: 27 };
async function key(cdp, k) {
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k] ?? 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(150);
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
async function clickAt(cdp, x, y) {
  const base = { x, y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  await sleep(300);
}

try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-026-exe-"));
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
  check("exe launches (CDP target up)", !!wsUrl);
  if (!wsUrl) throw new Error("no CDP target");
  const cdp = connect(wsUrl);
  await cdp.ready;
  await sleep(3500);
  await waitFor(cdp, `!!document.querySelector(".panel, .panels")`, 15000, "app UI");
  // document.title is the localized "Al-Navi — About…"; the version lives in
  // the custom title bar chip (vX.Y.Z · build time)
  const ver = await evalIn(cdp, `document.querySelector(".titlebar .version")?.textContent ?? ""`);
  check("title bar chip carries v1.14.6", ver.includes("1.14.6"), JSON.stringify(ver));
  // click the panel like a user so the window has the keyboard context (a
  // window spawned in the background may have missed the startup focus dance)
  const p = await evalIn(cdp, `(() => { const el = document.querySelector(".panel"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (p) await clickAt(cdp, p.x, p.y);

  // ---- F1 opens the restyled help ----
  await key(cdp, "F1");
  await waitFor(cdp, `!!document.querySelector(".dlg.help-dlg")`, 8000, "help dialog");
  const layout = await evalIn(cdp, `
    (() => {
      const body = document.querySelector(".help-body");
      return {
        sections: document.querySelectorAll(".help-section").length,
        rows: document.querySelectorAll(".help-dlg .hrow").length,
        columnCount: getComputedStyle(body).columnCount,
        icons: document.querySelectorAll(".help-grp i").length,
        footerKbds: [...document.querySelectorAll(".help-mods kbd")].map((k) => k.textContent),
        chords: [...document.querySelectorAll(".help-dlg .hrow kbd")].map((k) => k.textContent),
        bodyText: document.querySelector(".help-body").textContent,
      };
    })()
  `);
  check("8 card sections, 97 rows, 2-column masonry", layout.sections === 8 && layout.rows === 97 && layout.columnCount === "2",
    JSON.stringify({ s: layout.sections, r: layout.rows, c: layout.columnCount }));
  check("8 section icons", layout.icons === 8, `icons=${layout.icons}`);
  check("footer modifier hint (Ctrl/Alt/Shift chips)", layout.footerKbds.join(",") === "Ctrl,Alt,Shift", JSON.stringify(layout.footerKbds));
  const need = ["Alt+F5", "Alt+F6", "Shift+F8", "Ctrl+F1 / F2", "Ctrl+Shift+0…9", "Alt+F12", "F9", "F10", "Ctrl+Shift+F4"];
  const missing = need.filter((n) => !layout.chords.includes(n));
  check("all audited chords present in the release build", missing.length === 0, `missing=${JSON.stringify(missing)}`);
  check("no raw i18n keys leak into the help", !/(^|\\s)help\\.[a-zA-Z]/.test(layout.bodyText), "");
  await key(cdp, "Escape");
  const closed = await evalIn(cdp, `!document.querySelector(".dlg.help-dlg")`);
  check("Esc closes the help", closed === true);
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
