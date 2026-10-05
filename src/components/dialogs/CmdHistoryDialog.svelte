<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { cmdline } from "$lib/stores/cmdline.svelte";
  import { listCursor } from "./listNav.svelte";
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title"><i class="ph-duotone ph-terminal-window"></i>{i18n.t("history.cmds")}</div>
    <div class="dlg-body list">
      {#each cmdline.history as c, i (c)}
        <button
          class="li mono"
          class:kbd={listCursor.idx === i}
          onclick={() => { cmdline.setText(c); ui.closeDialog(); }}
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
