<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { ftpSites } from "$lib/stores/ftpSites.svelte";
  import { ftpConnectSite, ftpQuick, ftpAdd, ftpEdit, ftpDelete } from "./ftpState.svelte";
  import { listCursor } from "./listNav.svelte";
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title"><i class="ph-duotone ph-globe-hemisphere-west"></i>{i18n.t("ftp.title")}</div>
    <div class="dlg-body list">
      {#each ftpSites.sites as s, i (s.id)}
        <button class="li" class:kbd={listCursor.idx === i} onclick={() => void ftpConnectSite(s, false)}>
          <i class="ph-duotone ph-globe-hemisphere-west"></i>
          <span class="ftp-name">{s.name || s.host}</span>
          <span class="scheme" class:sec={s.secure}>{s.secure ? "SFTP" : "FTP"}</span>
          {#if s.hotkey}<span class="jump-key mono" title={i18n.t("ftp.hotkey")}>{s.hotkey}</span>{/if}
          <span class="ftp-addr mono">{s.user || "anonymous"}@{s.host}:{s.port || (s.secure ? 22 : 21)}</span>
        </button>
      {:else}
        <div class="none">{i18n.t("ftp.none")}</div>
      {/each}
    </div>
    <div class="dlg-actions wrap">
      <button class="btn" onclick={ftpQuick}><i class="ph ph-bolt"></i>{i18n.t("ftp.quick")}</button>
      <button class="btn" onclick={ftpAdd}><i class="ph ph-plus"></i>{i18n.t("ftp.add")}</button>
      <button class="btn" onclick={() => ftpEdit(listCursor.idx)} disabled={!ftpSites.sites.length}>{i18n.t("ftp.edit")}</button>
      <button class="btn" onclick={() => ftpDelete(listCursor.idx)} disabled={!ftpSites.sites.length}>{i18n.t("ftp.delete")}</button>
      <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
    </div>
  </div>
</div>

<style>
  .ftp-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
  .ftp-addr { font-size: calc(10.5px * var(--fs-scale)); color: var(--fg-muted); }
  .scheme { font-size: calc(9px * var(--fs-scale)); font-weight: 700; letter-spacing: 0.4px; padding: 1px 5px; border-radius: 4px; background: var(--bg-inset); color: var(--fg-muted); }
  .scheme.sec { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
</style>
