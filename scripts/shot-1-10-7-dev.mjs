// Screenshot helper for 1.10.7: opens the copy progress dialog over the real
// app shell and captures a PNG (visual check of the centering).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1420, CDP_PORT = 9241, ORIGIN = `http://localhost:${PORT}`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(join(tmpdir(), "alnavi-shot-1107-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = await fetch(`${ORIGIN}/`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
const ours = alive && alive.includes("Al-Navi") ? null : spawn("npm", ["run", "dev"], { shell: true, stdio: "ignore" });
const edge = spawn(EDGE, ["--headless=new","--disable-gpu","--no-first-run",`--remote-debugging-port=${CDP_PORT}`,`--user-data-dir=${profile}`,"--window-size=1280,800","about:blank"],{stdio:"ignore"});
async function waitFor(fn, ms, label){const t0=Date.now();for(;;){const v=await fn().catch(()=>null);if(v)return v;if(Date.now()-t0>ms)throw new Error("timeout "+label);await sleep(250);}}
function connect(wsUrl){const ws=new WebSocket(wsUrl);let seq=0;const pending=new Map();ws.onmessage=(ev)=>{const msg=JSON.parse(ev.data);if(msg.id&&pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id);}};const ready=new Promise((res,rej)=>{ws.onopen=()=>res();ws.onerror=()=>rej(new Error("ws error"));});return {ready,send(method,params={}){return new Promise((resolve)=>{const id=++seq;pending.set(id,resolve);ws.send(JSON.stringify({id,method,params}));});},close:()=>ws.close()};}
try {
  await waitFor(()=>fetch(`${ORIGIN}/`).then((r)=>(r.ok?true:null)),30000,"vite");
  const list = await waitFor(async()=>(await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t=>t.type==="page"),20000,"cdp");
  const cdp = await connect(list.webSocketDebuggerUrl); await cdp.ready;
  await cdp.send("Page.navigate",{url:`${ORIGIN}/`}); await sleep(2500);
  await cdp.send("Runtime.evaluate",{expression:`
    (async () => {
      const imp = new Function("u", "return import(u)");
      const base = "${ORIGIN}/src/lib/";
      const src = await (await fetch(base + "register-commands.ts")).text();
      const u = (re) => new URL(src.match(re)[1], base).href;
      const { ops } = await imp(u(/from\\s+"([^"]*stores\\/ops\\.svelte\\.ts[^"]*)"/));
      const { ui } = await imp(u(/from\\s+"([^"]*stores\\/ui\\.svelte\\.ts[^"]*)"/));
      window.__e2e = { ops, ui };
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__TAURI_INTERNALS__.invoke = () => Promise.resolve(null);
      ops.op = { id: 1, title: "Копирование", phase: "copy", bytesDone: 1048576, bytesTotal: 4194304,
        filesDone: 2, filesTotal: 7, current: "D:\\E2E-1107\\big-file.bin", speed: 5242880,
        cancelled: false, errors: [], paused: false };
      ui.openDialog("progress");
      return true;
    })()`, returnByValue:true, awaitPromise:true});
  await sleep(600);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  if (!shot?.result?.data) { console.error("captureScreenshot returned:", JSON.stringify(shot).slice(0, 300)); process.exit(1); }
  const { writeFileSync } = await import("node:fs");
  writeFileSync("D:\\Al-Navi\\builds\\shot-1107-progress-centered.png", Buffer.from(shot.result.data, "base64"));
  console.log("saved");
} catch (e) { console.error("FAILED:", e); } finally { edge.kill(); if (ours) ours.kill(); process.exit(0); }
