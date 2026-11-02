<script lang="ts">
  // Ctrl+L: FAR-style info about the volume holding the active panel's cwd,
  // plus machine-wide RAM/swap. Read-only — the only action is OK/Esc.
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { panels } from "$lib/stores/panels.svelte";
  import { driveInfo } from "$lib/api";
  import { formatSize } from "$lib/format";
  import type { VolumeInfo } from "$lib/types";

  let info = $state<VolumeInfo | null>(null);
  let error = $state(false);

  // reload on every open — figures change while the dialog is closed
  $effect(() => {
    if (ui.dialog !== "driveInfo") return;
    info = null;
    error = false;
    driveInfo(panels.active.path)
      .then((v) => (info = v))
      .catch(() => (error = true));
  });

  const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : 0);
</script>

<div class="overlay">
  <div class="dlg" role="dialog">
    <div class="dlg-title"><i class="ph-duotone ph-hard-drives"></i>{i18n.t("driveInfo.title")}</div>
    <div class="dlg-body">
      {#if error}
        <div class="lbl">{i18n.t("driveInfo.loadError")}</div>
      {:else if !info}
        <div class="lbl">{i18n.t("driveInfo.loading")}</div>
      {:else}
        {#if info.mountPoint}
          <div class="sec">{i18n.t("driveInfo.volume")}</div>
          <div class="row"><span>{i18n.t("driveInfo.label")}</span><b>{info.label || "—"}</b></div>
          <div class="row"><span>{i18n.t("driveInfo.type")}</span><b>{i18n.t(`driveInfo.kind.${info.kind}`)}</b></div>
          <div class="row"><span>{i18n.t("driveInfo.fs")}</span><b>{info.fileSystem || "—"}</b></div>
          <div class="row"><span>{i18n.t("driveInfo.mount")}</span><b>{info.mountPoint}</b></div>
          <div class="row"><span>{i18n.t("driveInfo.total")}</span><b>{formatSize(info.totalBytes)}</b></div>
          <div class="row"><span>{i18n.t("driveInfo.used")}</span>
            <b>{formatSize(info.usedBytes)} ({pct(info.usedBytes, info.totalBytes)}%)</b></div>
          <div class="row"><span>{i18n.t("driveInfo.free")}</span>
            <b>{formatSize(info.freeBytes)} ({100 - pct(info.usedBytes, info.totalBytes)}%)</b></div>
          <div class="bar" title="{pct(info.usedBytes, info.totalBytes)}%">
            <i style="width:{pct(info.usedBytes, info.totalBytes)}%"></i>
          </div>
        {:else}
          <div class="sec">{i18n.t("driveInfo.volume")}</div>
          <div class="lbl dim">{i18n.t("driveInfo.none")}</div>
        {/if}
        <div class="sec">{i18n.t("driveInfo.memory")}</div>
        <div class="row"><span>{i18n.t("driveInfo.total")}</span><b>{formatSize(info.memory.totalBytes)}</b></div>
        <div class="row"><span>{i18n.t("driveInfo.used")}</span>
          <b>{formatSize(info.memory.usedBytes)} ({pct(info.memory.usedBytes, info.memory.totalBytes)}%)</b></div>
        <div class="row"><span>{i18n.t("driveInfo.free")}</span><b>{formatSize(info.memory.freeBytes)}</b></div>
        <div class="row">
          <span>{i18n.t("driveInfo.swap")}</span>
          <b>{formatSize(info.memory.swapTotalBytes)} ({i18n.t("driveInfo.swapUsed")}: {formatSize(info.memory.swapUsedBytes)})</b>
        </div>
      {/if}
    </div>
    <div class="dlg-actions">
      <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.ok")}</button>
    </div>
  </div>
</div>

<style>
  .sec {
    margin: 4px 0 6px;
    font-size: 0.82em;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent-ink);
  }
  .dlg-body > .sec:not(:first-child) {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 32px;
    padding: 2px 0;
    font-size: 0.95em;
  }
  .row span {
    color: var(--fg-dim);
  }
  .dim {
    color: var(--fg-dim);
  }
  .bar {
    margin: 8px 0 2px;
    height: 10px;
    border-radius: 5px;
    background: var(--border);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 5px;
  }
</style>
