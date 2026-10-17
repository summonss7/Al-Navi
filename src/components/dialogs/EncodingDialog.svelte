<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { editor } from "$lib/stores/editor.svelte";
  import { ENCODINGS } from "$lib/encodings";
  import { listCursor, activateListItem } from "./listNav.svelte";

  // applies to the active editor doc (F8) or viewer doc (Shift+F8) —
  // whichever surface opened the dialog
  const current = $derived(
    ui.mode === "viewer" ? (editor.activeViewer?.encoding ?? "") : (editor.active?.encoding ?? ""),
  );
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title"><i class="ph-duotone ph-character-formatting"></i>{i18n.t("editor.encoding")}</div>
    <div class="dlg-body list">
      <button class="li mono" class:kbd={listCursor.idx === 0} onclick={() => activateListItem(0)}>
        <i class="ph-duotone ph-magic-wand"></i>{i18n.t("enc.auto")}
      </button>
      {#each ENCODINGS as e, i (e.id)}
        <button class="li mono" class:kbd={listCursor.idx === i + 1} onclick={() => activateListItem(i + 1)}>
          <i class="ph-duotone ph-text-aa"></i>{e.label}
          {#if current === e.id}<span class="cur mono">{i18n.t("enc.current")}</span>{/if}
        </button>
      {/each}
    </div>
    <div class="dlg-actions"><button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button></div>
  </div>
</div>

<style>
  .cur {
    margin-left: auto;
    font-size: calc(10.5px * var(--fs-scale));
    color: var(--accent);
    border-radius: 5px;
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    padding: 1px 7px;
  }
</style>
