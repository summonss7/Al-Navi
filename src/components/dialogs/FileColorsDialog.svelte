<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { fileColors } from "$lib/stores/fileColors.svelte";
  import { sampleOf } from "./common";
</script>

<div class="overlay">
  <div class="dlg" style="min-width: 500px">
    <div class="dlg-title"><i class="ph-duotone ph-palette"></i>{i18n.t("menu.fileColors")}</div>
    <div class="dlg-body">
      <div class="fc-hint">{i18n.t("fc.hint")}</div>
      <div class="fc-rows">
        {#each fileColors.rules as r (r.id)}
          <div class="fc-row">
            <input
              type="color"
              value={r.color}
              title={r.color}
              oninput={(e) => fileColors.update(r.id, { color: e.currentTarget.value })}
            />
            <input
              class="fc-mask"
              type="text"
              value={r.mask}
              spellcheck="false"
              oninput={(e) => fileColors.update(r.id, { mask: e.currentTarget.value })}
            />
            <label class="fc-bold" title={i18n.t("fc.bold")}>
              <input
                type="checkbox"
                checked={!!r.bold}
                onchange={(e) => fileColors.update(r.id, { bold: e.currentTarget.checked })}
              />
              <b>B</b>
            </label>
            <span
              class="fc-sample"
              style="color:{r.color};font-weight:{r.bold ? 800 : 400}"
              >{sampleOf(r.mask)}</span
            >
            <button class="fc-del" title={i18n.t("fc.remove")} onclick={() => fileColors.remove(r.id)}>
              <i class="ph ph-x"></i>
            </button>
          </div>
        {/each}
      </div>
    </div>
    <div class="dlg-actions wrap">
      <button class="btn" onclick={() => fileColors.add()}><i class="ph ph-plus"></i>{i18n.t("fc.add")}</button>
      <button class="btn" onclick={() => fileColors.reset()}>{i18n.t("fc.reset")}</button>
      <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
    </div>
  </div>
</div>
