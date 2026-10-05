<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { ops } from "$lib/stores/ops.svelte";
  import { parentOf, joinPath } from "$lib/format";
  import { applyMultiRename, defaultMrForm } from "$lib/multiRename";
  import { pathExists } from "$lib/api";
  import { focusSelect } from "./common";

  // Ctrl+M multi-rename
  let mrForm = $state(defaultMrForm());
  $effect(() => {
    // every fresh request starts from a clean form
    if (ui.multiRenameReq) mrForm = defaultMrForm();
  });
  const mrRows = $derived(applyMultiRename(ui.multiRenameReq?.targets ?? [], mrForm));
  const mrOkCount = $derived(mrRows.reduce((n, r) => n + (r.status === "ok" ? 1 : 0), 0));
  /** new names already occupied on disk (filled by the debounced check below) */
  let mrConflicts = $state<Set<string>>(new Set());
  const mrBlocked = $derived(
    mrOkCount === 0 ||
      mrRows.some(
        (r) => r.status === "invalid" || r.status === "dup" || mrConflicts.has(r.newName.toLowerCase()),
      ),
  );
  const MR_PREVIEW_MAX = 300;

  // new names already occupied on disk (debounced, capped): the pure transform
  // can only see the batch itself, existing targets are an async question
  let mrSeq = 0;
  let mrTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const rows = mrRows;
    if (!ui.multiRenameReq) {
      mrConflicts = new Set();
      return;
    }
    clearTimeout(mrTimer);
    mrConflicts = new Set();
    const seq = ++mrSeq;
    mrTimer = setTimeout(async () => {
      if (seq !== mrSeq || !ui.multiRenameReq) return;
      const found = new Set<string>();
      const checks: Promise<void>[] = [];
      for (const r of rows) {
        if (r.status !== "ok") continue;
        // a case-only rename targets the file itself — not a conflict
        if (r.newName.toLowerCase() === r.oldName.toLowerCase()) continue;
        const dir = parentOf(r.oldPath);
        if (!dir) continue;
        const target = joinPath(dir, r.newName);
        checks.push(
          pathExists(target)
            .then((yes) => {
              if (yes) found.add(r.newName.toLowerCase());
            })
            .catch(() => {}),
        );
        if (checks.length >= MR_PREVIEW_MAX) break;
      }
      await Promise.all(checks);
      if (seq === mrSeq) mrConflicts = found;
    }, 250);
  });

  function submitMultiRename() {
    const req = ui.multiRenameReq;
    if (!req || mrBlocked) return;
    const pairs = mrRows
      .filter((r) => r.status === "ok")
      .map((r) => ({ old: r.oldPath, new: joinPath(parentOf(r.oldPath) ?? "", r.newName) }));
    if (!pairs.length) return;
    req.resolve();
    void ops.startRename(pairs);
  }

  function closeMultiRename() {
    ui.multiRenameReq?.resolve();
  }
</script>

