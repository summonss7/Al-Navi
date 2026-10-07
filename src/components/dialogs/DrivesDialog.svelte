<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { formatSize } from "$lib/format";
  import { FTP_DRIVE_KEY, SFTP_DRIVE_KEY } from "$lib/ftp";
  import { drivesState, loadDrives, pickDrive } from "./drivesState.svelte";
  import { listCursor } from "./listNav.svelte";

  // reload on every open (the dialog component mounts fresh each time)
  $effect(() => {
    loadDrives();
  });

  function driveIcon(kind: string): string {
    switch (kind) {
      case "removable": return "ph-usb";
      case "cd": return "ph-disc";
      case "network": return "ph-hard-drives";
      case "home": return "ph-house";
      case "root": return "ph-drives";
      case "ftp": return "ph-globe-hemisphere-west";
      case "sftp": return "ph-lock-key";
      default: return "ph-hard-drive";
    }
  }
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title">
      <i class="ph-duotone ph-hard-drives"></i>
      {i18n.t("drives.title")} — {ui.drivesFor === "left" ? i18n.t("windows.panels") + " 1" : i18n.t("windows.panels") + " 2"}
    </div>
    <div class="dlg-body drives">
      {#each drivesState.list as d, i (d.mountPoint)}
        <button class="drive" class:kbd={i === listCursor.idx} onclick={() => void pickDrive(d)}>
          <i class="ph-duotone {driveIcon(d.kind)}"></i>
          <span class="d-name" title={d.mountPoint}>{d.name}</span>
          {#if d.kind === "ftp"}
            <span class="jump-key mono" title={i18n.t("help.dlg.ftpKey")}>{FTP_DRIVE_KEY}</span>
          {:else if d.kind === "sftp"}
            <span class="jump-key mono" title={i18n.t("help.dlg.sftpKey")}>{SFTP_DRIVE_KEY}</span>
          {:else if d.totalBytes}
            <span class="d-free mono">{formatSize(d.freeBytes)} {i18n.t("panel.free")} / {formatSize(d.totalBytes)}</span>
          {/if}
        </button>
      {/each}
    </div>
    <div class="dlg-actions">
      <button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
    </div>
  </div>
</div>

<style>
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
  .drive i { font-size: calc(22px * var(--fs-scale)); color: var(--accent); }
  .drive.kbd {
    border-color: var(--accent2);
    background: color-mix(in srgb, var(--accent2) 10%, var(--bg-panel));
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent2) 55%, transparent);
  }
  .d-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .d-free { font-size: calc(10.5px * var(--fs-scale)); color: var(--fg-muted); }
</style>
