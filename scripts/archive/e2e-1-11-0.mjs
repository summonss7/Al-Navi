// E2E for 1.11.0 (alnavi-018) on the real Al-Navi exe via CDP: FTP jump keys.
// The drive menu (Alt+F1) carries the FTP entry with the assigned key "2" —
// pressing 2 opens the FTP list; drive letters keep jumping as before. In the
// FTP list a site's assigned letter/digit connects AT ONCE: the script runs a
// minimal FTP server on 127.0.0.1:2211 (USER/PASS/TYPE/CWD/PASV/MLSD), so
// pressing the site key really connects and the panel lists the server; a
// second site points at a refused port and its key lands in the error dialog.
// ftp-sites.json is seeded before launch and the real config is backed up and
// restored afterwards.
// Usage: node scripts/e2e-1-11-0.mjs <path-to-exe>
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: node scripts/e2e-1-11-0.mjs <exe>");
  process.exit(1);
}

const FTP_PORT = 2211;
const CFG = join(process.env.APPDATA, "al-navi");
const PORT = 9245;
const profile = mkdtempSync(join(tmpdir(), "alnavi-1110-cdp-"));

// the app writes session/window/history state into the real config dir —
// back it up and restore afterwards so the E2E leaves no trace (ftp-sites.json
// holds the user's real servers and passwords)
const backedUp = [];
for (const f of ["session.json", "window.json", "dir-history.json", "xfer-history.json", "editor-state.json", "view-history.json", "ftp-sites.json"]) {
  const p = join(CFG, f);
  if (existsSync(p)) {
    cpSync(p, p + ".e2e-bak");
    backedUp.push(p);
  }
}
writeFileSync(join(CFG, "window.json"), JSON.stringify({ x: 80, y: 60, w: 1280, h: 800, maximized: false }));
writeFileSync(join(CFG, "ftp-sites.json"), JSON.stringify([
  { id: "e2e-mini", name: "Mini FTP", host: "127.0.0.1", port: FTP_PORT, user: "u", password: "p", hotkey: "5" },
  { id: "e2e-dead", name: "Dead port", host: "127.0.0.1", port: 1, user: "u", password: "p", hotkey: "R" },
]));
function restoreCfg() {
  for (const p of backedUp) cpSync(p + ".e2e-bak", p);
  const seeded = [join(CFG, "window.json"), join(CFG, "ftp-sites.json")];
  for (const p of seeded) if (!backedUp.includes(p) && existsSync(p)) rmSync(p);
}

// minimal FTP server: greeting + USER/PASS + TYPE + CWD + PASV + MLSD with a
// two-entry listing (enough for connect_session + list_remote)
function startFtp(port) {
  const listing = "type=dir;size=0;modify=20261003000000; pub\r\ntype=file;size=1234;modify=20261003000000; hello.txt\r\n";
  const server = net.createServer((sock) => {
    let dataServer = null;
    let dataSock = null;
    sock.write("220 mini ftp ready\r\n");
    sock.on("data", (buf) => {
      const line = buf.toString("latin1").trim();
      const sp = line.indexOf(" ");
      const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
      switch (cmd) {
        case "USER": sock.write("331 pass please\r\n"); break;
        case "PASS": sock.write("230 logged in\r\n"); break;
        case "TYPE": sock.write("200 type set\r\n"); break;
        case "SYST": sock.write("215 UNIX Type: L8\r\n"); break;
        case "FEAT": sock.write("500 no features\r\n"); break;
        case "PWD": sock.write("257 \"/\"\r\n"); break;
        case "CWD": sock.write("250 directory ok\r\n"); break;
        case "QUIT": sock.write("221 bye\r\n"); sock.end(); break;
        case "PASV": {
          if (dataServer) { try { dataServer.close(); } catch { /* already gone */ } }
          dataSock = null;
          dataServer = net.createServer();
          dataServer.once("connection", (d) => { dataSock = d; });
          dataServer.listen(0, "127.0.0.1", () => {
            const p = dataServer.address().port;
            sock.write(`227 (127,0,0,1,${p >> 8},${p & 255})\r\n`);
          });
          break;
        }
        case "MLSD":
        case "LIST": {
          const send = () => {
            sock.write("150 here it comes\r\n");
            dataSock.write(listing);
            dataSock.end();
            sock.write("226 transfer done\r\n");
          };
          if (dataSock) send();
          else dataServer?.once("connection", send);
          break;
        }
        default: sock.write("502 unknown command\r\n");
      }
    });
  });
  return new Promise((res) => server.listen(port, "127.0.0.1", () => res(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

async function launch() {
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
    detached: false,
  });
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && !t.url.startsWith("about:"));
      if (page) {
        const cdp = await connect(page.webSocketDebuggerUrl);
        await cdp.ready;
        await sleep(2500);
        return { child, cdp };
      }
    } catch { /* not up yet */ }
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
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  return {
    ready,
    send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); },
    close: () => ws.close(),
  };
}

async function evalIn(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}

