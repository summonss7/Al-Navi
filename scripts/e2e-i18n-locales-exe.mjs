// exe-level E2E for the uk/ro/sk/ar localization completion (alnavi-008):
// launches the REAL released exe with an isolated WebView2 profile + CDP,
// switches the language by real clicks on the F9 menu buttons, presses real
// keys (F9, Escape, Ctrl+M) and asserts the F9 "View" group, the file-colors
// dialog and the multi-rename dialog render the translated strings with no
// English fallback; ar asserts document.dir === "rtl". The app's real config
// (%APPDATA%\al-navi — settings.json holds the locale) is backed up/restored.
// Usage: node scripts/e2e-i18n-locales-exe.mjs [path-to-Al-Navi.exe]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const CFG = join(process.env.APPDATA, "al-navi");
const CDP_PORT = 9257;
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
  for (const p of backedUp) cpSync(p + ".e2e-bak", p, { recursive: true });
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
  const r = await Promise.race([
    cdp.send("Runtime.evaluate", { expression, returnByValue: true }),
    new Promise((res) => setTimeout(() => res(null), 8000)),
  ]);
  if (r === null) return "[eval-timeout]";
  if (r.result?.exceptionDetails) return "[threw]";
  return r.result?.result?.value;
}
async function key(cdp, k, code, modifiers = 0) {
  const base = { key: k, code: code ?? k, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0, modifiers };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
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

// per-locale expected literals (from dictionaries.ts)
const CASES = [
  { id: "uk", label: "Українська", view: "Вигляд", fc: "Маски: символи", mr: "Мультиперейменування", dir: "ltr" },
  { id: "ro", label: "Română", view: "Vizualizare", fc: "Măști: metacaracterele", mr: "Redenumire în masă", dir: "ltr" },
  { id: "sk", label: "Slovenčina", view: "Zobrazenie", fc: "Masky: zástupné znaky", mr: "Hromadné premenovanie", dir: "ltr" },
  { id: "ar", label: "العربية", view: "عرض", fc: "الأقنعة: الرمزان", mr: "إعادة تسمية متعددة", dir: "rtl" },
];

try {
  const profile = mkdtempSync(join(tmpdir(), "alnavi-i18n-exe-"));
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
  await sleep(2000);

  for (const C of CASES) {
    // F9 menu -> click the language button (real user path)
    await key(cdp, "F9", "F9");
    await waitFor(cdp, `!!document.querySelector(".lang-grid .btn.lang")`, 8000, `${C.id} lang grid`);
    const clicked = await evalIn(cdp, `
      (() => {
        const btn = [...document.querySelectorAll(".lang-grid .btn.lang")].find((b) => b.textContent.trim() === "${C.label}");
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    await sleep(500);
    const st = await evalIn(cdp, `({ lang: document.documentElement.lang, dir: document.documentElement.dir })`);
    check(`${C.id}: language switched`, clicked && st.lang === C.id, JSON.stringify(st));
    check(`${C.id}: document.dir is ${C.dir}`, st.dir === C.dir, st.dir);

    // the View group + its checkboxes render translated
    const view = await evalIn(cdp, `
      (() => {
        const grps = [...document.querySelectorAll(".dlg-body .grp")].map((g) => g.textContent.trim());
        const checks = [...document.querySelectorAll(".dlg-body .check span")].map((s) => s.textContent.trim());
        return { first: grps[0] ?? "", n: checks.length, sample: checks[0] ?? "" };
      })()
    `);
    check(`${C.id}: F9 View group is "${C.view}"`, view.first === C.view, view.first);
    check(`${C.id}: view checkboxes translated (5 rows)`, view.n === 5 && !/Folders on top|Show hidden|Show system|Marked files/.test(view.sample), view.sample);

    // file colors dialog from the F9 menu (real click on the palette row)
    await evalIn(cdp, `(() => { document.querySelector(".dlg-body .fc-open")?.click(); return true; })()`);
    await waitFor(cdp, `!!document.querySelector(".dlg-body .fc-hint")`, 8000, `${C.id} fc dialog`);
    const fc = await evalIn(cdp, `
      (() => ({
        hint: document.querySelector(".dlg-body .fc-hint")?.textContent.trim() ?? "",
        btns: [...document.querySelectorAll(".dlg-actions .btn")].map((b) => b.textContent.trim()),
      }))()
    `);
    check(`${C.id}: file-colors hint translated`, fc.hint.startsWith(C.fc) && !fc.hint.startsWith("Masks:"), fc.hint.slice(0, 50));
    check(`${C.id}: file-colors buttons translated`,
      fc.btns.length >= 2 && !fc.btns.some((b) => /^(Add rule|Reset|Close)$/.test(b.trim())), JSON.stringify(fc.btns));
    await key(cdp, "Escape", "Escape");
    await sleep(300);

    // Ctrl+M on the file under the cursor (no confirmation — nothing is renamed)
    await key(cdp, "m", "KeyM", 2);
    await waitFor(cdp, `!!document.querySelector(".dlg-title")`, 8000, `${C.id} mr dialog`);
    const mr = await evalIn(cdp, `
      (() => {
        const title = document.querySelector(".dlg-title")?.textContent.trim() ?? "";
        const body = document.querySelector(".dlg-body")?.textContent ?? "";
        return { title, raw: /\\{n\\}/.test(body) || /\\{n\\}/.test(title) };
      })()
    `);
    check(`${C.id}: Ctrl+M title starts "${C.mr}"`, mr.title.startsWith(C.mr) && !mr.title.startsWith("Multi-rename"), mr.title);
    check(`${C.id}: {n} interpolated (no raw placeholder)`, mr.raw === false, mr.title);
    await key(cdp, "Escape", "Escape");
    await sleep(300);
  }

  // regressions: ru and en render their own View label
  for (const [label, view] of [["Русский", "Вид"], ["English", "View"]]) {
    await key(cdp, "F9", "F9");
    await waitFor(cdp, `!!document.querySelector(".lang-grid .btn.lang")`, 8000, `${label} lang grid`);
    await evalIn(cdp, `(() => { [...document.querySelectorAll(".lang-grid .btn.lang")].find((b) => b.textContent.trim() === "${label}")?.click(); return true; })()`);
    await sleep(500);
    const first = await evalIn(cdp, `document.querySelector(".dlg-body .grp")?.textContent.trim() ?? ""`);
    check(`regression ${label}: View group is "${view}"`, first === view, first);
    await key(cdp, "Escape", "Escape");
    await sleep(300);
  }

  cdp.close();
  await spawn("taskkill", ["/IM", "Al-Navi.exe", "/F"], { stdio: "ignore" }).on("close", () => {});
  await sleep(1500);
  // best-effort: the dying WebView2 may hold locks a moment longer (EPERM)
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* temp dir, OS cleans it */ }
} finally {
  restoreCfg();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nALL ${results.length} PASS` : `\n${failed}/${results.length} FAILED`);
process.exit(failed === 0 ? 0 : 1);
