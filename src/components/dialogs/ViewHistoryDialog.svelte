<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { editor } from "$lib/stores/editor.svelte";
  import { basename, parentOf } from "$lib/format";
  import { listCursor } from "./listNav.svelte";
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title"><i class="ph-duotone ph-eye"></i>{i18n.t("history.views")}</div>
    <div class="dlg-body list">
      {#each editor.viewHistory as p, i (p)}
        <button
          class="li"
          class:kbd={listCursor.idx === i}
          onclick={() => { void editor.view(p); ui.closeDialog(); }}
        >
          <i class="ph-duotone ph-file-text"></i>
          <span class="vh-name">{basename(p)}</span>
          <span class="vh-dir mono">{parentOf(p)}</span>
        </button>
      {:else}
        <div class="none">{i18n.t("common.none")}</div>
      {/each}
    </div>
    <div class="dlg-actions"><button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button></div>
  </div>
</div>

<style>
  /* Alt+F11 view history rows: file name + its directory */
  .vh-name { color: var(--fg); flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vh-dir { font-size: calc(10.5px * var(--fs-scale)); color: var(--fg-muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: end; }
</style>
