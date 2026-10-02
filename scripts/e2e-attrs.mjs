// E2E for Ctrl+A file attributes (1.9.1) on the real Al-Navi exe via CDP.
// Usage: node scripts/e2e-attrs.mjs <path-to-exe>
// Real backend, no mocks: creates a temp dir with files, cd's the panel there
// via the command line, then drives the attrs dialog with real key/mouse
// events and verifies the on-disk attribute mask with `attrib` after each
// submit (R/O/H/S/A), plus prefill/mixed/keep semantics, Esc cancel and a
// directory target.
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: node scripts/e2e-attrs.mjs <exe>");
  process.exit(1);
}
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 9224;
const profile = mkdtempSync(join(tmpdir(), "alnavi-cdp-"));
const work = mkdtempSync(join(tmpdir(), "alnavi-attrs-"));
writeFileSync(join(work, "alpha.txt"), "alpha");
writeFileSync(join(work, "beta.txt"), "beta");
writeFileSync(join(work, "gamma.txt"), "gamma");
mkdirSync(join(work, "subdir"));

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

// attribute flags only — strip the path so its letters never leak into checks
const attrib = (path) =>
  execSync(`attrib "${path}"`, { encoding: "utf8" })
    .split(/\r?\n/)[0]
    .toUpperCase()
    .replace(/[A-Za-z]:\\.*$/, "")
    .trim();

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
    ws.onerror = () => rej(new Error("ws error"));
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

// CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8
async function key(cdp, { key, code, keyCode, ctrl = false, alt = false, up = false }) {
  const modifiers = (ctrl ? 2 : 0) | (alt ? 1 : 0);
  await cdp.send("Input.dispatchKeyEvent", {
    key, code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
    type: up ? "keyUp" : "keyDown",
  });
}

async function typeLine(cdp, text) {
  await cdp.send("Input.insertText", { text });
  await key(cdp, { key: "Enter", code: "Enter", keyCode: 13 });
  await key(cdp, { key: "Enter", code: "Enter", keyCode: 13, up: true });
}

