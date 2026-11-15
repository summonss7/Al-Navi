<script module lang="ts">
  // Ctrl+F7 replace (alnavi-043). The dialog stays open: the editor is
  // visible through the translucent overlay, «Заменить» walks match by match
  // (первое, потом следующее и так далее), «Заменить всё» finishes at once.
  export interface ReplaceFormState {
    search: string;
    replace: string;
    caseSensitive: boolean;
    wholeWord: boolean;
    regexp: boolean;
  }

  // remembered between opens (module scope survives dialog close/reopen);
  // F7-find's own panel keeps its query separately inside CodeMirror
  let lastForm: ReplaceFormState = {
    search: "",
    replace: "",
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
  };
</script>

<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { focusSelect } from "./common";
  // type-only: the module itself is loaded on demand — a static import would
  // drag the whole editor chunk into the main bundle (see build warnings)
  import type { ReplaceResult } from "$lib/editor/cm";

  let form = $state<ReplaceFormState>({ ...lastForm });

  function params(): ReplaceFormState {
    lastForm = { ...form };
    return form;
  }

  function toastOf(r: ReplaceResult, search: string) {
    switch (r) {
      case "empty":
        ui.showToast(i18n.t("editor.replace.emptySearch"));
        break;
      case "invalid":
        ui.showToast(i18n.t("editor.replace.badRe"));
        break;
      case "noMatch":
        ui.showToast(i18n.t("editor.replace.none", { q: search }));
        break;
      // replaced/advanced: the next match is selected in the editor behind
      // the overlay — no toast needed
    }
  }

  function onNext() {
    void import("$lib/editor/cm").then((cm) => toastOf(cm.replaceNextCmd(params()), form.search));
  }

  function onSkip() {
    void import("$lib/editor/cm").then((cm) => toastOf(cm.replaceSkipCmd(params()), form.search));
  }

  function onAll() {
    void import("$lib/editor/cm").then((cm) => {
      const r = cm.replaceAllCmd(params());
      if (r === "empty" || r === "invalid") {
        toastOf(r, form.search);
        return;
      }
      ui.closeDialog();
      ui.showToast(r ? i18n.t("editor.replace.done", { n: r }) : i18n.t("editor.replace.none", { q: form.search }));
    });
  }
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title"><i class="ph-duotone ph-arrows-clockwise"></i>{i18n.t("editor.replace.title")}</div>
    <form class="dlg-body ftp-form" id="replace-form" onsubmit={(e) => { e.preventDefault(); onNext(); }}>
      <label class="lbl" for="rp-f-find">{i18n.t("editor.replace.find")}</label>
      <input id="rp-f-find" bind:value={form.search} use:focusSelect spellcheck="false" style="width:100%" />
      <label class="lbl" for="rp-f-with">{i18n.t("editor.replace.with")}</label>
      <input id="rp-f-with" bind:value={form.replace} spellcheck="false" style="width:100%" />
      <label class="lbl check"><input type="checkbox" bind:checked={form.caseSensitive} />{i18n.t("editor.replace.case")}</label>
      <label class="lbl check"><input type="checkbox" bind:checked={form.wholeWord} />{i18n.t("editor.replace.word")}</label>
      <label class="lbl check"><input type="checkbox" bind:checked={form.regexp} />{i18n.t("editor.replace.re")}</label>
    </form>
    <div class="dlg-actions">
      <button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.cancel")}</button>
      <button class="btn" id="rp-btn-skip" onclick={onSkip}>{i18n.t("editor.replace.skip")}</button>
      <button class="btn" id="rp-btn-all" onclick={onAll}>{i18n.t("editor.replace.all")}</button>
      <button class="btn primary" id="rp-btn-next" type="submit" form="replace-form">{i18n.t("editor.replace.next")}</button>
    </div>
  </div>
</div>