async function key(cdp, k, opts = {}) {
  const base = {
    key: k,
    code: opts.code ?? k,
    windowsVirtualKeyCode: opts.keyCode,
    nativeVirtualKeyCode: opts.keyCode,
    modifiers: (opts.alt ? 1 : 0) | (opts.ctrl ? 2 : 0) | (opts.shift ? 8 : 0),
    ...(k === "Enter" ? { text: "\r" } : {}),
  };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

async function rowName(cdp) {
  return evalIn(cdp, `document.querySelector(".panel.active .vlist .row.cursor .name")?.getAttribute("title") ?? null`);
}
async function cursorTo(cdp, name, tries = 60) {
  for (let i = 0; i < 10 * tries; i++) {
    const cur = await rowName(cdp);
    if (cur === name) return true;
    await key(cdp, "ArrowDown", { keyCode: 40 });
    await sleep(60);
  }
  return false;
}
const dialogState = (cdp) => evalIn(cdp, `
  (() => {
    const rows = [...document.querySelectorAll('.dlg-body.drives .drive')].map((b) => ({
      name: b.querySelector(".d-name")?.textContent ?? "", key: b.querySelector(".jump-key")?.textContent ?? null,
    }));
    const sites = [...document.querySelectorAll('.dlg-body.list .li')].map((b) => ({
      name: b.querySelector(".ftp-name")?.textContent ?? "", key: b.querySelector(".jump-key")?.textContent ?? null,
    }));
    return {
      overlay: !!document.querySelector(".overlay"),
      sites,
      crumbs: document.querySelector(".panel.active .crumbs")?.textContent ?? "",
      errors: document.querySelector(".overlay .dlg-title")?.textContent ?? "",
      drives: rows,
    };
  })()
`);

let child = null;
let cdp = null;
let ftp = null;
try {
  ftp = await startFtp(FTP_PORT);
  console.log(`mini ftp on 127.0.0.1:${FTP_PORT}`);

  ({ child, cdp } = await launch());
  console.log("connected");

  // 1. version
  const ver = await evalIn(cdp, `document.querySelector(".version")?.textContent ?? ""`);
  check("1: version 1.11.0 in UI", /1\.11\.0/.test(ver ?? ""), ver);

  // 2. Alt+F1 opens the drive menu; the FTP row shows the assigned key chip
  await key(cdp, "F1", { keyCode: 112, alt: true, code: "F1" });
  await sleep(900);
  let st = await dialogState(cdp);
  check("2: drive menu open with FTP row + key chip 2",
    st.overlay && st.drives.some((d) => d.name === "FTP" && d.key === "2"),
    JSON.stringify(st.drives.map((d) => [d.name, d.key])));

  // 3. pressing 2 opens the FTP list with the seeded sites and their chips
  await key(cdp, "2", { keyCode: 0x32, code: "Digit2" });
  await sleep(700);
  st = await dialogState(cdp);
  check("3: key 2 opens the FTP list",
    st.sites.length === 2 && st.sites.some((s) => s.name === "Mini FTP" && s.key === "5") && st.sites.some((s) => s.name === "Dead port" && s.key === "R"),
    JSON.stringify(st.sites));

  // 4. site key 5 connects for real: panel lists the mini server
  await key(cdp, "5", { keyCode: 0x35, code: "Digit5" });
  await sleep(2500);
  st = await dialogState(cdp);
  check("4: site key 5 connected (dialog gone, panel on the server)",
    !st.overlay && st.crumbs.includes("127.0.0.1:2211"), `crumbs=${st.crumbs}`);
  check("4: server listing rendered",
    await cursorTo(cdp, "hello.txt"), `cursor=${await rowName(cdp)}`);

  // 5. site key R on a dead port lands in the error dialog (Esc closes)
  await key(cdp, "F1", { keyCode: 112, alt: true, code: "F1" });
  await sleep(700);
  await key(cdp, "2", { keyCode: 0x32, code: "Digit2" });
  await sleep(600);
  await key(cdp, "r", { keyCode: 0x52, code: "KeyR" });
  await sleep(2000);
  st = await dialogState(cdp);
  check("5: site key R on a dead port shows the error dialog",
    st.overlay && /FTP/i.test(st.errors), `title=${st.errors}`);
  await key(cdp, "Escape", { keyCode: 27 });
  await sleep(500);

  // 6. Enter on the highlighted site still connects (list activation regression)
  await key(cdp, "F1", { keyCode: 112, alt: true, code: "F1" });
  await sleep(600);
  await key(cdp, "2", { keyCode: 0x32, code: "Digit2" });
  await sleep(600);
  await key(cdp, "Enter", { keyCode: 13 });
  await sleep(2500);
  st = await dialogState(cdp);
  check("6: Enter on the highlighted site connects", !st.overlay && st.crumbs.includes("127.0.0.1:2211"), `crumbs=${st.crumbs}`);

  // 7. drive letters still jump: C selects C:\ (regression)
  await key(cdp, "F1", { keyCode: 112, alt: true, code: "F1" });
  await sleep(700);
  await key(cdp, "c", { keyCode: 0x43, code: "KeyC" });
  await sleep(1500);
  st = await dialogState(cdp);
  const crumbCompact = st.crumbs.replace(/\s+/g, "");
  check("7: letter C still switches the panel to C:\\", !st.overlay && (crumbCompact === "C:" || crumbCompact === "C:\\"), `crumbs=${JSON.stringify(st.crumbs)}`);

  // 8. back to panels, cmdline owns the caret
  const after = await evalIn(cdp, `(() => ({
    overlayGone: !document.querySelector(".overlay"),
    isCmd: document.activeElement === document.querySelector(".cmdline input"),
  }))()`);
  check("8: panels with the cmdline caret", after.overlayGone === true && after.isCmd === true, JSON.stringify(after));

  cdp.close();
} catch (e) {
  console.error("E2E error:", e);
  results.push({ name: "script completed", ok: false, info: String(e) });
} finally {
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  try { if (child) child.kill(); } catch { /* already gone */ }
  try { ftp?.close(); } catch { /* already gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  restoreCfg();
  process.exit(fails ? 1 : 0);
}
