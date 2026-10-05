<script lang="ts">
  import { i18n } from "$lib/stores/i18n.svelte";
  import { ops } from "$lib/stores/ops.svelte";
  import { autofocus } from "./common";
</script>

<div class="overlay">
  <div class="dlg">
    <div class="dlg-title warn"><i class="ph-duotone ph-warning"></i>{i18n.t("ops.conflict")}</div>
    <div class="dlg-body">
      <div class="conf-row"><span class="lbl">{i18n.t("ops.src")}:</span><span class="mono path">{ops.conflict!.src}</span></div>
      <div class="conf-row"><span class="lbl">{i18n.t("ops.dst")}:</span><span class="mono path">{ops.conflict!.dst}</span></div>
    </div>
    <div class="dlg-actions wrap focus-fill">
      <button class="btn primary" use:autofocus onclick={() => ops.resolveConflictAction("overwrite")}>{i18n.t("ops.copy")} ↩</button>
      <button class="btn" onclick={() => ops.resolveConflictAction("overwrite_all")}>{i18n.t("common.all")}</button>
      <button class="btn" onclick={() => ops.resolveConflictAction("skip")}>{i18n.t("common.cancel")}</button>
      <button class="btn" onclick={() => ops.resolveConflictAction("skip_all")}>↷ {i18n.t("common.all")}</button>
      <button class="btn" onclick={() => ops.resolveConflictAction("rename")}>{i18n.t("ops.rename")}</button>
    </div>
  </div>
</div>

<style>
  .dlg-title.warn { color: var(--accent2); }
  .conf-row { display: flex; gap: 10px; margin-bottom: 8px; font-size: calc(12px * var(--fs-scale)); align-items: baseline; }
  .conf-row .lbl { margin: 0; min-width: 90px; color: var(--fg-dim); }
  .conf-row .path { word-break: break-all; direction: ltr; }
</style>
