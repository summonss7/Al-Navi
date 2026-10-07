// E2E for alnavi-014 (SFTP client) against the DEBUG exe + vite dev server:
// spawns vite (if not running), the local SFTP/FTP test servers and drives
// the real backend with real key presses. See e2e-alnavi-014-flow.mjs for
// the covered flow.
// Usage: node scripts/e2e-alnavi-014-dev.mjs [path-to-debug-exe]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSftpFlow, sleep } from "./e2e-alnavi-014-flow.mjs";

const EXE = process.argv[2] ?? "D:\\Al-Navi\\src-tauri\\target\\debug\\al-navi.exe";
if (!existsSync(EXE)) {
  console.error(`exe not found: ${EXE}`);
  process.exit(1);
}

// vite dev server for the debug exe's devUrl
let vite = null;
if (!(await fetch("http://localhost:1420/").then(() => true, () => false))) {
  vite = spawn("npm", ["run", "dev"], { stdio: "ignore", shell: true });
  for (let i = 0; i < 60; i++) {
    if (await fetch("http://localhost:1420/").then(() => true, () => false)) break;
    await sleep(500);
  }
}

const results = [];
const check = (name, ok, info = "") => {
  results.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
};
const work = mkdtempSync(join(tmpdir(), "alnavi014dev-"));
let failed = 0;
try {
  await runSftpFlow(EXE, { cdpPort: 9271, work, sftpPort: 2242, ftpPort: 2241, check });
} catch (e) {
  failed = 1;
  console.error("FLOW ERROR:", e.message);
} finally {
  if (vite) vite.kill();
}

for (const r of results) if (!r.ok) failed = 1;
console.log(`---`);
console.log(`${results.filter(r => r.ok).length}/${results.length} passed`);
process.exit(failed);
