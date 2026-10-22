<script lang="ts">
  // Update dialog (alnavi-039): the outcome of a manifest check —
  // «✓ последняя версия» / «⬆ доступна X» with notes and «Обновить», the
  // download progress bar, or the degraded error state. Opened by the F9
  // «Проверить обновления» button or automatically when the silent startup
  // check finds a newer version.
  import { update } from "$lib/stores/update.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { ui } from "$lib/stores/ui.svelte";

  const mb = (n: number) => (n / 1048576).toFixed(1);
  const pct = $derived(update.total ? Math.min(100, Math.round((update.downloaded / update.total) * 100)) : 0);
  // the manifest notes are markdown (a CHANGELOG entry): show headings and
  // bullets as plain text instead of raw #-and-dash soup
  const prettyNotes = $derived(
    (update.notes ?? "")
      .replace(/^#{1,6}[ \t]*/gm, "")
      .replace(/^-[ \t]+/gm, "• ")
      .trim(),
  );
</script>

<div class="overlay">
  <div class="dlg" style="min-width:400px">
    <div class="dlg-title"><i class="ph-duotone ph-arrows-clockwise"></i>{i18n.t("upd.title")}</div>
    <div class="dlg-body">
      {#if update.status === "checking"}
        <div class="row"><i class="ph ph-arrows-clockwise spin"></i>{i18n.t("upd.checking")}</div>
      {:else if update.status === "latest"}
        <div class="row ok"><i class="ph ph-check-circle"></i>{i18n.t("upd.latest")}</div>
        <div class="ver mono">{i18n.t("upd.current", { v: update.current })}</div>
      {:else if update.status === "available" || update.status === "downloading" || update.status === "restarting"}
        <div class="row up"><i class="ph ph-arrow-circle-up"></i>{i18n.t("upd.available", { v: update.latest ?? "" })}</div>
        <div class="ver mono">{i18n.t("upd.current", { v: update.current })}</div>
        {#if prettyNotes}
          <div class="grp">{i18n.t("upd.notes")}</div>
          <div class="notes">{prettyNotes}</div>
        {/if}
        {#if update.status === "available"}
          {#if update.asset}
            <div class="sz mono">{i18n.t("upd.size", { mb: mb(update.asset.size ?? 0) })}</div>
          {:else}
            <div class="sz dim">{i18n.t("upd.noAsset")}</div>
          {/if}
        {:else if update.status === "downloading"}
          <div class="grp">{i18n.t("upd.downloading")}</div>
          <div class="bar"><div class="fill" style="width:{pct}%"></div></div>
          <div class="ver mono">{mb(update.downloaded)} / {mb(update.total)} MB · {pct}%</div>
        {:else}
          <div class="row"><i class="ph ph-arrows-clockwise spin"></i>{i18n.t("upd.restarting")}</div>
        {/if}
      {:else}
        <div class="row err"><i class="ph ph-warning-circle"></i>{i18n.t("upd.netError")}</div>
        {#if update.error}<div class="notes dim mono">{update.error}</div>{/if}
      {/if}
    </div>
    <div class="dlg-actions">
      {#if update.status === "available" && update.asset}
        <button class="btn primary" onclick={() => void update.install()}>
          <i class="ph ph-download-simple"></i>{i18n.t("upd.update")}
        </button>
        <button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("upd.later")}</button>
      {:else if update.status === "downloading" || update.status === "restarting"}
        <!-- the swap is in flight: the app is about to restart -->
      {:else if update.status === "error"}
        <button class="btn primary" onclick={() => void update.check(true)}>{i18n.t("upd.retry")}</button>
        <button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
      {:else if update.status === "checking" || update.status === "latest"}
        <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
      {:else}
        <button class="btn primary" onclick={() => void update.check(true)}>{i18n.t("upd.check")}</button>
        <button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: calc(14px * var(--fs-scale));
  }
  .row i { font-size: calc(18px * var(--fs-scale)); }
  .row.ok i { color: var(--accent2); }
  .row.up i { color: var(--accent); }
  .row.err i { color: var(--danger, #e5484d); }
  .spin { animation: upd-spin 1.2s linear infinite; }
  @keyframes upd-spin {
    to { transform: rotate(360deg); }
  }
  .ver { margin-top: 8px; font-size: calc(11.5px * var(--fs-scale)); color: var(--fg-dim); }
  .sz { margin-top: 6px; font-size: calc(11.5px * var(--fs-scale)); color: var(--fg-dim); }
  .ver.dim, .notes.dim { color: var(--fg-muted); font-size: calc(11px * var(--fs-scale)); }
  .grp {
    color: var(--fg-muted);
    font-size: calc(11.5px * var(--fs-scale));
    text-transform: uppercase;
    letter-spacing: 0.6px;
    margin: 12px 0 6px;
  }
  .notes {
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
    font-size: calc(12px * var(--fs-scale));
    line-height: 1.45;
    color: var(--fg-dim);
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--r-btn);
    background: var(--bg-elev);
  }
  .bar {
    height: 8px;
    border-radius: 4px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    overflow: hidden;
    margin: 6px 0;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }
</style>
