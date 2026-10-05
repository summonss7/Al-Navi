<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { settings } from "$lib/stores/settings.svelte";
  import { textColors, type BuiltinRule, type MaskRule } from "$lib/stores/textColors.svelte";
  import { sampleOf } from "./common";

  // text highlight rules (dates / 2+ symbol runs / masks)
  // every edit rebuilds the editor decorations immediately
  function bumpDecor() {
    void import("$lib/editor/cm").then(({ applyEditorDecor }) => applyEditorDecor());
  }
  function trBuiltin(kind: "dates" | "special", patch: Partial<BuiltinRule>) {
    textColors.setBuiltin(kind, patch);
    bumpDecor();
  }
  function trMask(id: string, patch: Partial<Omit<MaskRule, "id">>) {
    textColors.updateMask(id, patch);
    bumpDecor();
  }
  function trRemove(id: string) {
    textColors.removeMask(id);
    bumpDecor();
  }
  function trReset() {
    textColors.reset();
    bumpDecor();
  }
  // picker value for a built-in rule without an override: the current theme's
  // token (touch settings.s.theme so open pickers re-read on theme switch)
  function cmVar(name: "--cm-date" | "--cm-special"): string {
    void settings.s.theme;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
</script>

<div class="overlay">
  <div class="dlg" style="min-width: 560px">
    <div class="dlg-title"><i class="ph-duotone ph-text-aa"></i>{i18n.t("menu.textRules")}</div>
    <div class="dlg-body">
      <div class="fc-hint">{i18n.t("tr.hint")}</div>
      <div class="fc-rows">
        <div class="fc-row">
          <input
            type="checkbox"
            checked={textColors.s.dates.on}
            onchange={(e) => trBuiltin("dates", { on: e.currentTarget.checked })}
          />
          <span class="tr-name">{i18n.t("tr.dates")}</span>
          <input
            type="color"
            value={textColors.s.dates.color ?? cmVar("--cm-date")}
            title={textColors.s.dates.color ?? i18n.t("tr.themeColor")}
            oninput={(e) => trBuiltin("dates", { color: e.currentTarget.value })}
          />
          <label class="fc-bold" title={i18n.t("fc.bold")}>
            <input
              type="checkbox"
              checked={!!textColors.s.dates.bold}
              onchange={(e) => trBuiltin("dates", { bold: e.currentTarget.checked })}
            />
            <b>B</b>
          </label>
          <button
            class="fc-del"
            title={i18n.t("tr.themeColor")}
            disabled={!textColors.s.dates.color}
            onclick={() => trBuiltin("dates", { color: null })}
          >
            <i class="ph ph-arrow-counter-clockwise"></i>
          </button>
        </div>
        <div class="fc-row">
          <input
            type="checkbox"
            checked={textColors.s.special.on}
            onchange={(e) => trBuiltin("special", { on: e.currentTarget.checked })}
          />
          <span class="tr-name">{i18n.t("tr.special")}</span>
          <input
            type="color"
            value={textColors.s.special.color ?? cmVar("--cm-special")}
            title={textColors.s.special.color ?? i18n.t("tr.themeColor")}
            oninput={(e) => trBuiltin("special", { color: e.currentTarget.value })}
          />
          <label class="fc-bold" title={i18n.t("fc.bold")}>
            <input
              type="checkbox"
              checked={!!textColors.s.special.bold}
              onchange={(e) => trBuiltin("special", { bold: e.currentTarget.checked })}
            />
            <b>B</b>
          </label>
          <button
            class="fc-del"
            title={i18n.t("tr.themeColor")}
            disabled={!textColors.s.special.color}
            onclick={() => trBuiltin("special", { color: null })}
          >
            <i class="ph ph-arrow-counter-clockwise"></i>
          </button>
        </div>
        {#each textColors.s.masks as r (r.id)}
          <div class="fc-row">
            <input
              type="color"
              value={r.color}
              title={r.color}
              oninput={(e) => trMask(r.id, { color: e.currentTarget.value })}
            />
            <input
              class="fc-mask"
              type="text"
              value={r.mask}
              spellcheck="false"
              placeholder={i18n.t("tr.maskPh")}
              oninput={(e) => trMask(r.id, { mask: e.currentTarget.value })}
            />
            <label class="fc-bold" title={i18n.t("fc.bold")}>
              <input
                type="checkbox"
                checked={!!r.bold}
                onchange={(e) => trMask(r.id, { bold: e.currentTarget.checked })}
              />
              <b>B</b>
            </label>
            <span
              class="fc-sample"
              style="color:{r.color};font-weight:{r.bold ? 800 : 400}"
              >{sampleOf(r.mask) || "*"}</span
            >
            <button class="fc-del" title={i18n.t("fc.remove")} onclick={() => trRemove(r.id)}>
              <i class="ph ph-x"></i>
            </button>
          </div>
        {/each}
      </div>
    </div>
    <div class="dlg-actions wrap">
      <button class="btn" onclick={() => textColors.addMask()}><i class="ph ph-plus"></i>{i18n.t("fc.add")}</button>
      <button class="btn" onclick={() => trReset()}>{i18n.t("fc.reset")}</button>
      <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
    </div>
  </div>
</div>
