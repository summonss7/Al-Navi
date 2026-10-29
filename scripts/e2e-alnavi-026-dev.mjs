// Dev E2E for alnavi-026: complete + beautiful F1 help.
// The audit found keymap chords missing from the help dialog (Alt+F5/F6
// pack/unpack, Shift+F8 delete-current, Ctrl+F1/F2 one-panel toggle,
// Ctrl+Shift+0..9 pin shortcut, Alt+F12 dir history, F9/F10/F1 app keys).
// This script opens F1 with a real key event and verifies: the dialog
// renders every section as a card in a 2-column masonry with icons, the
// previously missing chords are present, no raw i18n keys leak into the
// UI, the footer modifier hint shows Ctrl/Alt/Shift chips, switching the
// locale to ru re-renders the new rows translated, and Esc closes.
// Usage: node scripts/e2e-alnavi-026-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9256;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-026-"));
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

const VK = { F1: 112, Escape: 27 };
async function key(cdp, k) {
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k] ?? 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  await sleep(120);
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
  // headless pages start without renderer focus; the flag must be set AFTER
  // the navigation (a new document resets it)
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  step("bootstrapping stores + backend mock");
  await evalIn(cdp, `
    (async () => {
      const rows = [];
      for (let i = 1; i <= 10; i++) {
        rows.push({ name: "file" + String(i).padStart(2, "0") + ".txt", isDir: false, size: 100 * i, mtime: 0, attrs: "", isSymlink: false, isHidden: false });
      }
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__e2eCbSeq = 0;
      window.__TAURI_INTERNALS__.transformCallback = () => ++window.__e2eCbSeq;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        switch (cmd) {
          case "plugin:event|listen": return Promise.resolve(++window.__e2eCbSeq);
          case "plugin:event|unlisten": return Promise.resolve();
          case "list_dir": return Promise.resolve({ path: args.path, entries: rows, freeBytes: 0, totalBytes: 0 });
          case "home_path": return Promise.resolve("D:\\\\e2e");
          case "drives_list": return Promise.resolve([
            { name: "Local (C:)", mountPoint: "C:\\\\", kind: "fixed", totalBytes: 500000000000, freeBytes: 100000000000 },
          ]);
          case "load_json": return Promise.resolve(null);
          case "save_json": return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          default: return Promise.resolve(null);
        }
      };
      const imp = new Function("u", "return import(u)");
      // full ".svelte.ts" URLs — a bare ".svelte" URL would create a SECOND
      // store instance and the assertions would read a disconnected copy
      const { panels } = await imp("${ORIGIN}/src/lib/stores/panels.svelte.ts");
      const { ui } = await imp("${ORIGIN}/src/lib/stores/ui.svelte.ts");
      const { settings } = await imp("${ORIGIN}/src/lib/stores/settings.svelte.ts");
      window.__e2e = { panels, ui, settings };
      await panels.init();
      return window.__e2e.panels.left.view.length;
    })()
  `);

  step("F1 opens the help dialog");
  await key(cdp, "F1");
  // HelpDialog loads as its own lazy chunk in dev — wait, don't poll once
  await waitFor(async () => await evalIn(cdp, `!!document.querySelector(".dlg.help-dlg")`), 10000, "help dialog");
  let dom = await evalIn(cdp, `!!document.querySelector(".dlg.help-dlg")`);
  check("help dialog is open", dom === true);

  step("structure: sections as cards in a 2-column masonry");
  const layout = await evalIn(cdp, `
    (() => {
      const body = document.querySelector(".help-body");
      const secs = [...document.querySelectorAll(".help-section")];
      const sec = secs[0];
      const cs = getComputedStyle(sec);
      const bodyCs = getComputedStyle(body);
      return {
        sections: secs.length,
        rows: document.querySelectorAll(".help-dlg .hrow").length,
        columnCount: bodyCs.columnCount,
        cardBg: cs.backgroundColor,
        cardRadius: cs.borderRadius,
        headerIcons: [...document.querySelectorAll(".help-grp i")].map((i) => i.className),
        hasFooter: !!document.querySelector(".help-mods"),
        footerKbds: [...document.querySelectorAll(".help-mods kbd")].map((k) => k.textContent),
        footerText: document.querySelector(".help-mods span")?.textContent ?? "",
      };
    })()
  `);
  check("8 sections render as cards", layout.sections === 8, `sections=${layout.sections}`);
  check("97 rows total (+font zoom, +SFTP key, +column sel, +encoding F8, +Ctrl+X history)", layout.rows === 97, `rows=${layout.rows}`);
  check("masonry: two balanced columns", layout.columnCount === "2", `columnCount=${layout.columnCount}`);
  check("cards have a background and rounded corners", layout.cardBg !== "rgba(0, 0, 0, 0)" && parseFloat(layout.cardRadius) > 0,
    `bg=${layout.cardBg} radius=${layout.cardRadius}`);
  check("every section header carries an icon", layout.headerIcons.length === 8 && layout.headerIcons.every((c) => /ph-duotone ph-/.test(c)),
    JSON.stringify(layout.headerIcons));
  check("footer modifier hint with Ctrl/Alt/Shift chips", layout.hasFooter && layout.footerKbds.join(",") === "Ctrl,Alt,Shift" && layout.footerText.length > 10,
    JSON.stringify({ kbd: layout.footerKbds, text: layout.footerText.slice(0, 40) }));

  step("the chords missing before this change are present");
  const chords = await evalIn(cdp, `[...document.querySelectorAll(".help-dlg .hrow kbd")].map((k) => k.textContent)`);
  const need = ["Alt+F5", "Alt+F6", "Shift+F8", "Ctrl+F1 / F2", "Ctrl+Shift+0…9", "Alt+F12", "F9", "F10", "Ctrl+Shift+F4", "Ctrl+Enter", "Shift+Del"];
  const missing = need.filter((n) => !chords.includes(n));
  check("all audited chords found in the dialog", missing.length === 0, `missing=${JSON.stringify(missing)}`);
  const appSec = await evalIn(cdp, `
    [...document.querySelectorAll(".help-section")].find((s) => s.querySelector(".help-grp")?.textContent.includes("Application"))?.textContent ?? ""
  `);
  check("app section holds F1/F9/F10", /This help/.test(appSec) && /Settings/.test(appSec) && /Quit/.test(appSec),
    appSec.slice(0, 80));

  step("no raw i18n keys leak into the rendered help");
  const leaks = await evalIn(cdp, `
    [...document.querySelectorAll(".help-dlg .hdesc, .help-dlg .help-grp, .help-mods span")]
      .map((n) => n.textContent).filter((t) => /^(help|fkeys)\\./.test(t))
  `);
  check("descriptions fully translated (en)", leaks.length === 0, JSON.stringify(leaks));

  step("switching the locale to ru re-renders the new rows");
  await evalIn(cdp, `window.__e2e.settings.set({ locale: "ru" })`);
  await sleep(300);
  const ruText = await evalIn(cdp, `document.querySelector(".help-body").textContent`);
  check("ru: pack row translated", ruText.includes("Упаковать в архив"), "");
  check("ru: app section title translated", ruText.includes("ПРОГРАММА") || ruText.toLowerCase().includes("программа"), "");
  check("ru: footer hint translated", (await evalIn(cdp, `document.querySelector(".help-mods span").textContent`)).includes("удерживайте") ||
    (await evalIn(cdp, `document.querySelector(".help-mods span").textContent`)).includes("Удерживайте"), "");
  const ruLeak = await evalIn(cdp, `
    [...document.querySelectorAll(".help-dlg .hdesc, .help-dlg .help-grp, .help-mods span")]
      .map((n) => n.textContent).filter((t) => /^(help|fkeys)\\./.test(t))
  `);
  check("ru: no raw i18n keys leak", ruLeak.length === 0, JSON.stringify(ruLeak));
  await evalIn(cdp, `window.__e2e.settings.set({ locale: "en" })`);

  step("Esc closes the help");
  await key(cdp, "Escape");
  const closed = await evalIn(cdp, `!document.querySelector(".dlg.help-dlg")`);
  check("help dialog closed by Esc", closed === true);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error("FAILED:", failed.map((f) => f.name).join("; "));
    process.exitCode = 1;
  }
} finally {
  edge.kill();
  if (ours) ours.kill();
}
