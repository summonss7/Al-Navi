<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { pathKey } from "$lib/format";
  import { focusSelect } from "./common";

  // Alt+F6 unpack
  let unpackDest = $state("");
  let unpackIdx = $state(-1);
  let unpackSubdir = $state(true);
  $effect(() => {
    const req = ui.unpackReq;
    if (!req) return;
    unpackDest = req.destDir;
    unpackIdx = req.variants.findIndex((v) => pathKey(v) === pathKey(req.destDir));
    unpackSubdir = req.subdirDefault;
  });
  function submitUnpack() {
    ui.unpackReq?.resolve({ dest: unpackDest, subdir: unpackSubdir });
  }
  function closeUnpack() {
    ui.unpackReq?.resolve(null);
  }
  // bare ↑/↓ cycle the destination variants, like the F5/F6 transfer dialog
  function onUnpackKey(e: KeyboardEvent) {
    const el = e.currentTarget as HTMLInputElement;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const vars = ui.unpackReq?.variants;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !vars?.length) return;
      e.preventDefault();
      const n = vars.length;
      unpackIdx =
        unpackIdx < 0
          ? e.key === "ArrowDown"
            ? 0
            : n - 1
          : (unpackIdx + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      unpackDest = vars[unpackIdx];
      el.value = vars[unpackIdx];
      setTimeout(() => el.select(), 0);
    }
  }
  function pickUnpackVariant(i: number) {
    const v = ui.unpackReq?.variants[i];
    if (v === undefined) return;
    unpackIdx = i;
    unpackDest = v;
  }
</script>

<div class="overlay">
  <div class="dlg" role="dialog">
    <div class="dlg-title"><i class="ph-duotone ph-package"></i>{i18n.t("archive.unpackTitle")}</div>
    <form class="dlg-body" onsubmit={(e) => { e.preventDefault(); submitUnpack(); }}>
      <label class="lbl">{i18n.t("ops.dst")}</label>
      <input
        bind:value={unpackDest}
        use:focusSelect
        spellcheck="false"
        style="width:100%"
        onkeydown={onUnpackKey}
        oninput={() => { unpackIdx = -1; }}
      />
      {#if ui.unpackReq!.variants.length}
        <div class="variants">
          {#each ui.unpackReq!.variants as v, i}
            <button type="button" class="li" class:kbd={i === unpackIdx} title={v} onclick={() => pickUnpackVariant(i)}>
              <i class="ph-duotone ph-folder-simple"></i><span class="path">{v}</span>
            </button>
          {/each}
        </div>
      {/if}
      <label class="lbl check" style="margin-top:10px">
        <input type="checkbox" bind:checked={unpackSubdir} />{i18n.t("archive.unpackSubdir")}
      </label>
    </form>
    <div class="dlg-actions">
      <button class="btn" onclick={closeUnpack}>{i18n.t("common.cancel")}</button>
      <button class="btn primary" onclick={submitUnpack}>{i18n.t("common.ok")}</button>
    </div>
  </div>
</div>
