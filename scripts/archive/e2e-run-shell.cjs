// Real-exe E2E for 1.9.2: Ctrl+O toggle + command line execution.
// Drives the built exe over CDP (launched by the caller with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=$CDP_PORT
// and an isolated WEBVIEW2_USER_DATA_FOLDER).
// Usage: node scripts/e2e-run-shell.cjs [cdpPort]
const fs = require("fs");

const CDP_PORT = parseInt(process.argv[2] || "9223", 10);
const MARKER = "D:/Al-Navi/.e2e-marker.txt";
const CWDLOG = "D:/Al-Navi/.e2e-cwd.txt";
const PSMARK = "D:/Al-Navi/.e2e-ps.txt";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(150);
  }
}

async function main() {
  // 1. CDP endpoint
  const targets = await waitFor(async () => {
    try {
      return await (
        await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      ).json();
    } catch {
      return null;
    }
  }, 20000, "CDP endpoint");
  const page = targets.find((t) => t.type === "page" && t.url !== "about:blank");
  if (!page) throw new Error("no page target: " + JSON.stringify(targets.map((t) => t.type + ":" + t.url)));

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error("ws error"));
    setTimeout(() => rej(new Error("ws connect timeout")), 10000);
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.result?.exceptionDetails)
      throw new Error("page exception: " + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails));
    return r.result?.result?.value;
  };

  const results = [];
  const check = (name, ok, extra = "") => {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  };

  const panelsClass = () =>
    evaluate(
      `document.querySelector('.panels')?.className.includes('none') ? 'hidden' : 'visible'`
    );
  const pressCtrl = (key, code) =>
    evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', code: '${code}', ctrlKey: true, bubbles: true, cancelable: true }))`
    );
  const runCmdline = (line) =>
    evaluate(`(() => {
      const inp = document.querySelector('.cmdline input') || document.querySelector('input');
      if (!inp) return 'no input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(line)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return 'sent';
    })()`);

  // wait for the app shell to render
  await waitFor(
    () => evaluate(`document.querySelector('.panels') ? true : false`),
    15000,
    "app render"
  );

  // ---- t1: Ctrl+O toggle ----
  await pressCtrl("p", "KeyP");
  await sleep(150);
  const t1a = await panelsClass();
  await pressCtrl("o", "KeyO");
  await sleep(150);
  const t1b = await panelsClass();
  await pressCtrl("o", "KeyO");
  await sleep(150);
  const t1c = await panelsClass();
  check("Ctrl+O hides panels", t1a === "visible" && t1b === "hidden", `${t1a} -> ${t1b}`);
  check("Ctrl+O brings panels back", t1c === "visible", t1c);

  // panel paths shown in the DOM (both panels' crumbs titles)
  const panelTitles = await evaluate(
    `[...document.querySelectorAll('.crumbs')].map(c => c.title)`
  );

  // ---- t2: command line executes (relative marker + %CD% log; exit skips pause) ----
  for (const f of [MARKER, CWDLOG, PSMARK]) {
    try { fs.unlinkSync(f); } catch {}
  }
  const sent2 = await runCmdline(
    "echo alnavi-e2e> D:/Al-Navi/.e2e-marker.txt & (echo %CD%)> D:/Al-Navi/.e2e-cwd.txt & exit"
  );
  const marker = await waitFor(
    () => (fs.existsSync(MARKER) ? fs.readFileSync(MARKER, "utf8").trim() : null),
    12000,
    "marker file"
  );
  check("cmdline command executed (marker file)", sent2 === "sent" && marker === "alnavi-e2e", marker);

  const cwdlog = await waitFor(
    () => (fs.existsSync(CWDLOG) ? fs.readFileSync(CWDLOG, "utf8").trim() : null),
    8000,
    "cwd log"
  );
  const cwdIsLocal = /^[A-Za-z]:\\/.test(cwdlog || "");
  const cwdMatchesPanel = cwdIsLocal && (panelTitles || []).some((t) => t === cwdlog);
  check("cwd = active panel directory", cwdMatchesPanel, `cwd=${cwdlog} panels=${JSON.stringify(panelTitles)}`);

  // ---- t3: powershell actually runs (writes via PS itself, then instant exit) ----
  const sent3 = await runCmdline(
    "powershell -NoProfile -Command Set-Content D:/Al-Navi/.e2e-ps.txt ps-ok & exit"
  );
  const ps = await waitFor(
    () => (fs.existsSync(PSMARK) ? fs.readFileSync(PSMARK, "utf8").trim() : null),
    12000,
    "powershell marker"
  );
  check("powershell executed from cmdline", sent3 === "sent" && ps === "ps-ok", ps);

  // app still alive and responsive
  const alive = await evaluate("2 + 2");
  check("app responsive after commands", alive === 4);

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
  ws.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E ERROR:", e.message);
  process.exit(2);
});
