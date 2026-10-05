<script lang="ts">
  import { onMount } from "svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { EDITOR_PLUGINS } from "$lib/plugins";
  import {
    pluginSel,
    pluginModes,
    pluginIcon,
    applyPluginMode,
    resetPluginSel,
  } from "./pluginsState.svelte";
  import { listCursor } from "./listNav.svelte";

  // leaving the dialog (or switching away) drops the mode sub-list
  onMount(() => resetPluginSel);
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title"><i class="ph-duotone ph-puzzle-piece"></i>{i18n.t("fkeys.f11")}</div>
    <div class="dlg-body list">
      {#if pluginSel.id === null}
        {#each EDITOR_PLUGINS as p, i (p.id)}
          <button
            class="li"
            class:kbd={listCursor.idx === i}
            onclick={() => { pluginSel.id = p.id; listCursor.idx = 0; }}
          >
            <i class="ph-duotone {p.icon}"></i>{i18n.t(p.titleKey)}
          </button>
        {/each}
      {:else}
        {#each pluginModes() as m, i (m.id)}
          <button
            class="li"
            class:kbd={listCursor.idx === i}
            onclick={() => pluginSel.id && applyPluginMode(pluginSel.id, m.id)}
          >
            <i class="ph-duotone {pluginIcon()}"></i>{i18n.t(m.labelKey)}
          </button>
        {/each}
      {/if}
    </div>
    <div class="dlg-actions">
      {#if pluginSel.id !== null}
        <button class="btn" onclick={() => { resetPluginSel(); listCursor.idx = 0; }}>
          <i class="ph ph-arrow-left"></i>{i18n.t("plug.back")}
        </button>
      {/if}
      <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
    </div>
  </div>
</div>
