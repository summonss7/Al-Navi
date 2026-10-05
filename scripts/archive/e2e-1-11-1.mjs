// E2E for 1.11.1 (alnavi-020) on the real Al-Navi exe: the window must not
// reopen as a 181×24 slit after being closed/rebooted while minimized.
// Exact geometry is asserted through the app's own window API via CDP —
// GetWindowRect from an external process is DPI-virtualized on a scaled
// display (measured 954 px for a 1193 px window at 125%) and only usable
// for coarse state checks. Phases (user config is backed up and restored):
//   1. good window.json (1400×1000@120,80 — above the app minimum at any
//      DPI) -> the window reopens at that size/position;
//   2. minimize -> hard kill (what a reboot does) -> window.json still holds
//      the good geometry, not the parked ~181×24@−32000;
//   3. minimize -> graceful close (WM_CLOSE): un-minimized by the Rust
//      CloseRequested hook so the JS close handler runs -> exits and
//      window.json keeps the real geometry;
//   4. corrupt window.json (181×24@−32000) -> the window opens clamped to at
//      least 940×560 physical, not a slit.
// Usage: node scripts/e2e-1-11-1.mjs <path-to-exe>
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: node scripts/e2e-1-11-1.mjs <exe>");
  process.exit(1);
}

const CFG = join(process.env.APPDATA, "al-navi");
const PS1 = join(dirname(fileURLToPath(import.meta.url)), "e2e-1-11-1-window.ps1");
const CDP_PORT = 9253;
const profile = mkdtempSync(join(tmpdir(), "alnavi-1111-win-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// the app writes session/window/history state into the real config dir —
// back it up and restore afterwards so the E2E leaves no trace
const backedUp = [];
for (const f of ["session.json", "window.json", "dir-history.json", "xfer-history.json", "editor-state.json", "view-history.json", "ftp-sites.json"]) {
  const p = join(CFG, f);
  if (existsSync(p)) {
    cpSync(p, p + ".e2e-bak");
    backedUp.push(p);
  }
}
function restoreCfg() {
  for (const p of backedUp) { cpSync(p + ".e2e-bak", p); rmSync(p + ".e2e-bak"); }
  const p = join(CFG, "window.json");
  if (!backedUp.includes(p) && existsSync(p)) rmSync(p);
}
const readWin = () => JSON.parse(readFileSync(join(CFG, "window.json"), "utf8"));
const writeWin = (g) => writeFileSync(join(CFG, "window.json"), JSON.stringify(g));

function ps(action) {
  return new Promise((resolve) => {
    const out = [];
    const ch = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, action], { stdio: ["ignore", "pipe", "pipe"] });
    ch.stdout.on("data", (d) => out.push(d));
    ch.on("close", () => {
      try { resolve(JSON.parse(out.join("").trim())); } catch { resolve(null); }
    });
  });
}
function closeMainWindow() {
  // PostMessage WM_CLOSE to the real "Tauri Window" (the ps1 resolves it by
  // window class — .NET MainWindowHandle lands on a WebView2 helper window
  // once the window is iconic and the message would be silently ignored)
  return ps("close").then((r) => (r && r.ok ? "True" : JSON.stringify(r)));
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
  // race: an eval that destroys the window never answers
  const r = await Promise.race([
    cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
    new Promise((res) => setTimeout(() => res(null), 8000)),
  ]);
  if (r === null) return "[eval-timeout]";
  if (r.result?.exceptionDetails) return "[threw]";
  return r.result?.result?.value;
}
const inv = (cdp, cmd) => evalIn(cdp, `window.__TAURI_INTERNALS__.invoke('${cmd}', {label:'main'})`);
const geometry = async (cdp) => ({
  size: await inv(cdp, "plugin:window|inner_size"),
  pos: await inv(cdp, "plugin:window|outer_position"),
});

