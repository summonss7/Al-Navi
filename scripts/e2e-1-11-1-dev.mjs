// Dev E2E for 1.11.1 (alnavi-020): window geometry must survive a minimize.
// A minimized window reports parked geometry (Windows stashes it at −32000
// sized ~181×24); the old tracker wrote that into window.json, so an app
// closed/rebooted while minimized reopened as a 181×24 slit. The tracker now
// ignores events while minimized (plus a belt-and-suspenders size floor),
// and flush() keeps the last real geometry + tracked maximized flag instead
// of re-querying IsZoomed (which lies for an iconic window). Loads the app
// from the vite dev server in headless Edge with a mocked Tauri window API
// (windowState talks to plugin:window|* through __TAURI_INTERNALS__.invoke),
// fires real tauri://resize|move listener callbacks and watches save_json.
// Usage: node scripts/e2e-1-11-1-dev.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420;
const CDP_PORT = 9242;
const ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-e2e-1111-"));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = await fetch(`${ORIGIN}/`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
const vite = alive && alive.includes("Al-Navi") ? null : spawn("npm", ["run", "dev"], { shell: true, stdio: "ignore" });
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

// installed before any app module: a Tauri internals good enough for
// windowState.ts (plugin:window queries, event listen, save_json capture)
const MOCK = `(() => {
  const M = {
    minimized: false, maximized: false,
    size: { width: 1000, height: 700 }, pos: { x: 40, y: 30 },
    saves: [], listeners: new Map(), cbs: new Map(), cbSeq: 0,
  };
  window.__mock = M;
  const evArr = (name) => { const a = M.listeners.get(name) ?? []; M.listeners.set(name, a); return a; };
  M.fire = (name, payload) => { for (const id of evArr(name)) M.cbs.get(id)?.({ event: name, id: 0, payload }); };
  // tauri wraps geometry payloads in a {Physical: …} dict before handlers run
  M.fireResized = () => M.fire("tauri://resize", { Physical: { width: M.size.width, height: M.size.height } });
  M.fireMoved = () => M.fire("tauri://move", { Physical: { x: M.pos.x, y: M.pos.y } });
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: (cb) => { const id = ++M.cbSeq; M.cbs.set(id, cb); return id; },
    invoke: (cmd, args) => new Promise((resolve, reject) => {
      switch (cmd) {
        case "plugin:window|is_minimized": return resolve(M.minimized);
        case "plugin:window|is_maximized": return resolve(M.maximized);
        case "plugin:window|inner_size": return resolve({ ...M.size });
        case "plugin:window|outer_position": return resolve({ ...M.pos });
        case "plugin:event|listen": { const a = evArr(args.event); a.push(args.handler); return resolve(a.length); }
        case "plugin:event|unlisten": return resolve();
        case "save_json":
          if (args?.name === "window.json") M.saves.push(JSON.parse(JSON.stringify(args.data)));
          return resolve();
        default: return reject(new Error("mock: unsupported " + cmd));
      }
    }),
  };
})();`;

try {
  // a cold vite takes seconds to answer — navigating before that lands on
  // Edge's error page, which would pass a naive body-text boot check
  await waitFor(() => fetch(`${ORIGIN}/`).then((r) => (r.ok ? true : null)), 30000, "vite dev");
  const wsUrl = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
  }, 30000, "edge devtools");
  const cdp = connect(wsUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
  await cdp.send("Page.navigate", { url: ORIGIN });
  await waitFor(() => evalIn(cdp, `document.querySelector(".panels") ? true : (document.body && document.body.innerText.length > 0 ? "body" : null)`), 30000, "app boot");
  // windowState.init() subscribed resize+move and ran its initial (unsaved) pass
  await waitFor(() => evalIn(cdp, `(window.__mock.listeners.get("tauri://resize")?.length ?? 0) >= 1`), 10000, "resize listener");
  await sleep(600);

  const mockState = (s) => evalIn(cdp, `Object.assign(window.__mock, ${JSON.stringify(s)}); true`);
  const fire = (which) => evalIn(cdp, `window.__mock.fire${which}(); true`);
  const flush = () => evalIn(cdp, `import("/src/lib/windowState.ts").then((m) => m.flush()).then(() => true)`);
  const saves = () => evalIn(cdp, `window.__mock.saves`);

  // 1. no save from the startup pass (inited=false skips the burst)
  check("startup burst is not saved", (await saves()).length === 0);

  // 2. a normal resize persists after the 800ms debounce
  await mockState({ size: { width: 1100, height: 750 }, pos: { x: 40, y: 30 } });
  await fire("Resized");
  await sleep(1200);
  let s = await saves();
  check("normal resize saved", s.length === 1 && s[0].w === 1100 && s[0].h === 750 && s[0].x === 40 && s[0].y === 30 && s[0].maximized === false, JSON.stringify(s.at(-1)));

  // 3. minimized events (parked geometry) never reach window.json
  await mockState({ minimized: true, size: { width: 181, height: 24 }, pos: { x: -32000, y: -32000 } });
  await fire("Resized");
  await fire("Moved");
  await sleep(1200);
  s = await saves();
  check("minimized resize NOT saved", s.length === 1, `saves=${s.length}`);

  // 4. exiting while minimized keeps the last real geometry
  await flush();
  s = await saves();
  check("flush while minimized keeps real geometry", s.length === 2 && s[1].w === 1100 && s[1].h === 750 && s[1].x === 40 && s[1].y === 30 && s[1].maximized === false, JSON.stringify(s.at(-1)));

  // 5. degenerate size without the minimized flag is filtered too
  await mockState({ minimized: false, size: { width: 181, height: 24 }, pos: { x: -32000, y: -32000 } });
  await fire("Resized");
  await sleep(1200);
  s = await saves();
  check("degenerate size (no flag) NOT saved", s.length === 2, `saves=${s.length}`);
  await flush();
  s = await saves();
  check("flush after degenerate keeps real geometry", s.length === 3 && s[2].w === 1100 && s[2].h === 750, JSON.stringify(s.at(-1)));

  // 6. a maximized window tracks the flag, not the geometry
  await mockState({ maximized: true, size: { width: 1600, height: 900 }, pos: { x: 0, y: 0 } });
  await fire("Resized");
  await sleep(1200);
  s = await saves();
  check("maximized saves flag + old normal geometry", s.length === 4 && s[3].maximized === true && s[3].w === 1100 && s[3].h === 750, JSON.stringify(s.at(-1)));

  // 7. maximized + minimized + flush: IsZoomed lies when iconic, the tracked
  //    flag must survive (reopen maximized)
  await mockState({ minimized: true, size: { width: 181, height: 24 }, pos: { x: -32000, y: -32000 } });
  await flush();
  s = await saves();
  check("flush minimized keeps tracked maximized", s.length === 5 && s[4].maximized === true && s[4].w === 1100, JSON.stringify(s.at(-1)));

  // 8. restore from minimized updates geometry again
  await mockState({ minimized: false, maximized: false, size: { width: 1200, height: 800 }, pos: { x: 60, y: 50 } });
  await fire("Resized");
  await sleep(1200);
  s = await saves();
  check("geometry tracked again after restore", s.length === 6 && s[5].w === 1200 && s[5].h === 800 && s[5].x === 60 && s[5].y === 50, JSON.stringify(s.at(-1)));

  cdp.close();
} finally {
  edge.kill();
  if (vite) vite.kill();
  await sleep(500);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? " — FAILED: " + failed.map((f) => f.name).join("; ") : ""}`);
process.exit(failed.length ? 1 : 0);
