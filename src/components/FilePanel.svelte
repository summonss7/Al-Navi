<script lang="ts">
  import type { PanelState } from "$lib/stores/panels.svelte";
  import { panels } from "$lib/stores/panels.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { formatSize, formatCount, basename, joinPath } from "$lib/format";
  import VirtualList from "./VirtualList.svelte";

  let { panel }: { panel: PanelState } = $props();

  const active = $derived(panels.active === panel);
  const stats = $derived.by(() => {
    void panel.version;
    void panel.selVersion;
    return panel.stats;
  });

  function tabTitle(t: { path: string }) {
    return basename(t.path) || t.path;
  }

  // breadcrumb segments: clickable, per images/design.jpg
  const crumbs = $derived.by(() => {
    void panel.path;
    const p = panel.path;
    const out: { label: string; path: string }[] = [];
    if (/^[a-zA-Z]:[\\/]/.test(p) || /^[a-zA-Z]:$/.test(p)) {
      const parts = p.split(/[\\/]+/).filter(Boolean);
      out.push({ label: parts[0], path: parts[0] + "\\" });
      for (let i = 1; i < parts.length; i++) {
        out.push({ label: parts[i], path: parts.slice(0, i + 1).join("\\") });
      }
    } else if (p.startsWith("/")) {
      out.push({ label: "/", path: "/" });
      const parts = p.split("/").filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        out.push({ label: parts[i], path: "/" + parts.slice(0, i + 1).join("/") });
      }
    } else {
      out.push({ label: p, path: p });
    }
    return out;
  });

  function onQuickKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      panel.quickFilter = null;
      panel.rebuild();
      e.preventDefault();
    } else if (e.key === "Enter") {
      const q = panel.quickFilter ?? "";
      const matches = panel.view.filter((x) => x.name !== ".." && x.name.toLowerCase().includes(q.toLowerCase()));
      if (matches.length === 1 && matches[0].isDir) {
        void panel.chdir(joinPath(panel.path, matches[0].name));
      }
      panel.quickFilter = null;
      panel.rebuild();
      e.preventDefault();
    }
    e.stopPropagation();
  }
</script>

<section
  class="panel"
  class:active
  class:inactive={!active}
  onclick={() => { if (!active) panels.activeSide = panel.side; }}
