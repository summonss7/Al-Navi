<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { autofocus } from "./common";
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title err-t"><i class="ph-duotone ph-warning-octagon"></i>{i18n.t("errors.access")}</div>
    <div class="dlg-body mono err-body">{ui.errorText}</div>
    <div class="dlg-actions">
      <button class="btn primary" use:autofocus onclick={() => { ui.errorText = null; ui.closeDialog(); }}>{i18n.t("common.close")}</button>
    </div>
  </div>
</div>

<style>
  .dlg-title.err-t { color: var(--danger); }
  .err-body { white-space: pre-wrap; word-break: break-all; font-size: calc(12px * var(--fs-scale)); }
</style>
