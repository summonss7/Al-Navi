<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { onMount } from "svelte";
  import { settings, THEMES } from "$lib/stores/settings.svelte";
  import { i18n, LOCALES } from "$lib/stores/i18n.svelte";
  import { editor } from "$lib/stores/editor.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { ops } from "$lib/stores/ops.svelte";
  import { appInfo, type AppInfo } from "$lib/api";

  // null when opened in a plain browser (dev preview, no Tauri backend)
  const win = "__TAURI_INTERNALS__" in window ? getCurrentWindow() : null;
  let maximized = $state(false);
  let info = $state<AppInfo | null>(null);

  onMount(() => {
    appInfo()
      .then((i) => (info = i))
      .catch(() => {});
    void win?.isMaximized().then((m: boolean) => (maximized = m));
    const p1 = win?.onResized(async () => {
      maximized = await win.isMaximized();
    });
    return () => {
      void p1?.then((u) => u());
    };
  });

  const themeIcons: Record<string, string> = {
    alnaviDark: "ph-moon-stars",
    alnaviLight: "ph-sun",
    midnight: "ph-moon",
    solarized: "ph-sun-horizon",
    contrast: "ph-circle-half",
  };

  // brand compass mark (images/icon.jpg): 8-point star — east half orange,
  // west half lime; NE needle crosses the broken lime ring.
  // CSS vars so the mark follows user highlight-color overrides
  const LIME = "var(--accent)";
  const ORANGE = "var(--accent2)";
  function kite(aDeg: number, tipR: number, w: number) {
    const a = (aDeg * Math.PI) / 180;
    const pt = (r: number, ang: number) =>
      `${(12 + r * Math.cos(ang)).toFixed(2)} ${(12 + r * Math.sin(ang)).toFixed(2)}`;
    return [
      pt(tipR, a),
      pt(w, a + Math.PI / 2),
      pt(w * 0.72, a + Math.PI),
      pt(w, a - Math.PI / 2),
    ].join(" ");
  }
  const STAR = [
    { pts: kite(-45, 10.6, 2), fill: ORANGE },
    { pts: kite(0, 7.2, 1.8), fill: ORANGE },
    { pts: kite(45, 5, 1.5), fill: ORANGE },
    { pts: kite(-90, 7.2, 1.8), fill: LIME },
    { pts: kite(90, 7.2, 1.8), fill: LIME },
    { pts: kite(180, 7.2, 1.8), fill: LIME },
    { pts: kite(135, 5, 1.5), fill: LIME },
    { pts: kite(-135, 5, 1.5), fill: LIME },
  ];

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
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12" cy="12" r="8.4" fill="none" stroke={LIME} stroke-width="2.4"
        stroke-linecap="round" pathLength="100" stroke-dasharray="72 28"
        transform="rotate(5.4 12 12)"
      />
      {#each STAR as s}
        <polygon points={s.pts} fill={s.fill} />
      {/each}
      <circle cx="12" cy="12" r="1.7" fill={ORANGE} />
      <circle cx="12" cy="12" r="0.7" fill="#F0EEE6" />
    </svg>
    <span class="brand-name"><b class="al">Al-</b><b class="navi">Navi</b></span>
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

  {#if win}
    <div class="win-controls">
      <button class="wc" onclick={() => win.minimize()} title="_"><i class="ph ph-minus"></i></button>
      <button class="wc" onclick={() => win.toggleMaximize()} title="□">
        <i class={"ph " + (maximized ? "ph-copy" : "ph-square")}></i>
      </button>
      <button class="wc close" onclick={() => win.close()} title="✕"><i class="ph ph-x"></i></button>
    </div>
  {/if}
</header>

<style>
  .titlebar {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 40px;
    padding: 0 0 0 12px;
    background: var(--bg-chrome);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: calc(16px * var(--fs-scale));
    letter-spacing: 0.2px;
  }
  .brand-name .al { color: var(--accent-ink); }
  .brand-name .navi { color: var(--accent2); }
  .brand-name b { font-weight: 800; }

  .version {
    font-size: calc(11px * var(--fs-scale));
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
    padding: 4px 10px;
    border-radius: var(--r-tab);
    color: var(--fg-dim);
    border: 1px solid transparent;
    font-size: calc(12.5px * var(--fs-scale));
    font-weight: 600;
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
    font-size: calc(10px * var(--fs-scale));
    color: var(--fg-muted);
  }
  .win-tab-close:hover { background: var(--danger); color: #fff; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent2); }

  .tb-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border-radius: var(--r-tab);
    color: var(--fg-dim);
    font-size: calc(12.5px * var(--fs-scale));
    font-weight: 600;
  }
  .tb-btn:hover { background: var(--row-hover); color: var(--fg); }
  .tb-btn i { font-size: calc(16px * var(--fs-scale)); }

  .op-indicator i { animation: spin 1.1s linear infinite; color: var(--accent2); }
  @keyframes spin { to { transform: rotate(360deg); } }

  .win-controls { display: flex; height: 100%; }
  .wc {
    width: 44px;
    height: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--accent2);
    font-size: calc(15px * var(--fs-scale));
  }
  .wc:hover { background: color-mix(in srgb, var(--accent2) 14%, transparent); color: var(--accent2); }
  .wc.close:hover { background: #e81123; color: #fff; }
</style>
