<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { pathKey } from "$lib/format";
  import { focusSelect, retypeVariant } from "./common";

  let inputVal = $state("");
  // highlighted destination variant; -1 = hand-edited field (or the initial
  // value isn't a variant, e.g. a single file's dest+name prefill)
  let variantIdx = $state(-1);
  $effect(() => {
    const req = ui.inputReq;
    if (!req) return;
    inputVal = req.value;
    variantIdx = req.variants?.findIndex((v) => pathKey(v) === pathKey(req.value)) ?? -1;
  });

  function submitInput() {
    ui.inputReq?.resolve(inputVal);
  }

  function closeInput() {
    ui.inputReq?.resolve(null);
  }

  // F5/F6 transfer dialogs seed `resetTo` with the current file name —
  // Shift+Enter clears the field and drops that name in (selected, ready to
  // be retyped over), so a bare name + Enter renames in the current folder.
  // In dialogs without a name Shift+Enter is simply swallowed: it must not
  // submit, or a slipped Shift turns Enter into an accidental transfer.
  // With destination variants, bare ↑/↓ cycle them (wrapping like the list
  // dialogs), the field takes the variant — selected for overtype, like open.
  function onInputKey(e: KeyboardEvent) {
    const el = e.currentTarget as HTMLInputElement;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const vars = ui.inputReq?.variants;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !vars?.length) return;
      e.preventDefault(); // keep the native caret jump to start/end out
      const n = vars.length;
      variantIdx =
        variantIdx < 0
          ? e.key === "ArrowDown"
            ? 0
            : n - 1
          : (variantIdx + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      inputVal = vars[variantIdx];
      el.value = vars[variantIdx]; // applied now; the binding flush would be too late for select()
      setTimeout(() => el.select(), 0);
      return;
    }
    if (e.key !== "Enter" || !e.shiftKey) return;
    e.preventDefault(); // stop the implicit form submit
    const name = ui.inputReq?.resetTo;
    if (name === undefined) return;
    inputVal = name;
    el.value = name; // applied now; the binding flush would be too late for select()
    setTimeout(() => el.select(), 0);
  }

  // clicking a variant = cycling onto it: the field takes it, overtype-ready
  function pickVariant(i: number) {
    const v = ui.inputReq?.variants?.[i];
    if (v === undefined) return;
    variantIdx = i;
    inputVal = v;
    retypeVariant(v);
  }

  $effect(() => {
    void variantIdx;
    document.querySelector(".variants .li.kbd")?.scrollIntoView({ block: "nearest" });
  });
</script>

<div class="overlay">
  <div class="dlg" role="dialog">
    <div class="dlg-title"><i class="ph-duotone ph-pencil-simple"></i>{ui.inputReq!.title}</div>
    <form class="dlg-body" onsubmit={(e) => { e.preventDefault(); submitInput(); }}>
      <label class="lbl">{ui.inputReq!.prompt}</label>
      <input
        bind:value={inputVal}
        use:focusSelect
        spellcheck="false"
        style="width:100%"
        onkeydown={onInputKey}
        oninput={() => { variantIdx = -1; }}
      />
      {#if ui.inputReq!.variants?.length}
        <div class="variants">
          {#each ui.inputReq!.variants as v, i}
            <button type="button" class="li" class:kbd={i === variantIdx} title={v} onclick={() => pickVariant(i)}>
              <i class="ph-duotone ph-folder-simple"></i><span class="path">{v}</span>
            </button>
          {/each}
        </div>
      {/if}
    </form>
    <div class="dlg-actions">
      <button class="btn" onclick={closeInput}>{i18n.t("common.cancel")}</button>
      <button class="btn primary" onclick={submitInput}>{i18n.t("common.ok")}</button>
    </div>
  </div>
</div>
