<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { panels } from "$lib/stores/panels.svelte";
  import { settings, THEMES, type ThemeId } from "$lib/stores/settings.svelte";
  import { LOCALES, type Locale } from "$lib/stores/i18n.svelte";
  import { appInfo, type AppInfo } from "$lib/api";
  import { update } from "$lib/stores/update.svelte";

  let appVer = $state<AppInfo | null>(null);
  $effect(() => {
    if (!appVer) {
      appInfo().then((i) => (appVer = i)).catch(() => {});
    }
  });

  function setViewFlag(patch: Partial<{ dirsFirst: boolean; showHidden: boolean; showSystem: boolean; markedFirst: boolean }>) {
    settings.set(patch);
    panels.refreshView();
  }

  // font-size stepper; the clamp/rounding lives in settings.stepFontSize —
  // the same method the Ctrl+± hotkeys use

  function setDecor(on: boolean) {
    settings.set({ editorDecor: on });
    void import("$lib/editor/cm").then(({ applyEditorDecor }) => applyEditorDecor());
  }
</script>

<div class="overlay">
  <div class="dlg" style="min-width:340px">
    <div class="dlg-title"><i class="ph-duotone ph-list"></i>{i18n.t("fkeys.f9")}</div>
    <div class="dlg-body">
      <div class="grp">{i18n.t("menu.view")}</div>
      <div class="checks">
        <label class="check">
          <input
            type="checkbox"
            checked={settings.s.dirsFirst}
            onchange={(e) => setViewFlag({ dirsFirst: e.currentTarget.checked })}
          />
          <span>{i18n.t("menu.dirsFirst")}</span>
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={settings.s.markedFirst}
            onchange={(e) => setViewFlag({ markedFirst: e.currentTarget.checked })}
          />
          <span>{i18n.t("menu.markedFirst")}</span>
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={settings.s.showHidden}
            onchange={(e) => setViewFlag({ showHidden: e.currentTarget.checked })}
          />
          <span>{i18n.t("menu.showHidden")}</span>
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={settings.s.showSystem}
            onchange={(e) => setViewFlag({ showSystem: e.currentTarget.checked })}
          />
          <span>{i18n.t("menu.showSystem")}</span>
        </label>
      </div>
      <button class="btn fc-open" onclick={() => ui.openDialog("fileColors")}>
        <i class="ph-duotone ph-palette"></i>{i18n.t("menu.fileColors")}
      </button>

      <div class="grp">{i18n.t("menu.fontSize")}</div>
      <div class="fs-row">
        <button class="btn fs-btn" title={i18n.t("menu.fontSize") + " −"} onclick={() => settings.stepFontSize(-0.5)} disabled={settings.s.fontSize <= 10}>
          <i class="ph ph-minus"></i>
        </button>
        <span class="fs-val mono">{settings.s.fontSize.toFixed(1)} px</span>
        <button class="btn fs-btn" title={i18n.t("menu.fontSize") + " +"} onclick={() => settings.stepFontSize(0.5)} disabled={settings.s.fontSize >= 24}>
          <i class="ph ph-plus"></i>
        </button>
      </div>

      <div class="grp">{i18n.t("menu.hlColors")}</div>
      <div class="hl-row">
        <label class="hl">
          <input
            type="color"
            value={settings.s.colors.selection ?? "#f97316"}
            title={i18n.t("menu.hlSelection")}
            oninput={(e) => settings.set({ colors: { ...settings.s.colors, selection: e.currentTarget.value } })}
          />
          <span>{i18n.t("menu.hlSelection")}</span>
        </label>
        <label class="hl">
          <input
            type="color"
            value={settings.s.colors.accent ?? "#8ee53f"}
            title={i18n.t("menu.hlAccent")}
            oninput={(e) => settings.set({ colors: { ...settings.s.colors, accent: e.currentTarget.value } })}
          />
          <span>{i18n.t("menu.hlAccent")}</span>
        </label>
        <button
          class="btn hl-reset"
          disabled={!settings.s.colors.selection && !settings.s.colors.accent}
          onclick={() => settings.set({ colors: { selection: null, accent: null } })}
        >
          {i18n.t("fc.reset")}
        </button>
      </div>

      <div class="grp">{i18n.t("menu.editor")}</div>
      <div class="checks">
        <label class="check">
          <input
            type="checkbox"
            checked={settings.s.editorDecor}
            onchange={(e) => setDecor(e.currentTarget.checked)}
          />
          <span>{i18n.t("menu.editorDecor")}</span>
        </label>
      </div>
      <button class="btn fc-open" onclick={() => ui.openDialog("textColors")}>
        <i class="ph-duotone ph-text-aa"></i>{i18n.t("menu.textRules")}
      </button>

      <div class="grp">{i18n.t("menu.themes")}</div>
      <div class="theme-grid">
        {#each THEMES as th (th.id)}
          <button
            class="btn thmb"
            class:on={settings.s.theme === th.id}
            onclick={() => settings.set({ theme: th.id as ThemeId })}
          >
            <span class="swatch" data-theme={th.id}></span>
            {i18n.t("theme." + th.id)}
          </button>
        {/each}
      </div>

      <div class="grp">{i18n.t("menu.language")}</div>
      <div class="lang-grid">
        {#each LOCALES as l (l.id)}
          <button class="btn lang" class:on={settings.s.locale === l.id} onclick={() => settings.set({ locale: l.id as Locale })}>
            {l.label}
          </button>
        {/each}
      </div>

      <div class="grp">{i18n.t("upd.section")}</div>
      <button class="btn fc-open" onclick={() => void update.check(true)}>
        <i class="ph-duotone ph-arrows-clockwise"></i>{i18n.t("upd.check")}
      </button>

      {#if appVer}
        <div class="about mono">
          {i18n.t("menu.about")} — v{appVer.version}
          <span class="dim">· {appVer.buildTime}</span>
        </div>
      {/if}
    </div>
    <div class="dlg-actions">
      <button class="btn" onclick={() => { void import("$lib/commands").then(({runCommand}) => runCommand("app.quit")); }}>
        <i class="ph ph-sign-out"></i>{i18n.t("menu.quit")}
      </button>
      <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
    </div>
  </div>
</div>

<style>
  .grp { color: var(--fg-muted); font-size: calc(11.5px * var(--fs-scale)); text-transform: uppercase; letter-spacing: 0.6px; margin: 12px 0 8px; }
  .grp:first-child { margin-top: 0; }
  .theme-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .lang-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
  .thmb, .lang { justify-content: flex-start; padding: 7px 10px; font-size: calc(12.5px * var(--fs-scale)); }
  .thmb.on, .lang.on { border-color: var(--accent); color: var(--fg); }

  /* view settings checkboxes */
  .checks { display: flex; flex-direction: column; gap: 7px; }
  .fc-open { width: 100%; justify-content: flex-start; margin-top: 8px; font-size: calc(12.5px * var(--fs-scale)); }
  .fc-open i { font-size: calc(16px * var(--fs-scale)); color: var(--accent2); }

  /* font-size stepper */
  .fs-row { display: flex; align-items: center; gap: 10px; }
  .fs-btn { width: 34px; height: 30px; padding: 0; justify-content: center; }
  .fs-val { min-width: 64px; text-align: center; color: var(--fg); font-size: calc(12.5px * var(--fs-scale)); }

  /* highlight color overrides — swatch + label rows, fc color input style */
  .hl-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .hl { display: flex; align-items: center; gap: 8px; font-size: calc(12.5px * var(--fs-scale)); color: var(--fg-dim); cursor: pointer; }
  .hl:hover { color: var(--fg); }
  .hl input[type="color"] {
    width: 36px; height: 26px; padding: 0; border: 1px solid var(--border);
    border-radius: var(--r-btn); background: var(--bg-elev); cursor: pointer;
  }
  .hl input[type="color"]::-webkit-color-swatch-wrapper { padding: 2px; }
  .hl input[type="color"]::-webkit-color-swatch { border: none; border-radius: 5px; }
  .hl-reset { padding: 5px 10px; font-size: calc(12px * var(--fs-scale)); }

  .about {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    font-size: calc(11px * var(--fs-scale));
    color: var(--fg-dim);
  }
  .about .dim { color: var(--fg-muted); }
  .swatch {
    width: 16px; height: 16px;
    border-radius: 5px;
    border: 1px solid var(--border-strong);
    background: #141619;
  }
  .swatch[data-theme="alnaviLight"] { background: #f4f5f7; }
  .swatch[data-theme="midnight"] { background: #0b1220; }
  .swatch[data-theme="solarized"] { background: #fdf6e3; }
  .swatch[data-theme="contrast"] { background: #000; }
</style>
