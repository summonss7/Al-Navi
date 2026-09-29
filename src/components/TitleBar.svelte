<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { onMount } from "svelte";
  import { settings, THEMES, type ThemeId } from "$lib/stores/settings.svelte";
  import { i18n, LOCALES, type Locale } from "$lib/stores/i18n.svelte";
  import { editor } from "$lib/stores/editor.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { ops } from "$lib/stores/ops.svelte";
  import { appInfo, type AppInfo } from "$lib/api";

  const win = getCurrentWindow();
  let maximized = $state(false);
  let info = $state<AppInfo | null>(null);

  onMount(() => {
    appInfo()
      .then((i) => (info = i))
      .catch(() => {});
    void win.isMaximized().then((m: boolean) => (maximized = m));
    const p1 = win.onResized(async () => {
      maximized = await win.isMaximized();
    });
    return () => {
      void p1.then((u) => u());
    };
  });

  const themeIcons: Record<string, string> = {
    alnaviDark: "ph-moon-stars",
    alnaviLight: "ph-sun",
    midnight: "ph-moon",
    solarized: "ph-sun-horizon",
    contrast: "ph-circle-half",
  };

  function cycleTheme() {
    const idx = THEMES.findIndex((t) => t.id === settings.s.theme);
    const next = THEMES[(idx + 1) % THEMES.length];
    settings.set({ theme: next.id });
  }

  function cycleLocale() {
    const idx = LOCALES.findIndex((l) => l.id === settings.s.locale);
    const next = LOCALES[(idx + 1) % LOCALES.length];
    settings.set({ locale: next.id });
  }
</script>

<header class="titlebar" data-tauri-drag-region>
  <div class="brand" data-tauri-drag-region>
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#8EE53F" d="M12 2.2 A9.8 9.8 0 1 0 20.4 7.1 L18.7 8.1 A7.9 7.9 0 1 1 12 4.1 Z" />
      <path fill="#F97316" d="M12 3.6 L13.5 10.5 L12 12 L10.5 10.5 Z" />
      <path fill="#8EE53F" d="M19.4 9.2 L14.6 13.2 L12.6 12.6 L13.2 10.6 Z" />
      <path fill="#8EE53F" d="M12 20.4 L10.5 13.5 L12 12 L13.5 13.5 Z" />
      <path fill="#8EE53F" d="M4.6 9.2 L9.4 13.2 L11.4 12.6 L10.8 10.6 Z" />
    </svg>
    <span class="brand-name">Al-<b class="brand-accent">Navi</b></span>
    {#if info}
      <span class="version" title={info.buildTime}>
        v{info.version} <span class="btime">· {info.buildTime}</span>
      </span>
    {/if}
  </div>

  {#if editor.docs.length || editor.viewDocs.length}
    <nav class="win-tabs">
      <button
        class="win-tab" class:active={ui.mode === "panels"}
        onclick={() => ui.setMode("panels")}
        title={i18n.t("windows.panels")}
      >
        <i class="ph-duotone ph-squares-four"></i>
      </button>
      {#each editor.docs as d (d.id)}
        <button
          class="win-tab"
          class:active={ui.mode === "editor" && editor.activeId === d.id}
          onclick={() => editor.activate(d.id)}
          title={d.name}
        >
          <span class="win-tab-name">{d.name}</span>
          {#if d.dirty}<span class="dot"></span>{/if}
          <span
            class="win-tab-close"
            role="button"
            tabindex="-1"
            onclick={(e) => { e.stopPropagation(); void editor.close(d.id); }}
          >✕</span>
        </button>
      {/each}
      {#each editor.viewDocs as d (d.id)}
        <button
          class="win-tab view"
          class:active={ui.mode === "viewer" && editor.activeViewId === d.id}
          onclick={() => editor.activate(d.id)}
          title={d.name}
        >
          <i class="ph-duotone ph-eye"></i>
          <span class="win-tab-name">{d.name}</span>
          <span
            class="win-tab-close"
            role="button"
            tabindex="-1"
            onclick={(e) => { e.stopPropagation(); void editor.closeViewer(d.id); }}
          >✕</span>
        </button>
      {/each}
    </nav>
  {/if}

  <div class="spacer" data-tauri-drag-region></div>

  {#if ops.op && ops.op.phase !== "done"}
    <button class="tb-btn op-indicator" onclick={() => ops.openProgress()} title={i18n.t("ops.progress")}>
      <i class="ph-fill ph-spinner-gap"></i>
    </button>
  {/if}

  <button class="tb-btn" onclick={cycleLocale} title={i18n.t("menu.language")}>
    {LOCALES.find((l) => l.id === settings.s.locale)?.label ?? "English"}
  </button>

  <button class="tb-btn" onclick={cycleTheme} title={i18n.t("menu.themes")}>
    <i class={"ph-duotone " + (themeIcons[settings.s.theme] ?? "ph-palette")}></i>
  </button>

  <div class="win-controls">
    <button class="wc" onclick={() => win.minimize()} title="_"><i class="ph ph-minus"></i></button>
    <button class="wc" onclick={() => win.toggleMaximize()} title="□">
      <i class={"ph " + (maximized ? "ph-copy" : "ph-square")}></i>
    </button>
    <button class="wc close" onclick={() => win.close()} title="✕"><i class="ph ph-x"></i></button>
  </div>
</header>

<style>
  .titlebar {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 38px;
    padding: 0 0 0 12px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    letter-spacing: 0.2px;
    color: var(--fg-dim);
  }
  .brand-name b { color: var(--fg); font-weight: 700; }
  .brand-accent { color: var(--accent2); }
  .brand-name b { color: var(--accent); }

  .version {
    font-size: 11px;
    color: var(--fg-muted);
    font-family: "JetBrains Mono", Consolas, monospace;
    white-space: nowrap;
  }
  .btime { opacity: 0.75; }

  .spacer { flex: 1; }

  .win-tabs {
    display: flex;
    gap: 4px;
    overflow: hidden;
    max-width: 50vw;
  }
  .win-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 7px;
    color: var(--fg-dim);
    border: 1px solid transparent;
    font-size: 12.5px;
    max-width: 180px;
  }
  .win-tab:hover { background: var(--row-hover); }
  .win-tab.active {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--fg);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .win-tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .win-tab.view.active {
    background: color-mix(in srgb, var(--accent2) 14%, transparent);
    border-color: color-mix(in srgb, var(--accent2) 40%, transparent);
  }
  .win-tab-close {
    border-radius: 4px;
    padding: 0 3px;
    font-size: 10px;
    color: var(--fg-muted);
  }
  .win-tab-close:hover { background: var(--danger); color: #fff; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent2); }

  .tb-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 7px;
    color: var(--fg-dim);
    font-size: 12.5px;
  }
  .tb-btn:hover { background: var(--row-hover); color: var(--fg); }
  .tb-btn i { font-size: 16px; }

  .op-indicator i { animation: spin 1.1s linear infinite; color: var(--accent2); }
  @keyframes spin { to { transform: rotate(360deg); } }

  .win-controls { display: flex; height: 100%; }
  .wc {
    width: 44px;
    height: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-dim);
    font-size: 15px;
  }
  .wc:hover { background: var(--row-hover); color: var(--fg); }
  .wc.close:hover { background: #e81123; color: #fff; }
</style>
