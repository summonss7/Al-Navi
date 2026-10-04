// Dev E2E for the uk/ro/sk/ar localization completion (alnavi-008, shipped in
// the 1.12.x line): loads the app from the vite dev server in headless Edge,
// switches the language through the REAL F9 menu buttons (settings.set ->
// i18n.setLocale), then checks the F9 "View" group, the file-colors dialog and
// the Ctrl+M multi-rename dialog render the translated strings with no English
// fallback; Arabic additionally asserts document.dir === "rtl". Placeholder
// interpolation is asserted via mr.nItems ({n} must not leak).
// Usage: node scripts/e2e-i18n-locales-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9243;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-i18n-"));
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
async function key(cdp, k, code) {
  const base = { key: k, code: code ?? k, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0 };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

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

  // bootstrap: mock the backend, import the stores + dictionaries through the
  // exact URLs the app uses (the HMR-instance lesson)
  await evalIn(cdp, `
    (async () => {
      const imp = new Function("u", "return import(u)");
      const base = "${ORIGIN}/src/lib/";
      const src = await (await fetch(base + "register-commands.ts")).text();
      const u = (re) => new URL(src.match(re)[1], base).href;
      const { ui } = await imp(u(/from\\s+"([^"]*stores\\/ui\\.svelte\\.ts[^"]*)"/));
      const { settings } = await imp(base + "stores/settings.svelte.ts");
      const { ftpSites } = await imp(base + "stores/ftpSites.svelte.ts");
      const { dictionaries } = await imp(base + "i18n/dictionaries.ts");
      // the app imports the i18n store as "./i18n.svelte" (no .ts) — importing
      // the .ts URL would create a SECOND store instance (silent-no-op trap);
      // resolve the app's own specifier from the settings module source
      const ssrc = await (await fetch(base + "stores/settings.svelte.ts")).text();
      const i18nUrl = new URL(ssrc.match(/from\\s+"([^"]*i18n\\.svelte[^"]*)"/)[1], base + "stores/").href;
      const i18nMod = await imp(i18nUrl);
      window.__e2e = { ui, settings, ftpSites, dictionaries, i18n: i18nMod.i18n, log: [] };
      const listing = (p) => ({ path: p, entries: [
        { name: "pub", isDir: true, size: 0, mtime: 0, attrs: "", isSymlink: false, isHidden: false },
      ], freeBytes: 0, totalBytes: 0 });
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        window.__e2e.log.push([cmd, args]);
        switch (cmd) {
          case "drives_list": return Promise.resolve([
            { name: "Local (C:)", mountPoint: "C:\\\\", kind: "fixed", totalBytes: 500000000000, freeBytes: 100000000000 },
          ]);
          case "list_dir": return Promise.resolve(listing(args.path));
          case "load_json": return Promise.resolve(null);
          case "save_json": return Promise.resolve(null);
          case "free_space": return Promise.resolve([0, 0]);
          default: return Promise.resolve(null);
        }
      };
      ui.closeDialog();
      ftpSites.sites = [
        { id: "e2e1", name: "Site One", host: "one.e2e.test", port: 21, user: "anonymous", password: "", hotkey: "1" },
      ];
      return true;
    })()
  `);
  await sleep(500);

  // helpers evaluated in-page (ONE dialog per evaluate)
  const openMenu = () => evalIn(cdp, `(() => { window.__e2e.ui.openDialog("menu"); return true; })()`);
  const esc = async () => { await key(cdp, "Escape", "Escape"); await sleep(200); };
  const localeState = () => evalIn(cdp, `(() => ({ l: window.__e2e.i18n.locale, lang: document.documentElement.lang, dir: document.documentElement.dir }))()`);
  // click the language button by locale id (real user path: F9 -> Language grid)
  const clickLang = (id) => evalIn(cdp, `
    (() => {
      const btn = [...document.querySelectorAll(".lang-grid .btn.lang")]
        .find((b) => b.textContent.trim() === ({uk:"Українська",ro:"Română",sk:"Slovenčina",ar:"العربية",ru:"Русский",en:"English"})["${id}"]);
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  const menuView = () => evalIn(cdp, `
    (() => {
      const t = (k) => window.__e2e.i18n.t(k);
      const grps = [...document.querySelectorAll(".dlg-body .grp")].map((g) => g.textContent.trim());
      const checks = [...document.querySelectorAll(".dlg-body .check span")].map((s) => s.textContent.trim());
      const fcBtn = document.querySelector(".dlg-body .fc-open")?.textContent.trim() ?? "";
      const langGrp = grps.includes(t("menu.language"));
      return { grps, checks, fcBtn, langGrp,
        view: grps[0] === t("menu.view"), dirs: checks.includes(t("menu.dirsFirst")),
        fileColors: fcBtn.includes(t("menu.fileColors")) };
    })()
  `);
  const fcDialog = () => evalIn(cdp, `
    (() => {
      const t = (k) => window.__e2e.i18n.t(k);
      const title = document.querySelector(".dlg-title")?.textContent.trim() ?? "";
      const hint = document.querySelector(".dlg-body .fc-hint")?.textContent.trim() ?? "";
      const btns = [...document.querySelectorAll(".dlg-actions .btn")].map((b) => b.textContent.trim());
      return { title, hint, btns,
        titleOk: title.includes(t("menu.fileColors")), hintOk: hint === t("fc.hint"),
        add: btns.some((b) => b.includes(t("fc.add"))), reset: btns.some((b) => b.includes(t("fc.reset"))) };
    })()
  `);
  const mrDialog = () => evalIn(cdp, `
    (() => {
      const t = (k) => window.__e2e.i18n.t(k);
      const title = document.querySelector(".dlg-title")?.textContent.trim() ?? "";
      const body = document.querySelector(".dlg-body")?.textContent ?? "";
      const labels = [...document.querySelectorAll(".dlg-body label, .dlg-body .lbl")].map((l) => l.textContent.trim());
      return { title, hasN: title.includes("3"), raw: body.includes("{n}"),
        maskOk: labels.some((l) => l.includes(t("mr.mask"))),
        tmplOk: labels.some((l) => l.includes(t("mr.nameTmpl"))),
        titleOk: title.includes(t("mr.title")) };
    })()
  `);
  // en-fallback leak scan over the currently open dialog for the given keys;
  // occurrences of the locale's own string are cut first — en "Reset" must not
  // flag ro "Resetare" (substring relation, not a fallback)
  const leakScan = (keysJs) => evalIn(cdp, `
    (() => {
      const loc = window.__e2e.i18n.locale;
      const en = window.__e2e.dictionaries.en, cur = window.__e2e.dictionaries[loc];
      const text = document.querySelector(".dlg")?.textContent ?? "";
      const leaks = [];
      for (const k of ${keysJs}) {
        if (!en[k] || !cur[k] || en[k] === cur[k]) continue;
        const stripped = text.split(cur[k]).join("");
        if (stripped.includes(en[k])) leaks.push(k);
      }
      return leaks;
    })()
  `);

  const LOCALES_UNDER_TEST = [
    { id: "uk", dir: "ltr" }, { id: "ro", dir: "ltr" }, { id: "sk", dir: "ltr" }, { id: "ar", dir: "rtl" },
  ];

  for (const L of LOCALES_UNDER_TEST) {
    // A) switch the language through the real F9 menu buttons
    await openMenu();
    await waitFor(() => evalIn(cdp, `!!document.querySelector(".lang-grid .btn.lang")`), 8000, `${L.id} lang grid`);
    const clicked = await clickLang(L.id);
    await sleep(300);
    const st = await localeState();
    check(`${L.id}: language button switches i18n.locale`, clicked && st.l === L.id && st.lang === L.id, JSON.stringify(st));
    check(`${L.id}: document.dir is ${L.dir}`, st.dir === L.dir, st.dir);

    // B) the F9 menu itself re-renders translated (View group + checks + file colors)
    const mv = await menuView();
    check(`${L.id}: F9 View group translated`, mv.view && mv.dirs && mv.fileColors && mv.langGrp,
      JSON.stringify({ grps: mv.grps.slice(0, 2), checks: mv.checks.length, fc: mv.fcBtn }));
    const menuLeaks = await leakScan(`["menu.view","menu.dirsFirst","menu.showHidden","menu.showSystem","menu.markedFirst","menu.fileColors","menu.fontSize","menu.hlColors","menu.language"]`);
    check(`${L.id}: F9 menu has no English fallback`, menuLeaks.length === 0, menuLeaks.join(","));
    await esc();

    // C) file colors dialog
    await evalIn(cdp, `window.__e2e.ui.openDialog("fileColors")`);
    await waitFor(() => evalIn(cdp, `!!document.querySelector(".dlg-body .fc-hint")`), 8000, `${L.id} fc dialog`);
    const fc = await fcDialog();
    check(`${L.id}: file-colors dialog translated`, fc.titleOk && fc.hintOk && fc.add && fc.reset,
      JSON.stringify({ title: fc.title, hint: fc.hint.slice(0, 40), btns: fc.btns }));
    const fcLeaks = await leakScan(`["fc.hint","fc.add","fc.reset","fc.remove","fc.bold"]`);
    check(`${L.id}: file-colors dialog has no English fallback`, fcLeaks.length === 0, fcLeaks.join(","));
    await esc();

    // D) Ctrl+M multi-rename dialog with 3 targets ({n} interpolated)
    await evalIn(cdp, `
      (() => {
        window.__e2e.ui.askMultiRename([
          { path: "C:\\\\e2e", name: "a.txt" }, { path: "C:\\\\e2e", name: "b.txt" }, { path: "C:\\\\e2e", name: "c.txt" },
        ]);
        return true;
      })()
    `);
    await waitFor(() => evalIn(cdp, `window.__e2e.ui.dialog === "multiRename" && !!document.querySelector(".dlg-title")`), 8000, `${L.id} mr dialog`);
    const mr = await mrDialog();
    check(`${L.id}: Ctrl+M dialog translated, {n} interpolated`, mr.titleOk && mr.hasN && !mr.raw && mr.maskOk && mr.tmplOk,
      JSON.stringify({ title: mr.title, mask: mr.maskOk, tmpl: mr.tmplOk }));
    const mrLeaks = await leakScan(`["mr.title","mr.mask","mr.find","mr.replace","mr.nameTmpl","mr.extTmpl","mr.countStart","mr.countStep","mr.countDigits","mr.phHint","mr.apply"]`);
    check(`${L.id}: Ctrl+M dialog has no English fallback`, mrLeaks.length === 0, mrLeaks.join(","));
    await esc();
  }

  // E) regressions: ru and en still switch and render their own View label
  for (const [id, expect] of [["ru", "Вид"], ["en", "View"]]) {
    await openMenu();
    await waitFor(() => evalIn(cdp, `!!document.querySelector(".lang-grid .btn.lang")`), 8000, `${id} lang grid`);
    await clickLang(id);
    await sleep(300);
    const grps = await evalIn(cdp, `[...document.querySelectorAll(".dlg-body .grp")].map((g) => g.textContent.trim())`);
    check(`regression ${id}: View group is "${expect}"`, grps[0] === expect, grps[0]);
    await esc();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
} finally {
  edge.kill();
  if (ours) ours.kill();
}
