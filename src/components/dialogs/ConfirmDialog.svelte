<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { autofocus } from "./common";
</script>

<div class="overlay">
  <div class="dlg" role="alertdialog">
    <div class="dlg-title"><i class="ph-duotone ph-question"></i>{i18n.t("common.ok")}</div>
    <div class="dlg-body">{ui.confirmReq!.message}</div>
    <div class="dlg-actions focus-fill">
      <button class="btn" onclick={() => ui.confirmReq!.resolve(false)}>{i18n.t("common.no")}</button>
      <button class="btn primary" use:autofocus onclick={() => ui.confirmReq!.resolve(true)}
        >{i18n.t("common.yes")}</button
      >
    </div>
  </div>
</div>
