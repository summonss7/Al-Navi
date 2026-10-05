<script lang="ts">
  import { ui, type AttrBits } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";

  // Ctrl+A attributes
  const ATTR_KEYS = ["readOnly", "hidden", "system", "archive"] as const;
  let attrBits = $state<AttrBits>({ readOnly: "clear", hidden: "clear", system: "clear", archive: "clear" });
  $effect(() => {
    const req = ui.attrsReq;
    if (!req) return;
    attrBits = { ...req.initial };
  });
  function submitAttrs() {
    ui.attrsReq?.resolve({ ...attrBits });
  }
  function closeAttrs() {
    ui.attrsReq?.resolve(null);
  }
  // FAR's tri-state checkbox: clear -> set -> keep(unchanged) -> clear
  function cycleAttr(i: number) {
    const k = ATTR_KEYS[i];
    attrBits[k] = attrBits[k] === "clear" ? "set" : attrBits[k] === "set" ? "keep" : "clear";
  }
  // the dialog opens with the first checkbox focused (autofocus fires on
  // every node it's attached to; here only row 0 should take the caret)
  function autofocusFirst(node: HTMLElement, first?: boolean) {
    if (first) setTimeout(() => node.focus(), 0);
  }
  function onAttrsDlgKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter" && e.key !== " ") return;
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>("#attrs-form input[type=checkbox]"));
    if (!boxes.length) return;
    const idx = boxes.indexOf(document.activeElement as HTMLInputElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      boxes[(idx < 0 ? 0 : idx + (e.key === "ArrowDown" ? 1 : -1) + boxes.length) % boxes.length].focus();
    } else if (e.key === "Enter") {
      // on the action buttons Enter keeps its native meaning (focused button)
      if ((document.activeElement as HTMLElement | null)?.closest(".dlg-actions")) return;
      e.preventDefault();
      submitAttrs();
    } else if (idx >= 0) {
      // space toggles the native checkbox before our state knows about it;
      // cycle ourselves so keep/set/clear never desync from the visual box
      e.preventDefault();
      cycleAttr(idx);
    }
  }
</script>

<div class="overlay">
  <div class="dlg" role="dialog" onkeydown={onAttrsDlgKey}>
    <div class="dlg-title"><i class="ph-duotone ph-sliders-horizontal"></i>{i18n.t("attrs.title")}</div>
    <form class="dlg-body" id="attrs-form" onsubmit={(e) => { e.preventDefault(); submitAttrs(); }}>
      {#each ATTR_KEYS as k, i (k)}
        <label class="lbl check">
          <input
            type="checkbox"
            checked={attrBits[k] === "set"}
            indeterminate={attrBits[k] === "keep"}
            title={attrBits[k] === "keep" ? i18n.t("attrs.keep") : ""}
            use:autofocusFirst={i === 0}
            onclick={(e) => { e.preventDefault(); cycleAttr(i); }}
          />{i18n.t(`attrs.${k}`)}
        </label>
      {/each}
      <div class="lbl" style="margin-top:10px; opacity:0.75">
        {i18n.t("attrs.nItems", { n: ui.attrsReq!.count })}
      </div>
    </form>
    <div class="dlg-actions">
      <button class="btn" onclick={closeAttrs}>{i18n.t("common.cancel")}</button>
      <button class="btn primary" onclick={submitAttrs}>{i18n.t("common.ok")}</button>
    </div>
  </div>
</div>