let child = null;
async function launch() {
  child = spawn(exe, [], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
    stdio: "ignore",
  });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const r = await ps("rect");
    if (r && !r.error && r.w > 0) break;
  }
  let wsUrl = null;
  for (let i = 0; i < 30; i++) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => ({ json: async () => [] }))).json();
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    if (wsUrl) break;
    await sleep(500);
  }
  if (!wsUrl) throw new Error("CDP target never appeared");
  const cdp = connect(wsUrl);
  await cdp.ready;
  return cdp;
}
async function killExe() {
  await new Promise((res) => {
    const tk = spawn("taskkill", ["/IM", "Al-Navi.exe", "/F"], { shell: true, stdio: "ignore" });
    tk.on("close", () => res());
  });
  await sleep(800);
}

try {
  // -- phase 1: saved good geometry reopens as-is (seed is above the app
  //    minimum in logical px at any scale, so the clamp must not touch it)
  const SEED = { x: 120, y: 80, w: 1400, h: 1000, maximized: false };
  writeWin(SEED);
  let cdp = await launch();
  let g = null;
  for (let i = 0; i < 20; i++) {
    g = await geometry(cdp);
    if (g.size?.width >= 1360 && g.size?.height >= 960) break;
    await sleep(500);
  }
  check("saved geometry restored (app view)",
    Math.abs(g.size.width - 1400) <= 40 && Math.abs(g.size.height - 1000) <= 40 && Math.abs(g.pos.x - 120) <= 4 && Math.abs(g.pos.y - 80) <= 4,
    `inner=${g.size?.width}x${g.size?.height} outerPos=${g.pos?.x},${g.pos?.y}`);
  cdp.close();
  await killExe();

  // -- phase 2: minimize + hard kill (the reboot scenario)
  cdp = await launch();
  for (let i = 0; i < 20; i++) { g = await geometry(cdp); if (g.size?.width >= 1360) break; await sleep(500); }
  await ps("min");
  await sleep(1500);
  const iconic = await inv(cdp, "plugin:window|is_minimized");
  check("really minimized", iconic === true, `isMinimized=${iconic}`);
  await sleep(1000); // debounce is 800ms — a buggy build saves by now
  await killExe();
  let f = readWin();
  check("hard kill while minimized keeps good geometry",
    f.w === 1400 && f.h === 1000 && f.x === 120 && f.y === 80,
    `file=${JSON.stringify(f)}`);

  // -- phase 3: minimize + graceful close (WM_CLOSE) — the Rust hook
  //    un-minimizes so the JS close handler can persist + destroy
  cdp = await launch();
  for (let i = 0; i < 20; i++) { g = await geometry(cdp); if (g.size?.width >= 1360) break; await sleep(500); }
  await ps("min");
  await sleep(800);
  const closed = await closeMainWindow();
  let exited = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (child.exitCode !== null || (await ps("rect")) === null) { exited = true; break; }
  }
  check("graceful close while minimized exits", exited && closed === "True", `CloseMainWindow=${closed} exited=${exited}`);
  f = readWin();
  check("flush while minimized keeps real geometry",
    f.w >= 1340 && f.w <= 1460 && f.h >= 940 && f.h <= 1060 && f.x === 120 && f.y === 80 && f.maximized === false,
    `file=${JSON.stringify(f)}`);
  cdp.close();
  if (child.exitCode === null) await killExe();

  // -- phase 4: corrupt parked record opens a normal window, not a slit
  writeWin({ x: -32000, y: -32000, w: 181, h: 24, maximized: false });
  cdp = await launch();
  g = null;
  for (let i = 0; i < 20; i++) {
    g = await geometry(cdp);
    if (g.size?.width >= 940 && g.size?.height >= 560) break;
    await sleep(500);
  }
  check("corrupt 181x24 record opens a normal window",
    (g.size?.width ?? 0) >= 940 && (g.size?.height ?? 0) >= 560 && Math.abs(g.pos?.x ?? -1) < 30000,
    `inner=${g.size?.width}x${g.size?.height} outerPos=${g.pos?.x},${g.pos?.y}`);
  cdp.close();
  await killExe();
} finally {
  try { await killExe(); } catch { /* already gone */ }
  restoreCfg();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? " — FAILED: " + failed.map((x) => x.name).join("; ") : ""}`);
process.exit(failed.length ? 1 : 0);
