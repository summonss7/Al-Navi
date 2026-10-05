// E2E on the real Al-Navi exe via CDP (WebView2 remote debugging).
// Usage: node scripts/e2e-real.mjs <path-to-exe>
// Launches the exe with an isolated WebView2 profile + debug port, then
// drives the real app (real Rust backend, no mocks): Alt+F7 dialog, a real
// search over D:\Al-Navi, Esc cancel over C:\Windows, version in the title.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: node scripts/e2e-real.mjs <exe>");
  process.exit(1);
}
const PORT = 9223;
const profile = mkdtempSync(join(tmpdir(), "alnavi-cdp-"));
const child = spawn(exe, [], {
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
  stdio: "ignore",
  detached: false,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

async function findTarget(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && !t.url.startsWith("about:"));
      if (page) return page;
    } catch {
      /* not up yet */
    }
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
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const ready = new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(new Error("ws error"));
  });
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
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}

async function key(cdp, { key, code, keyCode, alt = false, up = false }) {
  // CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8
  const modifiers = alt ? 1 : 0;
  const base = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
  };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: up ? "keyUp" : "keyDown" });
}

try {
  const target = await findTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  console.log(`connected: ${target.title ?? target.url}`);

  // ---- boot: real backend present, app loaded ----
  await sleep(2500);
  const boot = await evalIn(cdp, `(() => ({
    tauri: !!window.__TAURI_INTERNALS__,
    title: document.title,
    panels: document.querySelectorAll(".panel").length,
  }))()`);
  check("app booted", !!boot?.tauri && boot.panels >= 1, JSON.stringify(boot));

  // ---- version shown in UI (title bar info) ----
  const version = await evalIn(cdp, `(() => {
    const t = document.body.textContent.match(/1\\.7\\.0/);
    return t ? "1.7.0" : null;
  })()`);
  check("version 1.7.0 in UI", version === "1.7.0");

  // ---- Alt+F7 opens the dialog, root prefilled with the active panel ----
  await key(cdp, { key: "F7", code: "F7", keyCode: 118, alt: true });
  await key(cdp, { key: "F7", code: "F7", keyCode: 118, alt: true, up: true });
  await sleep(600);
  const dlg = await evalIn(cdp, `(() => ({
    form: !!document.getElementById("search-form"),
    root: document.getElementById("sr-f-root")?.value ?? null,
    mask: document.getElementById("sr-f-mask")?.value ?? null,
  }))()`);
  check("Alt+F7 dialog", !!dlg?.form, JSON.stringify(dlg));
  check("root prefilled", !!dlg?.root && /^[A-Za-z]:[\\\\/]/.test(dlg.root), dlg.root);

  // ---- real search: D:\Al-Navi, *.md containing "Al-Navi" ----
  await evalIn(cdp, `(() => {
    const root = document.getElementById("sr-f-root");
    root.value = "D:\\\\Al-Navi";
    root.dispatchEvent(new Event("input", { bubbles: true }));
    const mask = document.getElementById("sr-f-mask");
    mask.value = "*.md";
    mask.dispatchEvent(new Event("input", { bubbles: true }));
    const text = document.getElementById("sr-f-text");
    text.value = "Al-Navi";
    text.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await evalIn(cdp, `document.getElementById("search-form").requestSubmit()`);
  await sleep(400);
  const running = await evalIn(cdp, `(() => ({
    rows: [...document.querySelectorAll(".panel.active .vlist div")].map(d => d.textContent?.trim()).filter(t => t && t !== ".."),
    crumb: document.querySelector(".panel.active .crumbs")?.textContent ?? "",
    foot: document.querySelector(".panel.active .p-foot")?.textContent?.replace(/\\s+/g, " ").trim(),
  }))()`);
  const onSearchPanel = (running?.crumb ?? "").includes("*.md");
  const mdHits = (running?.rows ?? []).filter((r) => /\.md/i.test(r));
  check("search running / results streamed", onSearchPanel && mdHits.length >= 2,
    `crumb=${running?.crumb}; ${mdHits.length} md hits; foot=${running?.foot}`);
  const hasReadme = mdHits.some((r) => /README\.md/i.test(r));
  check("README.md found by content", !!hasReadme, mdHits.slice(0, 3).join(" | "));

  // wait for completion: the running spinner disappears and seconds appear
  let doneFoot = "";
  let spinnerGone = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const st = await evalIn(cdp, `(() => ({
      foot: document.querySelector(".panel.active .p-foot")?.textContent?.replace(/\\s+/g, " ").trim(),
      spinner: !!document.querySelector(".panel.active .search-st i"),
    }))()`);
    doneFoot = st?.foot ?? "";
    spinnerGone = st ? !st.spinner : false;
    if (spinnerGone && /\\d+(\\.\\d+)?s/.test(doneFoot)) break;
  }
  check("search done footer", spinnerGone && /\d+(\.\d+)?s/.test(doneFoot), doneFoot);

  // ---- jump to location: Enter on the first hit row ----
  // (cursor already on ".."; move down once, Enter, then check the panel dir)
  await key(cdp, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
  await key(cdp, { key: "ArrowDown", code: "ArrowDown", keyCode: 40, up: true });
  await sleep(200);
  await key(cdp, { key: "Enter", code: "Enter", keyCode: 13 });
  await key(cdp, { key: "Enter", code: "Enter", keyCode: 13, up: true });
  await sleep(900);
  const afterEnter = await evalIn(cdp, `(() => ({
    crumb: [...document.querySelectorAll(".panel.active .crumbs .crumb")].map(c => c.textContent).join("|"),
    cursorName: null,
  }))()`);
  const jumped = !!afterEnter?.crumb && !afterEnter.crumb.includes("*.md") && /Al-Navi/i.test(afterEnter.crumb);
  check("Enter jumps to the hit location", !!jumped, JSON.stringify(afterEnter));

  // ---- Esc cancels a big search (C:\Windows) ----
  await key(cdp, { key: "F7", code: "F7", keyCode: 118, alt: true });
  await key(cdp, { key: "F7", code: "F7", keyCode: 118, alt: true, up: true });
  await sleep(600);
  await evalIn(cdp, `(() => {
    const root = document.getElementById("sr-f-root");
    root.value = "C:\\\\Windows";
    root.dispatchEvent(new Event("input", { bubbles: true }));
    const mask = document.getElementById("sr-f-mask");
    mask.value = "*";
    mask.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("search-form").requestSubmit();
    return true;
  })()`);
  await sleep(2500); // let it get deep into the tree
  const midFoot = (await evalIn(cdp, `document.querySelector(".panel.active .p-foot")?.textContent?.replace(/\\s+/g, " ").trim()`)) ?? "";
  await key(cdp, { key: "Escape", code: "Escape", keyCode: 27 });
  await key(cdp, { key: "Escape", code: "Escape", keyCode: 27, up: true });
  await sleep(1200);
  const afterEsc = await evalIn(cdp, `(() => ({
    foot: document.querySelector(".panel.active .p-foot")?.textContent?.replace(/\\s+/g, " ").trim(),
    toast: document.querySelector(".toast")?.textContent ?? null,
    spinner: !!document.querySelector(".panel.active .search-st i"),
    responsive: !!document.querySelectorAll(".panel")[0],
  }))()`);
  check("Esc cancels Windows scan", !afterEsc?.spinner && /\d+(\.\d+)?s/.test(afterEsc?.foot ?? ""),
    `mid=${midFoot}; after=${afterEsc?.foot}; toast=${afterEsc?.toast}`);

  // ---- summary ----
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  child.kill();
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error("E2E error:", e);
  child.kill();
  process.exit(1);
}
