<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { userMenu } from "$lib/stores/userMenu.svelte";
  import { autofocus } from "./common";
  import { umFormState, submitUmForm } from "./userMenuState.svelte";

  // the form mounts fresh per add/edit request — seed from the edit target
  const editing = umFormState.editId !== undefined ? userMenu.items.find((it) => it.id === umFormState.editId) : undefined;
  let umTitle = $state(editing?.title ?? "");
  let umCommand = $state(editing?.command ?? "");
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title">
      <i class="ph-duotone ph-list-checks"></i>
      {umFormState.mode === "add" ? i18n.t("umenu.add") : i18n.t("umenu.edit")}
    </div>
    <form class="dlg-body ftp-form" id="um-item-form" onsubmit={(e) => { e.preventDefault(); submitUmForm(umTitle, umCommand); }}>
      <label class="lbl" for="um-f-title">{i18n.t("umenu.name")}</label>
      <input id="um-f-title" bind:value={umTitle} use:autofocus spellcheck="false" />
      <label class="lbl" for="um-f-cmd">{i18n.t("umenu.command")}</label>
      <input id="um-f-cmd" bind:value={umCommand} spellcheck="false" style="width:100%" />
      <div class="fc-hint" style="margin-top:10px">{i18n.t("umenu.hint")}</div>
    </form>
    <div class="dlg-actions">
      <button class="btn" onclick={() => ui.openDialog("userMenu")}>{i18n.t("common.cancel")}</button>
      <button class="btn primary" type="submit" form="um-item-form" disabled={!umCommand.trim()}>
        {i18n.t("umenu.save")}
      </button>
    </div>
  </div>
</div>
