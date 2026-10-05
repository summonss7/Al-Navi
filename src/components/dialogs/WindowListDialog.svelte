<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { editor } from "$lib/stores/editor.svelte";
  import { listCursor } from "./listNav.svelte";
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title"><i class="ph-duotone ph-squares-four"></i>F12</div>
    <div class="dlg-body list">
      <button
        class="li"
        class:kbd={listCursor.idx === 0}
        class:on={ui.mode === 'panels' ? true : false}
        onclick={() => { ui.setMode("panels"); ui.closeDialog(); }}
      >
        <i class="ph-duotone ph-squares-four"></i>{i18n.t("windows.panels")}
      </button>
      {#each editor.docs as d, i (d.id)}
        <button
          class="li"
          class:kbd={listCursor.idx === 1 + i}
          class:on={ui.mode === "editor" && editor.activeId === d.id}
          onclick={() => { editor.activate(d.id); ui.closeDialog(); }}
        >
          <i class="ph-duotone ph-note-pencil"></i>{d.name}{#if d.dirty} •{/if}
        </button>
      {/each}
      {#each editor.viewDocs as d, i (d.id)}
        <button
          class="li"
          class:kbd={listCursor.idx === 1 + editor.docs.length + i}
          class:on={ui.mode === "viewer" && editor.activeViewId === d.id}
          onclick={() => { editor.activate(d.id); ui.closeDialog(); }}
        >
          <i class="ph-duotone ph-eye"></i>{d.name}
        </button>
      {/each}
      {#if !editor.docs.length && !editor.viewDocs.length}
        <div class="none">{i18n.t("windows.none")}</div>
      {/if}
    </div>
  </div>
</div>
