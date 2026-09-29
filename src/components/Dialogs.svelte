<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { ops } from "$lib/stores/ops.svelte";
  import { panels } from "$lib/stores/panels.svelte";
  import { editor } from "$lib/stores/editor.svelte";
  import { cmdline } from "$lib/stores/cmdline.svelte";
  import { settings, THEMES, type ThemeId } from "$lib/stores/settings.svelte";
  import { LOCALES, type Locale } from "$lib/stores/i18n.svelte";
  import { drivesList, appInfo, type AppInfo } from "$lib/api";
  import { formatSize } from "$lib/format";
  import type { DriveInfo } from "$lib/types";

  let appVer = $state<AppInfo | null>(null);
  $effect(() => {
    if (ui.dialog === "menu" && !appVer) {
      appInfo().then((i) => (appVer = i)).catch(() => {});
    }
  });

  // generic focus helper
  function autofocus(node: HTMLElement) {
    setTimeout(() => node.focus(), 0);
  }

  // ---- confirm ----
  let confirmVal = $state(false);

  // ---- input ----
  let inputVal = $state("");
  $effect(() => {
    if (ui.inputReq) inputVal = ui.inputReq.value;
  });

  // ---- drives ----
  let drives = $state<DriveInfo[]>([]);
  $effect(() => {
    if (ui.dialog === "drives") {
      drivesList().then((d) => (drives = d)).catch(console.error);
    }
  });

  async function pickDrive(d: DriveInfo) {
    const panel = ui.drivesFor === "left" ? panels.left : panels.right;
    panels.activeSide = ui.drivesFor;
    await panel.chdir(d.mountPoint);
    panels.pushDirHistory(d.mountPoint);
    ui.closeDialog();
  }

  function driveIcon(kind: string): string {
    switch (kind) {
      case "removable": return "ph-usb";
      case "cd": return "ph-disc";
      case "network": return "ph-hard-drives";
      case "home": return "ph-house";
      case "root": return "ph-drives";
      default: return "ph-hard-drive";
    }
  }

  // ---- keyboard navigation for list dialogs (drives, F12 windows, histories)
  // FAR semantics: Left/Right also move the cursor (up/down) for fast walking
  const LIST_DIALOGS = new Set(["drives", "windowList", "dirHistory", "cmdHistory"]);
  let listIdx = $state(-1);

  function listCount(): number {
    switch (ui.dialog) {
      case "drives": return drives.length;
      case "windowList": return 1 + editor.docs.length + editor.viewDocs.length;
      case "dirHistory": return panels.dirHistory.length;
      case "cmdHistory": return cmdline.history.length;
      default: return 0;
    }
  }

  function activateListItem(i: number) {
    switch (ui.dialog) {
      case "drives":
        if (drives[i]) void pickDrive(drives[i]);
        break;
      case "windowList": {
        if (i === 0) {
          ui.setMode("panels");
          ui.closeDialog();
          return;
        }
        const d = i - 1;
        if (d < editor.docs.length) {
          editor.activate(editor.docs[d].id);
        } else {
          const v = editor.viewDocs[d - editor.docs.length];
          if (v) editor.activate(v.id);
        }
        ui.closeDialog();
        break;
      }
      case "dirHistory": {
        const p = panels.dirHistory[i];
        if (p !== undefined) {
          void panels.active.chdir(p);
          ui.closeDialog();
        }
        break;
      }
      case "cmdHistory": {
        const c = cmdline.history[i];
        if (c !== undefined) {
          cmdline.setText(c);
          ui.closeDialog();
          ui.cmdLineFocused = true;
        }
        break;
      }
    }
  }

  $effect(() => {
    void ui.dialog;
    void drives.length;
    void editor.docs.length;
    void editor.viewDocs.length;
    void panels.dirHistory.length;
    void cmdline.history.length;
    if (!LIST_DIALOGS.has(ui.dialog ?? "")) {
      if (listIdx !== -1) listIdx = -1;
      return;
    }
    const n = listCount();
    if (n && listIdx < 0) listIdx = 0;
    else if (n && listIdx > n - 1) listIdx = n - 1;
  });

  $effect(() => {
    if (LIST_DIALOGS.has(ui.dialog ?? "") && listIdx >= 0) {
      document.querySelector(".drive.kbd, .li.kbd")?.scrollIntoView({ block: "nearest" });
    }
  });

  // visible items in the dialog list, measured live (for block jumps)
  function listPageStep(): number {
    const item =
      document.querySelector<HTMLElement>(".drive.kbd") ??
      document.querySelector<HTMLElement>(".li.kbd") ??
      document.querySelector<HTMLElement>(".dlg-body .drive") ??
      document.querySelector<HTMLElement>(".dlg-body .li");
    const body = item?.closest<HTMLElement>(".dlg-body");
    if (!item || !body || !item.offsetHeight) return 8;
    return Math.max(1, Math.floor(body.clientHeight / item.offsetHeight) - 1);
  }

  function onListKey(e: KeyboardEvent) {
    if (!LIST_DIALOGS.has(ui.dialog ?? "")) return;
    const n = listCount();
    if (!n) return;
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        listIdx = listIdx < 0 ? 0 : (listIdx + 1) % n;
        break;
      case "ArrowUp":
        listIdx = listIdx < 0 ? 0 : (listIdx - 1 + n) % n;
        break;
      // block walking: jump by a visible page, clamped (no wrap)
      case "ArrowRight": {
        const s = listPageStep();
        listIdx = listIdx < 0 ? 0 : Math.min(n - 1, listIdx + s);
        break;
      }
      case "ArrowLeft": {
        const s = listPageStep();
        listIdx = listIdx < 0 ? 0 : Math.max(0, listIdx - s);
        break;
      }
      case "Home":
        listIdx = 0;
        break;
      case "End":
        listIdx = n - 1;
        break;
      case "Enter":
        if (listIdx >= 0) activateListItem(listIdx);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  // ---- input submit ----
  function submitInput() {
    ui.inputReq?.resolve(inputVal);
  }

  function closeInput() {
    ui.inputReq?.resolve(null);
  }

  // progress helpers
  function pct(op: { bytesDone: number; bytesTotal: number }): number {
    if (!op.bytesTotal) return 0;
    return Math.min(100, Math.round((op.bytesDone / op.bytesTotal) * 100));
  }
</script>

<svelte:window onkeydown={onListKey} />

{#if ui.dialog === "confirm" && ui.confirmReq}
  <div class="overlay">
    <div class="dlg" role="alertdialog">
      <div class="dlg-title"><i class="ph-duotone ph-question"></i>{i18n.t("common.ok")}</div>
      <div class="dlg-body">{ui.confirmReq.message}</div>
      <div class="dlg-actions">
        <button class="btn" onclick={() => ui.confirmReq!.resolve(false)}>{i18n.t("common.no")}</button>
        <button class="btn primary" onclick={() => ui.confirmReq!.resolve(true)}>{i18n.t("common.yes")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "input" && ui.inputReq}
  <div class="overlay">
    <div class="dlg" role="dialog">
      <div class="dlg-title"><i class="ph-duotone ph-pencil-simple"></i>{ui.inputReq.title}</div>
      <form class="dlg-body" onsubmit={(e) => { e.preventDefault(); submitInput(); }}>
        <label class="lbl">{ui.inputReq.prompt}</label>
        <input bind:value={inputVal} use:autofocus spellcheck="false" style="width:100%" />
      </form>
      <div class="dlg-actions">
        <button class="btn" onclick={closeInput}>{i18n.t("common.cancel")}</button>
        <button class="btn primary" onclick={submitInput}>{i18n.t("common.ok")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "progress" && ops.op}
  <div class="overlay" style="align-items:flex-end; padding-bottom: 90px; justify-content:flex-start; padding-inline-start: 16px;">
    <div class="dlg" style="min-width: 460px">
      <div class="dlg-title">
        <i class="ph-duotone ph-arrows-clockwise"></i>
        {ops.op.title}
        {#if ops.op.phase === "done"}
          <span class="badge" class:ok={!ops.op.cancelled && !ops.op.errors.length} class:err={ops.op.cancelled || ops.op.errors.length}>
            {ops.op.cancelled ? i18n.t("ops.cancelled") : ops.op.errors.length ? i18n.t("ops.errors", { n: ops.op.errors.length }) : i18n.t("ops.done")}
          </span>
        {/if}
      </div>
      <div class="dlg-body">
        {#if ops.op.phase === "scan"}
          <div class="scan">{i18n.t("ops.scanning")}</div>
        {:else}
          <div class="bar">
            <div class="fill" style="width:{pct(ops.op)}%"></div>
          </div>
          <div class="prow">
            <span class="mono">{pct(ops.op)}%</span>
            <span class="mono">{formatSize(ops.op.bytesDone)} / {formatSize(ops.op.bytesTotal)}</span>
            {#if ops.op.speed}<span class="mono dim">{formatSize(ops.op.speed)}/s</span>{/if}
          </div>
          <div class="pfiles mono">
            {ops.op.filesDone} / {ops.op.filesTotal}
          </div>
          {#if ops.op.current}
            <div class="cur" title={ops.op.current}>{ops.op.current}</div>
          {/if}
        {/if}
        {#if ops.op.errors.length}
          <div class="errs">
            {#each ops.op.errors.slice(0, 6) as er}
              <div class="err"><i class="ph ph-warning-circle"></i> {er.path}: {er.error}</div>
            {/each}
          </div>
        {/if}
      </div>
      <div class="dlg-actions">
        {#if ops.op.phase !== "done"}
          <button class="btn" onclick={() => ops.pauseOrResume()}>
            {ops.op.paused ? i18n.t("ops.resume") : i18n.t("ops.pause")}
          </button>
          <button class="btn" onclick={() => ops.toBackground()}>{i18n.t("ops.background")}</button>
          <button class="btn danger" onclick={() => ops.cancel()}>{i18n.t("ops.cancel")}</button>
        {:else}
          <button class="btn primary" onclick={() => ops.finishOp()}>{i18n.t("common.close")}</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "conflict" && ops.conflict}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title warn"><i class="ph-duotone ph-warning"></i>{i18n.t("ops.conflict")}</div>
      <div class="dlg-body">
        <div class="conf-row"><span class="lbl">{i18n.t("ops.src")}:</span><span class="mono path">{ops.conflict.src}</span></div>
        <div class="conf-row"><span class="lbl">{i18n.t("ops.dst")}:</span><span class="mono path">{ops.conflict.dst}</span></div>
      </div>
      <div class="dlg-actions wrap">
        <button class="btn primary" onclick={() => ops.resolveConflictAction("overwrite")}>{i18n.t("ops.copy")} ↩</button>
        <button class="btn" onclick={() => ops.resolveConflictAction("overwrite_all")}>{i18n.t("common.all")}</button>
        <button class="btn" onclick={() => ops.resolveConflictAction("skip")}>{i18n.t("common.cancel")}</button>
        <button class="btn" onclick={() => ops.resolveConflictAction("skip_all")}>↷ {i18n.t("common.all")}</button>
        <button class="btn" onclick={() => ops.resolveConflictAction("rename")}>{i18n.t("ops.rename")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "drives"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title">
        <i class="ph-duotone ph-hard-drives"></i>
        {i18n.t("drives.title")} — {ui.drivesFor === "left" ? i18n.t("windows.panels") + " 1" : i18n.t("windows.panels") + " 2"}
      </div>
      <div class="dlg-body drives">
        {#each drives as d, i (d.mountPoint)}
          <button class="drive" class:kbd={i === listIdx} onclick={() => void pickDrive(d)}>
            <i class="ph-duotone {driveIcon(d.kind)}"></i>
            <span class="d-name" title={d.mountPoint}>{d.name}</span>
            {#if d.totalBytes}
              <span class="d-free mono">{formatSize(d.freeBytes)} {i18n.t("panel.free")}</span>
            {/if}
          </button>
        {/each}
      </div>
      <div class="dlg-actions">
        <button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "windowList"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title"><i class="ph-duotone ph-squares-four"></i>F12</div>
      <div class="dlg-body list">
        <button
          class="li"
          class:kbd={listIdx === 0}
          class:on={ui.mode === 'panels' ? true : false}
          onclick={() => { ui.setMode("panels"); ui.closeDialog(); }}
        >
          <i class="ph-duotone ph-squares-four"></i>{i18n.t("windows.panels")}
        </button>
        {#each editor.docs as d, i (d.id)}
          <button
            class="li"
            class:kbd={listIdx === 1 + i}
            class:on={ui.mode === "editor" && editor.activeId === d.id}
            onclick={() => { editor.activate(d.id); ui.closeDialog(); }}
          >
            <i class="ph-duotone ph-note-pencil"></i>{d.name}{#if d.dirty} •{/if}
          </button>
        {/each}
        {#each editor.viewDocs as d, i (d.id)}
          <button
            class="li"
            class:kbd={listIdx === 1 + editor.docs.length + i}
            class:on={ui.mode === "viewer" && editor.activeViewId === d.id}
            onclick={() => { editor.activate(d.id); ui.closeDialog(); }}
          >
            <i class="ph-duotone ph-eye"></i>{d.name}
          </button>
        {/each}
        {#if !editor.docs.length && !editor.viewDocs.length}
          <div class="none">{i18n.t("windows.none")}</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "dirHistory"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title"><i class="ph-duotone ph-clock-counter-clockwise"></i>{i18n.t("history.dirs")}</div>
      <div class="dlg-body list">
        {#each panels.dirHistory as p, i (p)}
          <button
            class="li mono"
            class:kbd={listIdx === i}
            onclick={() => { void panels.active.chdir(p); ui.closeDialog(); }}
          >
            <i class="ph-duotone ph-folder-simple"></i>{p}
          </button>
        {:else}
          <div class="none">{i18n.t("common.none")}</div>
        {/each}
      </div>
      <div class="dlg-actions"><button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button></div>
    </div>
  </div>
{/if}

{#if ui.dialog === "cmdHistory"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title"><i class="ph-duotone ph-terminal-window"></i>{i18n.t("history.cmds")}</div>
      <div class="dlg-body list">
        {#each cmdline.history as c, i (c)}
          <button
            class="li mono"
            class:kbd={listIdx === i}
            onclick={() => { cmdline.setText(c); ui.closeDialog(); ui.cmdLineFocused = true; }}
          >
            <i class="ph-duotone ph-terminal-window"></i>{c}
          </button>
        {:else}
          <div class="none">{i18n.t("common.none")}</div>
        {/each}
      </div>
      <div class="dlg-actions"><button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button></div>
    </div>
  </div>
{/if}

{#if ui.dialog === "menu"}
  <div class="overlay">
    <div class="dlg" style="min-width:340px">
      <div class="dlg-title"><i class="ph-duotone ph-list"></i>{i18n.t("fkeys.f9")}</div>
      <div class="dlg-body">
        <div class="grp">{i18n.t("menu.themes")}</div>
        <div class="theme-grid">
          {#each THEMES as th (th.id)}
            <button
              class="btn thmb"
              class:on={settings.s.theme === th.id}
              onclick={() => settings.set({ theme: th.id as ThemeId })}
            >
              <span class="swatch" data-theme={th.id}></span>
              {i18n.t("theme." + th.id)}
            </button>
          {/each}
        </div>

        <div class="grp">{i18n.t("menu.language")}</div>
        <div class="lang-grid">
          {#each LOCALES as l (l.id)}
            <button class="btn lang" class:on={settings.s.locale === l.id} onclick={() => settings.set({ locale: l.id as Locale })}>
              {l.label}
            </button>
          {/each}
        </div>

        {#if appVer}
          <div class="about mono">
            {i18n.t("menu.about")} — v{appVer.version}
            <span class="dim">· {appVer.buildTime}</span>
          </div>
        {/if}
      </div>
      <div class="dlg-actions">
        <button class="btn" onclick={() => { void import("$lib/commands").then(({runCommand}) => runCommand("app.quit")); }}>
          <i class="ph ph-sign-out"></i>{i18n.t("menu.quit")}
        </button>
        <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "errors" && ui.errorText}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title err-t"><i class="ph-duotone ph-warning-octagon"></i>{i18n.t("errors.access")}</div>
      <div class="dlg-body mono err-body">{ui.errorText}</div>
      <div class="dlg-actions">
        <button class="btn primary" onclick={() => { ui.errorText = null; ui.closeDialog(); }}>{i18n.t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .lbl { display: block; color: var(--fg-dim); margin-bottom: 6px; font-size: 12.5px; }

  .scan { color: var(--fg-dim); padding: 8px 0; }

  .bar {
    height: 12px;
    border-radius: 6px;
    background: var(--bg);
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 55%, var(--accent2)));
    transition: width 0.15s;
  }
  .prow { display: flex; gap: 14px; margin-top: 7px; font-size: 12px; color: var(--fg-dim); }
  .pfiles { font-size: 11.5px; color: var(--fg-muted); margin-top: 2px; }
  .cur {
    margin-top: 8px;
    font-size: 11.5px;
    color: var(--fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: ltr;
    font-family: "JetBrains Mono", monospace;
  }
  .badge {
    margin-inline-start: auto;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--row-hover);
    color: var(--fg-dim);
  }
  .badge.ok { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .badge.err { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
  .errs { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
  .err { font-size: 11.5px; color: var(--danger); word-break: break-all; }

  .dlg-title.warn { color: var(--accent2); }
  .dlg-title.err-t { color: var(--danger); }
  .conf-row { display: flex; gap: 10px; margin-bottom: 8px; font-size: 12px; align-items: baseline; }
  .conf-row .lbl { margin: 0; min-width: 90px; color: var(--fg-dim); }
  .conf-row .path { word-break: break-all; direction: ltr; }
  .dlg-actions.wrap { flex-wrap: wrap; justify-content: center; }

  .drives { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px; }
  .drive {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 12px;
    border-radius: 9px;
    border: 1px solid var(--border);
    background: var(--bg);
    text-align: start;
  }
  .drive:hover { border-color: var(--accent); }
  .drive i { font-size: 22px; color: var(--accent); }
  .drive.kbd {
    border-color: var(--accent2);
    background: color-mix(in srgb, var(--accent2) 10%, var(--bg-panel));
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent2) 55%, transparent);
  }
  .d-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .d-free { font-size: 10.5px; color: var(--fg-muted); }

  .list { display: flex; flex-direction: column; gap: 2px; min-width: 380px; }
  .li {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 10px;
    border-radius: 7px;
    color: var(--fg-dim);
    text-align: start;
    font-size: 12.5px;
  }
  .li:hover { background: var(--row-hover); color: var(--fg); }
  .li.on { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--fg); }
  .li i { font-size: 17px; color: var(--accent); }
  .li.kbd {
    background: color-mix(in srgb, var(--accent2) 10%, transparent);
    color: var(--fg);
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent2) 55%, transparent);
  }
  .none { color: var(--fg-muted); text-align: center; padding: 14px; }

  .grp { color: var(--fg-muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.6px; margin: 12px 0 8px; }
  .grp:first-child { margin-top: 0; }
  .theme-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .lang-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
  .thmb, .lang { justify-content: flex-start; padding: 7px 10px; font-size: 12.5px; }
  .thmb.on, .lang.on { border-color: var(--accent); color: var(--fg); }

  .about {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--fg-dim);
  }
  .about .dim { color: var(--fg-muted); }
  .swatch {
    width: 16px; height: 16px;
    border-radius: 5px;
    border: 1px solid var(--border-strong);
    background: #141619;
  }
  .swatch[data-theme="alnaviLight"] { background: #f4f5f7; }
  .swatch[data-theme="midnight"] { background: #0b1220; }
  .swatch[data-theme="solarized"] { background: #fdf6e3; }
  .swatch[data-theme="contrast"] { background: #000; }

  .err-body { white-space: pre-wrap; word-break: break-all; font-size: 12px; }
</style>
