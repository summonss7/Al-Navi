<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { userMenu } from "$lib/stores/userMenu.svelte";
  import { umAdd, umEdit, umDelete, execUserMenuItem } from "./userMenuState.svelte";
  import { listCursor } from "./listNav.svelte";
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title"><i class="ph-duotone ph-list-checks"></i>{i18n.t("fkeys.f2")}</div>
    <div class="dlg-body list">
      {#each userMenu.items as it, i (it.id)}
        <button
          class="li"
          class:kbd={listCursor.idx === i}
          onclick={() => execUserMenuItem(it)}
        >
          <i class="ph-duotone ph-terminal-window"></i>
          <span class="um-title">{it.title}</span>
          <span class="um-cmd mono">{it.command}</span>
        </button>
      {:else}
        <div class="none">{i18n.t("umenu.empty")}</div>
      {/each}
    </div>
    <div class="dlg-actions wrap">
      <button class="btn" onclick={umAdd}><i class="ph ph-plus"></i>{i18n.t("umenu.add")}</button>
      <button class="btn" onclick={() => umEdit(listCursor.idx)} disabled={!userMenu.items.length}>{i18n.t("umenu.edit")}</button>
      <button class="btn" onclick={() => void umDelete(listCursor.idx)} disabled={!userMenu.items.length}>{i18n.t("umenu.delete")}</button>
      <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
    </div>
  </div>
</div>

<style>
  /* F2 user-menu rows: title + the command it runs */
  .um-title { color: var(--fg); flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .um-cmd { font-size: calc(10.5px * var(--fs-scale)); color: var(--fg-muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: end; }
</style>
