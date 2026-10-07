// E2E for alnavi-014 (SFTP client) against the REAL released exe: same flow
// as the dev variant (see e2e-alnavi-014-flow.mjs) — local SFTP/FTP test
// servers spawned by the suite, real key presses, real backend.
// Usage: node scripts/e2e-alnavi-014-exe.mjs [path-to-Al-Navi.exe]
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSftpFlow, connect, evalIn, sleep } from "./e2e-alnavi-014-flow.mjs";
import { spawn } from "node:child_process";

const EXE = process.argv[2] ?? "C:\\Al-Navi\\Al-Navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}
const VERSION_PIN = "1.13.0";
const CDP_PORT = 9272;

const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const work = mkdtempSync(join(tmpdir(), "alnavi014exe-"));

// version pin: boot the exe once and read app_info
let failed = 0;
let child = null;
try {
  child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: mkdtempSync(join(tmpdir(), "alnavi014exe-v-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT + 50}` },
    stdio: "ignore",
  });
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT + 50}/json/list`).catch(() => ({ json: async () => [] }))).json();
    wsUrl = list.find(t => t.type === "page")?.webSocketDebuggerUrl ?? null;
    if (wsUrl) break;
    await sleep(300);
  }
  const cdp = connect(wsUrl);
  await cdp.ready;
  await sleep(2200);
  const ver = await evalIn(cdp, `window.__TAURI_INTERNALS__.invoke("app_info").then(v => v.version, () => "?")`);
  check(`release version is ${VERSION_PIN}`, ver === VERSION_PIN, String(ver));
  if (ver !== VERSION_PIN) failed = 1;
} catch (e) {
  check(`release version is ${VERSION_PIN}`, false, e.message);
  failed = 1;
} finally {
  if (child) child.kill();
  await sleep(800);
}

try {
  await runSftpFlow(EXE, { cdpPort: CDP_PORT, work, sftpPort: 2244, ftpPort: 2243, check });
} catch (e) {
  failed = 1;
  console.error("FLOW ERROR:", e.message);
}

for (const r of results) if (!r.ok) failed = 1;
console.log(`---`);
console.log(`${results.filter(r => r.ok).length}/${results.length} passed`);
process.exit(failed);