<div class="overlay">
  <div class="dlg dlg-mr">
    <div class="dlg-title">
      <i class="ph-duotone ph-text-aa"></i>
      {i18n.t("mr.title")} · {i18n.t("mr.nItems", { n: ui.multiRenameReq!.targets.length })}
    </div>
    <form class="dlg-body ftp-form" id="mr-form" onsubmit={(e) => { e.preventDefault(); submitMultiRename(); }}>
      <label class="lbl" for="mr-f-mask">{i18n.t("mr.mask")}</label>
      <input id="mr-f-mask" bind:value={mrForm.mask} use:focusSelect spellcheck="false" style="width:100%" />
      <div class="ftp-row2">
        <div>
          <label class="lbl" for="mr-f-find">{i18n.t("mr.find")}</label>
          <input id="mr-f-find" bind:value={mrForm.find} spellcheck="false" />
        </div>
        <div>
          <label class="lbl" for="mr-f-repl">{i18n.t("mr.replace")}</label>
          <input id="mr-f-repl" bind:value={mrForm.replace} spellcheck="false" />
        </div>
      </div>
      <label class="lbl check"><input type="checkbox" bind:checked={mrForm.caseSensitive} />{i18n.t("mr.case")}</label>
      <div class="ftp-row2">
        <div>
          <label class="lbl" for="mr-f-name">{i18n.t("mr.nameTmpl")}</label>
          <input id="mr-f-name" bind:value={mrForm.nameTmpl} spellcheck="false" />
        </div>
        <div>
          <label class="lbl" for="mr-f-ext">{i18n.t("mr.extTmpl")}</label>
          <input id="mr-f-ext" bind:value={mrForm.extTmpl} spellcheck="false" />
        </div>
      </div>
      <div class="ftp-row2">
        <div>
          <label class="lbl" for="mr-f-cs">{i18n.t("mr.countStart")}</label>
          <input id="mr-f-cs" type="number" bind:value={mrForm.countStart} />
        </div>
        <div>
          <label class="lbl" for="mr-f-ct">{i18n.t("mr.countStep")}</label>
          <input id="mr-f-ct" type="number" bind:value={mrForm.countStep} />
        </div>
        <div>
          <label class="lbl" for="mr-f-cd">{i18n.t("mr.countDigits")}</label>
          <input id="mr-f-cd" type="number" bind:value={mrForm.countDigits} min="1" max="10" />
        </div>
      </div>
      <div class="fc-hint">{i18n.t("mr.phHint")}</div>
      <div class="mr-preview">
        {#each mrRows.slice(0, MR_PREVIEW_MAX) as r}
          <div
            class="mr-row"
            class:dim={r.status === "unchanged"}
            class:bad={r.status === "invalid" || r.status === "dup" || mrConflicts.has(r.newName.toLowerCase())}
          >
            <span class="mono">{r.oldName}</span>
            <span class="mr-arrow">→</span>
            <span class="mono">{r.newName}</span>
            <span class="mr-note">
              {#if r.status === "invalid"}{i18n.t("mr.invalid")}
              {:else if r.status === "dup"}{i18n.t("mr.dup")}
              {:else if mrConflicts.has(r.newName.toLowerCase())}{i18n.t("mr.conflict")}
              {:else if r.status === "unchanged"}{i18n.t("mr.unchanged")}{/if}
            </span>
          </div>
        {/each}
        {#if mrRows.length > MR_PREVIEW_MAX}
          <div class="mr-more">{i18n.t("mr.more", { n: mrRows.length - MR_PREVIEW_MAX })}</div>
        {/if}
        {#if !mrRows.length}
          <div class="none">{i18n.t("mr.nothing")}</div>
        {/if}
      </div>
    </form>
    <div class="dlg-actions">
      <button class="btn" onclick={closeMultiRename}>{i18n.t("common.cancel")}</button>
      <button class="btn primary" type="submit" form="mr-form" disabled={mrBlocked}>
        {i18n.t("mr.apply", { n: mrOkCount })}
      </button>
    </div>
  </div>
</div>

<style>
  .dlg-mr { min-width: 540px; max-width: 700px; }
  .mr-preview {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 10px;
    max-height: 230px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 8px;
  }
  .mr-row { display: flex; gap: 8px; align-items: baseline; font-size: calc(12px * var(--fs-scale)); color: var(--fg); }
  .mr-row .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1; min-width: 0; }
  .mr-arrow { color: var(--fg-muted); flex-shrink: 0; }
  .mr-note { color: var(--accent2); font-size: calc(10.5px * var(--fs-scale)); margin-inline-start: auto; flex-shrink: 0; }
  .mr-row.dim { opacity: 0.45; }
  .mr-row.bad { color: var(--danger); }
  .mr-row.bad .mr-note { color: var(--danger); }
  .mr-more { color: var(--fg-muted); font-size: calc(11px * var(--fs-scale)); padding: 3px 2px; }
</style>
