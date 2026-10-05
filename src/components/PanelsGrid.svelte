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
    <FilePanel panel={left} grow={panels.showRight ? panels.splitRatio : 1} />
  {/if}
  {#if panels.showRight}
    <FilePanel panel={right} grow={panels.showLeft ? 1 - panels.splitRatio : 1} />
  {/if}
  {#if !panels.showLeft && !panels.showRight}
    <div class="hidden-note">
      <i class="ph-duotone ph-eye-slash"></i>
      <span class="hint">Ctrl+O</span>
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
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: calc(10px * var(--fs-scale));
    color: var(--fg-muted);
    font-size: calc(40px * var(--fs-scale));
  }
  .hidden-note .hint {
    font-size: calc(13px * var(--fs-scale));
    letter-spacing: 0.04em;
  }
</style>
