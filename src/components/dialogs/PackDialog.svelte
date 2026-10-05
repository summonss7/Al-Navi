<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { focusSelect } from "./common";

  // Alt+F5 pack
  let packName = $state("");
  let packFormat = $state("zip");
  let packFmtIdx = $state(0);
  $effect(() => {
    const req = ui.packReq;
    if (!req) return;
    packName = req.name;
    packFormat = req.formats[0]?.id ?? "zip";
    packFmtIdx = 0;
  });
  function submitPack() {
    ui.packReq?.resolve({ name: packName, format: packFormat });
  }
  function closePack() {
    ui.packReq?.resolve(null);
  }
  // ↑/↓ walk the format list when the focus is outside the name field; inside
  // it they keep their native caret meaning (dialogs own their arrow keys)
  function onPackDlgKey(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const n = ui.packReq?.formats.length ?? 0;
    if (!n) return;
    e.preventDefault();
    packFmtIdx = (packFmtIdx + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    packFormat = ui.packReq!.formats[packFmtIdx].id;
  }
</script>

<div class="overlay">
  <div class="dlg" role="dialog" onkeydown={onPackDlgKey}>
    <div class="dlg-title"><i class="ph-duotone ph-package"></i>{i18n.t("archive.packTitle")}</div>
    <form class="dlg-body" onsubmit={(e) => { e.preventDefault(); submitPack(); }}>
      <label class="lbl">{i18n.t("archive.packName")}</label>
      <input bind:value={packName} use:focusSelect spellcheck="false" style="width:100%" />
      <label class="lbl" style="margin-top:10px">{i18n.t("archive.packFormat")}</label>
      <div class="variants">
        {#each ui.packReq!.formats as f, i}
          <button
            type="button"
            class="li"
            class:kbd={i === packFmtIdx}
            onclick={() => { packFmtIdx = i; packFormat = f.id; }}
          >
            <i class="ph-duotone ph-file-zip"></i>{f.ext}
          </button>
        {/each}
      </div>
      <div class="lbl" style="margin-top:10px; opacity:0.75" title={ui.packReq!.destDir}>
        {i18n.t("ops.dst")}: {ui.packReq!.destDir}
      </div>
    </form>
    <div class="dlg-actions">
      <button class="btn" onclick={closePack}>{i18n.t("common.cancel")}</button>
      <button class="btn primary" onclick={submitPack}>{i18n.t("common.ok")}</button>
    </div>
  </div>
</div>
