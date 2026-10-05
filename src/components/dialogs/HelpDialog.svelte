<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { HELP_SECTIONS } from "$lib/help";
</script>

<div class="overlay">
  <div class="dlg help-dlg">
    <div class="dlg-title"><i class="ph-duotone ph-question"></i>{i18n.t("fkeys.f1")}</div>
    <div class="dlg-body help-body">
      {#each HELP_SECTIONS as s}
        <section class="help-section">
          <div class="help-grp">
            <i class="ph-duotone {s.icon}"></i>{i18n.t(s.title)}
          </div>
          <div class="help-grid">
            {#each s.items as it}
              <div class="hrow">
                {#if it.chord}<kbd>{it.chord}</kbd>{:else}<span class="nokbd"></span>{/if}
                <span class="hdesc">{i18n.t(it.key)}</span>
              </div>
            {/each}
          </div>
        </section>
      {/each}
    </div>
    <div class="help-mods">
      <kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>Shift</kbd>
      <span>{i18n.t("help.hintMods")}</span>
    </div>
    <div class="dlg-actions">
      <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
    </div>
  </div>
</div>

<style>
  /* sections as cards flowing in two balanced columns */
  .help-dlg { min-width: 700px; max-width: 960px; }
  .help-body { overflow-y: auto; columns: 2; column-gap: 14px; padding: 2px; }
  .help-section {
    break-inside: avoid;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 9px 12px 10px;
    margin: 0 0 12px;
  }
  .help-grp {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--fg);
    font-size: calc(11.5px * var(--fs-scale));
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    margin: 0 0 7px;
  }
  .help-grp i { font-size: calc(15px * var(--fs-scale)); color: var(--accent); }
  .help-grid { display: grid; grid-template-columns: 1fr; gap: 3px; }
  .hrow { display: flex; align-items: baseline; gap: 9px; font-size: calc(12px * var(--fs-scale)); color: var(--fg-dim); min-width: 0; }
  .hrow kbd {
    flex-shrink: 0;
    min-width: 92px;
    align-self: center;
    padding: 1px 7px;
    border-radius: 6px;
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    background: var(--bg);
    color: var(--fg);
    font-family: "JetBrains Mono", monospace;
    font-size: calc(11px * var(--fs-scale));
    text-align: center;
    white-space: nowrap;
    direction: ltr;
    unicode-bidi: isolate;
  }
  .hrow .nokbd { display: none; }
  .hdesc { min-width: 0; overflow-wrap: anywhere; }
  .hrow:has(.nokbd) .hdesc { color: var(--fg); }
  .help-mods {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 2px 0;
    border-top: 1px solid var(--border);
    font-size: calc(11.5px * var(--fs-scale));
    color: var(--fg-muted);
  }
  .help-mods kbd {
    padding: 1px 7px;
    border-radius: 6px;
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    background: var(--bg-panel);
    color: var(--fg);
    font-family: "JetBrains Mono", monospace;
    font-size: calc(10.5px * var(--fs-scale));
  }
</style>
