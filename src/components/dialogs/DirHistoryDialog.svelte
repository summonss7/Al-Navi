<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { panels } from "$lib/stores/panels.svelte";
  import { listCursor } from "./listNav.svelte";
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title"><i class="ph-duotone ph-clock-counter-clockwise"></i>{i18n.t("history.dirs")}</div>
    <div class="dlg-body list">
      {#each panels.dirHistory as p, i (p)}
        <button
          class="li mono"
          class:kbd={listCursor.idx === i}
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
