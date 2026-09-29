<script lang="ts">
  import { panels } from "$lib/stores/panels.svelte";
  import FilePanel from "./FilePanel.svelte";

  // plain refs: PanelState already carries its own $state fields,
  // re-wrapping would deep-proxy the whole entries array
  const left = panels.left;
  const right = panels.right;
</script>

<div class="panels" class:single-left={!panels.showRight && panels.showLeft} class:single-right={!panels.showLeft && panels.showRight} class:none={!panels.showLeft && !panels.showRight}>
  {#if panels.showLeft}
    <FilePanel panel={left} />
  {/if}
  {#if panels.showRight}
    <FilePanel panel={right} />
  {/if}
  {#if !panels.showLeft && !panels.showRight}
    <div class="hidden-note">
      <i class="ph-duotone ph-eye-slash"></i>
    </div>
  {/if}
</div>

<style>
  .panels {
    flex: 1;
    display: flex;
    gap: 12px;
    min-height: 0;
    min-width: 0;
  }
  .panels > :global(*) { flex: 1; min-width: 0; }
  .hidden-note {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-muted);
    font-size: 40px;
  }
</style>