// real mouse click on the n-th attrs checkbox; false if the dialog is gone
async function clickBox(cdp, n) {
  const r = await evalIn(cdp, `(() => {
    const b = document.querySelectorAll("#attrs-form input[type=checkbox]")[${n}];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!r || r.x < 0) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type, x: r.x, y: r.y, button: "left", clickCount: 1,
    });
  }
  return true;
}

const boxStates = `(() => [...document.querySelectorAll("#attrs-form input[type=checkbox]")]
  .map(b => (b.indeterminate ? "keep" : b.checked ? "set" : "clear")))()`;

async function down(cdp, n = 1) {
  for (let i = 0; i < n; i++) {
    await key(cdp, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
    await key(cdp, { key: "ArrowDown", code: "ArrowDown", keyCode: 40, up: true });
    await sleep(150);
  }
}

async function cursorRow(cdp) {
  return (await evalIn(cdp,
    `document.querySelector(".panel.active .row.cursor")?.textContent ?? ""`)) ?? "";
}

try {
  const target = await findTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  console.log(`connected: ${target.title ?? target.url}`);
  await sleep(1500);

  // the saved window geometry can be a tiny CDP-era leftover — put the window
  // at a known size via the OS (CDP setWindowBounds is not honored by the app)
  const resizeOut = execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${join(ROOT, "scripts", "resize-window.ps1")}" -W 1200 -H 700`,
    { encoding: "utf8" },
  ).trim();
  console.log(`window: ${resizeOut}`);
  await sleep(1500);

  // ---- boot + version ----
  const boot = await evalIn(cdp, `(() => ({
    tauri: !!window.__TAURI_INTERNALS__,
    version: (document.body.textContent.match(/1\\.9\\.1/) || [])[0] ?? null,
  }))()`);
  check("app booted with real backend", !!boot?.tauri, JSON.stringify(boot));
  check("version 1.9.1 in UI", boot?.version === "1.9.1");

  // ---- cd the panel to the work dir via the command line ----
  await typeLine(cdp, `cd ${work}`);
  await sleep(900);
  const crumb = await evalIn(cdp,
    `document.querySelector(".panel.active .crumbs")?.textContent ?? ""`);
  check("cd to work dir", crumb.toUpperCase().includes("ALNAVI-ATTRS"), crumb);

  // rows: .., subdir, alpha.txt, beta.txt, gamma.txt — walk to beta.txt
  for (let i = 0; i < 3; i++) {
    await key(cdp, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
    await key(cdp, { key: "ArrowDown", code: "ArrowDown", keyCode: 40, up: true });
    await sleep(120);
  }
  const curRow = await evalIn(cdp,
    `document.querySelector(".panel.active .row.cursor")?.textContent ?? ""`);
  check("cursor on beta.txt", /beta\.txt/i.test(curRow), curRow.replace(/\s+/g, " ").slice(0, 60));

  // ---- Ctrl+A opens the dialog, prefilled from the fresh file (A set) ----
  await key(cdp, { key: "a", code: "KeyA", keyCode: 65, ctrl: true });
  await key(cdp, { key: "a", code: "KeyA", keyCode: 65, ctrl: true, up: true });
  await sleep(500);
  let states = await evalIn(cdp, boxStates);
  const dlgForm = await evalIn(cdp, `!!document.getElementById("attrs-form")`);
  check("Ctrl+A opens attrs dialog", dlgForm && Array.isArray(states) && states.length === 4,
    JSON.stringify(states));
  check("prefill of a fresh file (only A set)", JSON.stringify(states) === JSON.stringify(["clear", "clear", "clear", "set"]),
    JSON.stringify(states));

  // ---- set R via a real mouse click, submit with Enter ----
  await clickBox(cdp, 0);
  await sleep(150);
  await key(cdp, { key: "Enter", code: "Enter", keyCode: 13 });
  await key(cdp, { key: "Enter", code: "Enter", keyCode: 13, up: true });
  await sleep(700);
  let a = attrib(join(work, "beta.txt"));
  check("R+A on disk after submit", /R/.test(a) && /A/.test(a) && !/H/.test(a) && !/S/.test(a), a.trim());

  // panel re-renders the Attr column as RA
  await sleep(400);
  const rowTxt = await evalIn(cdp,
    `document.querySelector(".panel.active .row.cursor")?.textContent ?? ""`);
  check("panel shows RA", /RA/.test(rowTxt.replace(/\s+/g, "")), rowTxt.replace(/\s+/g, " ").slice(0, 60));

  // ---- mixed selection: alpha (A) + beta (RA) -> R keep, A set ----
  // cursor is on beta (verified above); mark it, walk up, mark alpha
  await key(cdp, { key: "Insert", code: "Insert", keyCode: 45 });
  await key(cdp, { key: "Insert", code: "Insert", keyCode: 45, up: true });
  await sleep(200);
  await key(cdp, { key: "ArrowUp", code: "ArrowUp", keyCode: 38 });
  await key(cdp, { key: "ArrowUp", code: "ArrowUp", keyCode: 38, up: true });
  await sleep(200);
  const alphaRow = await cursorRow(cdp);
  check("walked up to alpha.txt", /alpha\.txt/i.test(alphaRow), alphaRow.replace(/\s+/g, " ").slice(0, 60));
  await key(cdp, { key: "Insert", code: "Insert", keyCode: 45 });
  await key(cdp, { key: "Insert", code: "Insert", keyCode: 45, up: true });
  await sleep(200);
  const marked = await evalIn(cdp,
    `[...document.querySelectorAll(".panel.active .row.selected")].map(r => r.textContent.trim().split(/\\s+/)[0])`);
  check("alpha+beta marked", JSON.stringify(marked) === JSON.stringify(["alpha.txt", "beta.txt"]),
    JSON.stringify(marked));
  await key(cdp, { key: "a", code: "KeyA", keyCode: 65, ctrl: true });
  await key(cdp, { key: "a", code: "KeyA", keyCode: 65, ctrl: true, up: true });
  await sleep(500);
  states = await evalIn(cdp, boxStates);
  const countLine = await evalIn(cdp,
    `Array.from(document.querySelectorAll("#attrs-form .lbl")).map(l => l.textContent).join("|")`);
  check("mixed selection prefill (R=keep, A=set)",
    JSON.stringify(states) === JSON.stringify(["keep", "clear", "clear", "set"]),
    `${JSON.stringify(states)} ${countLine}`);
  check("items count line", /(^|\D)2(\D|$)/.test(String(countLine)), String(countLine));

  // Esc cancels: nothing changes on disk
  await key(cdp, { key: "Escape", code: "Escape", keyCode: 27 });
  await key(cdp, { key: "Escape", keyCode: 27, code: "Escape", up: true });
  await sleep(400);
  a = attrib(join(work, "alpha.txt"));
  check("Esc leaves alpha untouched", !/R/.test(a) && !/H/.test(a), a.trim());

  // ---- clear R on the still-selected pair (one click: keep -> clear) ----
  // selection is {alpha, beta}: R mixed (alpha none, beta R) -> keep; one
  // click cycles keep -> clear, Enter clears R on both
  await key(cdp, { key: "a", code: "KeyA", keyCode: 65, ctrl: true });
  await key(cdp, { key: "a", code: "KeyA", keyCode: 65, ctrl: true, up: true });
  await sleep(500);
  states = await evalIn(cdp, boxStates);
  check("pair prefill has R=keep", JSON.stringify(states) === JSON.stringify(["keep", "clear", "clear", "set"]),
    JSON.stringify(states));
  const c1 = await clickBox(cdp, 0); // keep -> clear
  // NOTE: no mid-dialog DOM read here — under CDP the click event can process
  // later than the following evaluate; the disk state after Enter is the truth
  await key(cdp, { key: "Enter", code: "Enter", keyCode: 13 });
  await key(cdp, { key: "Enter", code: "Enter", keyCode: 13, up: true });
  await sleep(700);
  a = attrib(join(work, "beta.txt"));
  check("R cleared on disk", !/R/.test(a) && /A/.test(a), a.trim());
  if (!c1) check("clicks landed on the checkbox", false, "clickBox missed");

  // ---- set H on the pair (Space on the second box), submit ----
  await key(cdp, { key: "a", code: "KeyA", keyCode: 65, ctrl: true });
  await key(cdp, { key: "a", code: "KeyA", keyCode: 65, ctrl: true, up: true });
  await sleep(500);
  // focus starts on box 0; ArrowDown moves focus to box 1 (hidden)
  await key(cdp, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
  await key(cdp, { key: "ArrowDown", code: "ArrowDown", keyCode: 40, up: true });
  await sleep(200);
  await key(cdp, { key: " ", code: "Space", keyCode: 32 }); // clear -> set
  await key(cdp, { key: " ", code: "Space", keyCode: 32, up: true });
  await sleep(200);
  states = await evalIn(cdp, boxStates);
  check("Space sets hidden", states[1] === "set", JSON.stringify(states));
  await key(cdp, { key: "Enter", code: "Enter", keyCode: 13 });
  await key(cdp, { key: "Enter", code: "Enter", keyCode: 13, up: true });
  await sleep(700);
  a = attrib(join(work, "beta.txt"));
  check("H set on disk", /H/.test(a) && /A/.test(a) && !/R/.test(a), a.trim());

  // ---- directory: subdir gets R ----
  // alpha+beta are hidden now and left the view, so the stale selection no
  // longer resolves and Ctrl+A targets the file under the cursor. A watcher
  // reload can land mid-walk and clamp the cursor — retry until parked.
  let curDir = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    for (let i = 0; i < 6; i++) {
      await key(cdp, { key: "ArrowUp", code: "ArrowUp", keyCode: 38 });
      await key(cdp, { key: "ArrowUp", code: "ArrowUp", keyCode: 38, up: true });
      await sleep(120);
    }
    await down(cdp, 1);
    await sleep(300);
    curDir = await cursorRow(cdp);
    if (/subdir/i.test(curDir)) break;
  }
  check("cursor on subdir", /subdir/i.test(curDir), curDir.replace(/\s+/g, " ").slice(0, 60));
  await key(cdp, { key: "a", code: "KeyA", keyCode: 65, ctrl: true });
  await key(cdp, { key: "a", code: "KeyA", keyCode: 65, ctrl: true, up: true });
  await sleep(500);
  states = await evalIn(cdp, boxStates);
  check("dialog targets a single dir (count 1, all clear)",
    JSON.stringify(states) === JSON.stringify(["clear", "clear", "clear", "clear"]), JSON.stringify(states));
  const c3 = await clickBox(cdp, 0);
  await sleep(200);
  await key(cdp, { key: "Enter", code: "Enter", keyCode: 13 });
  await key(cdp, { key: "Enter", code: "Enter", keyCode: 13, up: true });
  await sleep(700);
  a = attrib(join(work, "subdir"));
  check("R set on a directory", /R/.test(a), a.trim());
  if (!c3) check("dir dialog click landed", false, "clickBox missed");

  // ---- summary ----
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  child.kill();
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { rmSync(work, { recursive: true, force: true }); } catch {}
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error("E2E error:", e);
  child.kill();
  try { rmSync(work, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
