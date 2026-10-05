<script lang="ts">
  import { i18n } from "$lib/stores/i18n.svelte";
  import { ops } from "$lib/stores/ops.svelte";
  import { formatSize } from "$lib/format";
  import { autofocus } from "./common";

  // progress helpers — byte-based when the op reports bytes, otherwise
  // file/item-count based (instant renames, deletes without a pre-scan)
  function pct(op: { bytesDone: number; bytesTotal: number; filesDone: number; filesTotal: number }): number {
    if (op.bytesTotal) {
      return Math.min(100, Math.round((op.bytesDone / op.bytesTotal) * 100));
    }
    if (op.filesTotal) {
      return Math.min(100, Math.round((op.filesDone / op.filesTotal) * 100));
    }
    return 0;
  }
</script>

<div class="overlay">
  <div class="dlg" style="min-width: 460px">
    <div class="dlg-title">
      <i class="ph-duotone ph-arrows-clockwise"></i>
      {ops.op!.title}
      {#if ops.op!.phase === "done"}
        <span class="badge" class:ok={!ops.op!.cancelled && !ops.op!.errors.length} class:err={ops.op!.cancelled || ops.op!.errors.length}>
          {ops.op!.cancelled ? i18n.t("ops.cancelled") : ops.op!.errors.length ? i18n.t("ops.errors", { n: ops.op!.errors.length }) : i18n.t("ops.done")}
        </span>
      {/if}
    </div>
    <div class="dlg-body">
      {#if ops.op!.phase === "scan"}
        <div class="scan">{i18n.t("ops.scanning")}</div>
      {:else}
        <div class="bar">
          <div class="fill" style="width:{pct(ops.op!)}%"></div>
        </div>
        <div class="prow">
          <span class="mono">{pct(ops.op!)}%</span>
          {#if ops.op!.bytesTotal}
            <span class="mono">{formatSize(ops.op!.bytesDone)} / {formatSize(ops.op!.bytesTotal)}</span>
            {#if ops.op!.speed}<span class="mono dim">{formatSize(ops.op!.speed)}/s</span>{/if}
          {/if}
        </div>
        <div class="pfiles mono">
          {ops.op!.filesDone} / {ops.op!.filesTotal}
        </div>
        {#if ops.op!.current}
          <div class="cur" title={ops.op!.current}>{ops.op!.current}</div>
        {/if}
      {/if}
      {#if ops.op!.errors.length}
        <div class="errs">
          {#each ops.op!.errors.slice(0, 6) as er}
            <div class="err"><i class="ph ph-warning-circle"></i> {er.path}: {er.error}</div>
          {/each}
        </div>
      {/if}
    </div>
    <div class="dlg-actions">
      {#if ops.op!.phase !== "done"}
        <button class="btn" onclick={() => ops.pauseOrResume()}>
          {ops.op!.paused ? i18n.t("ops.resume") : i18n.t("ops.pause")}
        </button>
        <button class="btn" onclick={() => ops.toBackground()}>{i18n.t("ops.background")}</button>
        <button class="btn danger" onclick={() => ops.cancel()}>{i18n.t("ops.cancel")}</button>
      {:else}
        <button class="btn primary" use:autofocus onclick={() => ops.finishOp()}>{i18n.t("common.close")}</button>
      {/if}
    </div>
  </div>
</div>

<style>
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
  .prow { display: flex; gap: 14px; margin-top: 7px; font-size: calc(12px * var(--fs-scale)); color: var(--fg-dim); }
  .pfiles { font-size: calc(11.5px * var(--fs-scale)); color: var(--fg-muted); margin-top: 2px; }
  .cur {
    margin-top: 8px;
    font-size: calc(11.5px * var(--fs-scale));
    color: var(--fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: ltr;
    font-family: "JetBrains Mono", monospace;
  }
  .badge {
    margin-inline-start: auto;
    font-size: calc(11px * var(--fs-scale));
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--row-hover);
    color: var(--fg-dim);
  }
  .badge.ok { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .badge.err { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
  .errs { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
  .err { font-size: calc(11.5px * var(--fs-scale)); color: var(--danger); word-break: break-all; }
</style>