>
  <header class="p-head">
    <div class="tabs-row">
      <div class="tabs">
        {#each panel.tabs as t (t.id)}
          <button
            class="tab"
            class:on={t.id === panel.activeTabId}
            onclick={() => panel.activateTab(t.id)}
            title={t.path}
          >
            <i class="ph-duotone ph-folder-simple"></i>
            <span class="tab-name">{tabTitle(t)}</span>
          </button>
        {/each}
        <button class="tab new" onclick={() => panel.newTab()} title="Ctrl+T">
          <i class="ph ph-plus"></i>
        </button>
      </div>
      <div class="p-head-actions">
        <button class="mini" onclick={() => void panel.historyBack()} title="Alt+Shift+←">
          <i class="ph ph-arrow-left"></i>
        </button>
        <button class="mini" onclick={() => void panel.historyForward()} title="Alt+Shift+→">
          <i class="ph ph-arrow-right"></i>
        </button>
        <button class="mini" onclick={() => panel.refresh()} title="Ctrl+R">
          <i class="ph ph-arrow-clockwise"></i>
        </button>
      </div>
    </div>
    <div class="path-row">
      {#if panel.quickFilter !== null}
        <input
          class="quick"
          placeholder={i18n.t("panel.quickSearch") + "…"}
          bind:value={panel.quickFilter}
          oninput={() => panel.rebuild()}
          onkeydown={onQuickKey}
          use:focusEl
        />
      {:else}
        <nav class="crumbs" title={panel.path}>
          {#each crumbs as c, i (c.path + i)}
            {#if i > 0}<span class="crumb-sep">/</span>{/if}
            <button
              class="crumb"
              class:last={i === crumbs.length - 1}
              onclick={() => void panel.chdir(c.path)}
            >{c.label}</button>
          {/each}
        </nav>
      {/if}
    </div>
  </header>

  <div class="list-wrap">
    <VirtualList {panel} />
    {#if panel.error}
      <div class="overlay-msg">
        <i class="ph-duotone ph-warning"></i>
        <span>{panel.error}</span>
      </div>
    {:else if panel.view.length <= 1}
      <div class="overlay-msg soft">{i18n.t("panel.empty")}</div>
    {/if}
  </div>

  <footer class="p-foot">
    {#if stats.selFiles || stats.selDirs}
      <span class="sel">
        {formatCount(stats.selFiles, i18n.locale)} {i18n.t("panel.files")},
        {formatCount(stats.selDirs, i18n.locale)} {i18n.t("panel.dirs")},
        {formatSize(stats.selBytes)} {i18n.t("panel.selected")}
      </span>
      <span class="sep"></span>
    {/if}
    <span>
      {formatCount(stats.files, i18n.locale)} {i18n.t("panel.files")},
      {formatCount(stats.dirs, i18n.locale)} {i18n.t("panel.dirs")}
    </span>
    <span class="grow"></span>
    {#if panel.free}
      <span class="free">
        {i18n.t("panel.free")} {formatSize(panel.free)} / {i18n.t("panel.total")} {formatSize(panel.total)}
      </span>
    {/if}
  </footer>
</section>

<script module lang="ts">
  export function focusEl(node: HTMLInputElement) {
    node.focus();
    node.select?.();
  }
</script>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    background: var(--bg-panel-inactive);
    border: 1px solid var(--border);
    border-radius: var(--r-card);
    overflow: hidden;
    min-width: 0;
  }
  .panel.active {
    background: var(--bg-panel);
    border-color: color-mix(in srgb, var(--accent2) 45%, var(--border));
    box-shadow:
      var(--card-shadow),
      0 0 0 1px color-mix(in srgb, var(--accent2) 28%, transparent);
  }

  .p-head {
    background: var(--bg-header);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .tabs-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px 0;
  }
  .tabs {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    scrollbar-width: none;
    flex: 1;
    min-width: 0;
  }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 12px;
    border-radius: var(--r-tab);
    color: var(--fg-dim);
    font-size: 12px;
    font-weight: 600;
    max-width: 160px;
    border: 1px solid transparent;
    flex-shrink: 0;
  }
  .tab i { font-size: 14px; }
  .tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab:hover { color: var(--fg); background: var(--row-hover); }
  .tab.on {
    background: color-mix(in srgb, var(--accent) 24%, transparent);
    color: var(--accent-ink);
  }
  .panel.active .tab.on { color: var(--accent-ink); }
  .tab.new { padding-inline: 8px; }
  .p-head-actions { display: flex; gap: 2px; padding-bottom: 3px; }
  .mini {
    padding: 3px 7px;
    border-radius: var(--r-tab);
    color: var(--fg-muted);
    font-size: 14px;
  }
  .mini:hover { color: var(--fg); background: var(--row-hover); }

  .path-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    min-height: 32px;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 2px;
    overflow: hidden;
    white-space: nowrap;
    direction: ltr;
    flex: 1;
    min-width: 0;
  }
  .crumb {
    padding: 1px 4px;
    border-radius: 6px;
    color: var(--fg-dim);
    font-size: 12.5px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .crumb:not(:first-of-type) {
    flex-shrink: 1;
    min-width: 24px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crumb:hover { color: var(--accent-ink); background: var(--row-hover); }
  .crumb.last { color: var(--fg); font-weight: 700; }
  .panel.active .crumb.last { color: var(--accent-ink); }
  .crumb-sep { color: var(--fg-muted); font-size: 11.5px; flex-shrink: 0; }
  .quick {
    flex: 1;
    padding: 3px 12px;
    font-size: 12.5px;
    border-radius: var(--r-tab);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
    border-color: var(--accent);
    direction: ltr;
  }

  .list-wrap { position: relative; flex: 1; min-height: 0; }

  .overlay-msg {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--fg-dim);
    background: color-mix(in srgb, var(--bg-panel) 82%, transparent);
    pointer-events: none;
    padding: 20px;
    text-align: center;
    word-break: break-all;
  }
  .overlay-msg i { font-size: 34px; }
  .overlay-msg.soft { color: var(--fg-muted); }

  .p-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    font-size: 11.5px;
    color: var(--fg-dim);
    border-top: 1px solid var(--border);
    background: var(--bg-header);
    flex-shrink: 0;
    white-space: nowrap;
    overflow: hidden;
  }
  .sel { color: var(--accent2); font-weight: 700; }
  .sep { width: 1px; height: 12px; background: var(--border); }
  .grow { flex: 1; }
  .free { color: var(--fg-muted); }
</style>
