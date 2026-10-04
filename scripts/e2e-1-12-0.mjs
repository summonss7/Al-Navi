// E2E for 1.12.0 (M8 installer, alnavi-010/alnavi-007) — verifies the Inno
// Setup package end-to-end on this machine, as a per-user install:
//   1. /VERYSILENT install -> exe in %LOCALAPPDATA%\Programs\Al-Navi,
//      Desktop + Start Menu shortcuts, HKCU uninstall entry with version;
//   2. the INSTALLED app launches and shows v1.12.0 · <build time> in its
//      custom title bar (read via CDP like other release E2E);
//   3. uninstaller /VERYSILENT -> app dir, shortcuts and registry entry gone.
// The app's real config (%APPDATA%\al-navi) is backed up and restored.
// Usage: node scripts/e2e-1-12-0.mjs <path-to-Al-Navi-Setup-....exe>
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, cpSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const setup = process.argv[2];
if (!setup || !existsSync(setup)) {
  console.error("usage: node scripts/e2e-1-12-0.mjs <path-to-Al-Navi-Setup-....exe>");
  process.exit(1);
}

const APP_DIR = join(process.env.LOCALAPPDATA, "Programs", "Al-Navi");
const APP_EXE = join(APP_DIR, "Al-Navi.exe");
const CFG = join(process.env.APPDATA, "al-navi");
const UNINST_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{8B1A5C39-6D2E-4F8A-9C4B-7E3A1D5F0B62}_is1";
const CDP_PORT = 9255;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};

// resolve Desktop / Start Menu\Programs and read the HKCU uninstall entry
function ps(script) {
  return new Promise((resolve) => {
    const out = [];
    const ch = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: ["ignore", "pipe", "pipe"] });
    ch.stdout.on("data", (d) => out.push(d));
    ch.on("close", () => { try { resolve(JSON.parse(out.join("").trim())); } catch { resolve(null); } });
  });
}
const folders = () => ps(
  "[Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs') | ConvertTo-Json"
).then((r) => Array.isArray(r) ? r : [r?.Desktop ?? r]);
const regEntry = () => ps(
  `try { (Get-ItemProperty -Path '${UNINST_KEY}' -ErrorAction Stop) ` +
  `| Select-Object DisplayName, DisplayVersion, UninstallString | ConvertTo-Json -Compress } catch { 'null' }`
).then((r) => (r === "null" || r === undefined ? null : r));

// the app writes session/window state into the real config dir — back it up
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

function run(cmd, args) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { stdio: "ignore" });
    ch.on("close", (code) => resolve(code));
    ch.on("error", () => resolve(-1));
  });
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

try {
  // -- phase 1: silent per-user install
  const code = await run(setup, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]);
  check("setup exits 0 (silent, no UAC)", code === 0, `exit=${code}`);
  check("installed exe present", existsSync(APP_EXE), APP_EXE);

  const [desktop, programs] = await folders();
  const deskLnk = join(desktop, "Al-Navi.lnk");
  const smLnk = join(programs, "Al-Navi", "Al-Navi.lnk");
  check("desktop shortcut", existsSync(deskLnk), deskLnk);
  check("start menu shortcut", existsSync(smLnk), smLnk);

  const reg = await regEntry();
  check("HKCU uninstall entry", !!reg?.UninstallString, `${reg?.DisplayName} ${reg?.DisplayVersion}`);
  check("uninstall entry version is 1.12.0", reg?.DisplayVersion === "1.12.0", reg?.DisplayVersion ?? "(none)");

  // -- phase 2: the installed app runs and shows its version in the title bar
  const profile = mkdtempSync(join(tmpdir(), "alnavi-1120-"));
  const child = spawn(APP_EXE, [], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
    stdio: "ignore",
  });
  let wsUrl = null;
  for (let i = 0; i < 30; i++) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => ({ json: async () => [] }))).json();
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    if (wsUrl) break;
    await sleep(500);
  }
  check("installed app launches (CDP target up)", !!wsUrl);
  let versionText = "";
  if (wsUrl) {
    const cdp = connect(wsUrl);
    await cdp.ready;
    for (let i = 0; i < 20; i++) {
      versionText = await evalIn(cdp, `document.querySelector('.version')?.textContent ?? ''`);
      if (versionText.includes("1.12.0")) break;
      await sleep(500);
    }
    cdp.close();
  }
  check("title bar shows v1.12.0 · <build time>", /1\.12\.0\s*·/.test(versionText), JSON.stringify(versionText.trim()));
  await run("taskkill", ["/IM", "Al-Navi.exe", "/F"]);
  await sleep(1000);
  rmSync(profile, { recursive: true, force: true });

  // -- phase 3: silent uninstall cleans everything
  const un = reg?.UninstallString?.replace(/"/g, "");
  check("uninstaller path known", !!un && existsSync(un), un ?? "(none)");
  if (un) {
    const ucode = await run(un, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]);
    check("uninstaller exits 0", ucode === 0, `exit=${ucode}`);
    await sleep(1500);
    check("app dir removed", !existsSync(APP_DIR), APP_DIR);
    check("desktop shortcut removed", !existsSync(deskLnk));
    check("start menu folder removed", !existsSync(join(programs, "Al-Navi")));
    const reg2 = await regEntry();
    check("HKCU uninstall entry removed", reg2 === null || !reg2?.UninstallString);
  }
} finally {
  restoreCfg();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nALL ${results.length} PASS` : `\n${failed}/${results.length} FAILED`);
process.exit(failed === 0 ? 0 : 1);
