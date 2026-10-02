<script lang="ts">
  import type { PanelState } from "$lib/stores/panels.svelte";
  import { panels } from "$lib/stores/panels.svelte";
  import { runCommand } from "$lib/commands";
  import { cyrillicOfLatin } from "$lib/keymap";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { formatSize, formatCount, basename, parentOf, sortArrow } from "$lib/format";
  import { ftpAuthority, isFtpPath } from "$lib/ftp";
  import { isArchivePath, splitArchiveUrl, archiveUrl } from "$lib/archive";
  import { isSearchPath, searchStore } from "$lib/stores/search.svelte";
  import { settings, BASE_FONT_PX } from "$lib/stores/settings.svelte";
  import VirtualList from "./VirtualList.svelte";

  let { panel }: { panel: PanelState } = $props();

  // row height tracks the font-size setting so bigger text still fits its rows
  const rowHeight = $derived(Math.round((26 * settings.s.fontSize) / BASE_FONT_PX));

  const active = $derived(panels.active === panel);
  const stats = $derived.by(() => {
    void panel.version;
    void panel.selVersion;
    return panel.stats;
  });

  // ЙЦУКЕН twin of the accumulated Alt+letter prefix (always complete — every
  // latin letter has a mapping), shown in the quick-jump chip
  const qjCyr = $derived.by(() => {
    const p = panel.quickJumpPrefix;
    return p === null ? null : [...p].map((c) => cyrillicOfLatin(c) ?? "").join("");
  });

  function tabTitle(t: { path: string }) {
    if (isSearchPath(t.path)) return i18n.t("search.tab");
    return basename(t.path) || t.path;
  }

  // breadcrumb segments: clickable, per images/design.jpg
  const crumbs = $derived.by(() => {
    void panel.path;
    const p = panel.path;
    const out: { label: string; path: string }[] = [];
    if (isSearchPath(p)) {
      // one crumb summarizing the running search
      const m = searchStore.params?.mask || "*";
      out.push({ label: `${i18n.t("search.tab")}: ${m}`, path: p });
      return out;
    }
    if (isArchivePath(p)) {
      // archive file crumb (jumps back to its directory) + one per inner folder
      const { file, inner } = splitArchiveUrl(p);
      out.push({ label: basename(file), path: parentOf(file) ?? file });
      let acc = "";
      for (const part of inner.split("/").filter(Boolean)) {
        acc = acc ? `${acc}/${part}` : part;
        out.push({ label: part, path: archiveUrl(file, acc) });
      }
    } else if (isFtpPath(p)) {
      // "ftp://user@host:port" crumb + one crumb per remote folder
      const auth = ftpAuthority(p);
      out.push({ label: auth.slice("ftp://".length), path: auth });
      let acc = auth;
      for (const part of p.slice(auth.length).split("/").filter(Boolean)) {
        acc += "/" + part;
        out.push({ label: part, path: acc });
      }
    } else if (/^[a-zA-Z]:[\\/]/.test(p) || /^[a-zA-Z]:$/.test(p)) {
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

  // column captions double as sort buttons: first press sorts (name/ext
  // A→Z, date/size newest & largest first), pressing again reverses
  function sortBy(mode: "name" | "size" | "mtime") {
    if (!active) panels.activeSide = panel.side;
    runCommand(`panel.sort${mode === "name" ? "Name" : mode === "size" ? "Size" : "Mtime"}`);
  }

  const sortMark = (mode: "name" | "size" | "mtime") =>
    panel.sortMode === mode ? " " + sortArrow(mode, panel.sortDir) : "";
</script>

<!-- mousedown is prevented so clicks never steal the caret from the command
     line; the .vlist container itself is skipped to keep the native scrollbar -->
<section
  class="panel"
  class:active
  class:inactive={!active}
  onclick={() => { if (!active) panels.activeSide = panel.side; }}
  onmousedown={(e) => {
    if (!(e.target as HTMLElement).classList.contains("vlist")) e.preventDefault();
  }}
>
  <header class="p-head">
    <div class="tabs-row">
      <div class="tabs">
        {#each panel.tabs as t (t.id)}
          <button
            class="tab"
            class:on={t.id === panel.activeTabId}
            onclick={() => panel.activateTab(t.id)}
            title={isSearchPath(t.path) ? i18n.t("search.tab") : t.path}
          >
            {#if isSearchPath(t.path)}
              <i class="ph-duotone ph-magnifying-glass"></i>
            {:else}
              <i class="ph-duotone ph-folder-simple"></i>
            {/if}
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
      {#if panel.quickJumpPrefix !== null}
        <span class="qjump" title="Alt + …">
          <i class="ph ph-magnifying-glass"></i>
          {#if qjCyr}<b>{qjCyr}</b> · {/if}{panel.quickJumpPrefix.toLowerCase()}
        </span>
      {/if}
      <nav class="crumbs" title={isSearchPath(panel.path) ? undefined : panel.path}>
        {#each crumbs as c, i (c.path + i)}
          {#if i > 0}<span class="crumb-sep">/</span>{/if}
          <button
            class="crumb"
            class:last={i === crumbs.length - 1}
            onclick={() => void panel.chdir(c.path)}
          >{c.label}</button>
        {/each}
      </nav>
    </div>
  </header>

  <div class="cols">
    <span class="marker"></span>
    <span class="islot"></span>
    <button class="col name" class:on={panel.sortMode === "name"} onclick={() => sortBy("name")} title="Ctrl+F3">
      {i18n.t("col.name")}{sortMark("name")}
    </button>
    <button class="col size" class:on={panel.sortMode === "size"} onclick={() => sortBy("size")} title="Ctrl+F6">
      {i18n.t("col.size")}{sortMark("size")}
    </button>
    <button class="col date" class:on={panel.sortMode === "mtime"} onclick={() => sortBy("mtime")} title="Ctrl+F5">
      {i18n.t("col.date")}{sortMark("mtime")}
    </button>
    <span class="col attr">{i18n.t("col.attr")}</span>
  </div>

  <div class="list-wrap">
    <VirtualList {panel} {rowHeight} />
    {#if panel.error}
      <div class="overlay-msg">
        <i class="ph-duotone ph-warning"></i>
        <span>{panel.error}</span>
      </div>
    {:else if panel.view.length === 0 || (panel.view.length === 1 && panel.view[0].name === "..")}
      <div class="overlay-msg soft">
        {#if isSearchPath(panel.path)}
          {searchStore.running ? i18n.t("search.searching") : i18n.t("search.nothing")}
        {:else}
          {i18n.t("panel.empty")}
        {/if}
      </div>
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
    {:else if isSearchPath(panel.path)}
      <span class="free search-st">
        {#if searchStore.running}
          <i class="ph ph-spinner-gap"></i>
          {i18n.t("search.scannedN", { n: formatCount(searchStore.scanned, i18n.locale) })}
          · {i18n.t("search.foundN", { n: formatCount(searchStore.hits.length, i18n.locale) })}
          · <b>Esc</b>
        {:else}
          {i18n.t("search.foundN", { n: formatCount(searchStore.hits.length, i18n.locale) })}
          {#if searchStore.cancelled} · {i18n.t("search.cancelled")}{/if}
          {#if searchStore.elapsedMs} · {(searchStore.elapsedMs / 1000).toFixed(1)}s{/if}
        {/if}
      </span>
    {/if}
  </footer>
</section>

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
  /* inactive panel: cursor row dims to gray instead of the theme highlight;
     rows in VirtualList are colored through these custom properties */
  .panel.inactive {
    --row-cursor-bg: rgba(127, 127, 127, 0.3);
    --row-cursor-fg: var(--fg);
    --row-cursor-border: transparent;
    --row-cursor-glow: none;
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
    font-size: calc(12px * var(--fs-scale));
    font-weight: 600;
    max-width: 160px;
    border: 1px solid transparent;
    flex-shrink: 0;
  }
  .tab i { font-size: calc(14px * var(--fs-scale)); }
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
    font-size: calc(14px * var(--fs-scale));
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
    font-size: calc(12.5px * var(--fs-scale));
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
  .crumb-sep { color: var(--fg-muted); font-size: calc(11.5px * var(--fs-scale)); flex-shrink: 0; }
  .qjump {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: var(--r-tab);
    background: var(--row-cursor-bg);
    border: 1px solid var(--row-cursor-border);
    color: var(--accent2);
    font-size: calc(11.5px * var(--fs-scale));
    font-weight: 700;
    flex-shrink: 0;
    direction: ltr;
  }
  .qjump i { font-size: calc(12px * var(--fs-scale)); }
  .qjump b { font-weight: 800; }

  .list-wrap { position: relative; flex: 1; min-height: 0; }

  /* column captions: same geometry as the rows below (marker + icon slot +
     name/size/date/attr), clicking a caption sorts, clicking again reverses */
  .cols {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-inline: 5px;
    padding-inline: 4px;
    height: calc(22px * var(--fs-scale));
    color: var(--fg-muted);
    border-bottom: 1px solid var(--border);
    background: var(--bg-header);
    flex-shrink: 0;
    user-select: none;
  }
  .cols .marker { width: 5px; flex-shrink: 0; }
  .cols .islot { width: 19px; flex-shrink: 0; }
  .col {
    padding: 0;
    color: var(--fg-muted);
    font-size: calc(11px * var(--fs-scale));
    font-weight: 700;
    letter-spacing: 0.2px;
    white-space: nowrap;
  }
  .col:hover { color: var(--fg); }
  .col.on { color: var(--accent2); }
  .col.name { flex: 1; min-width: 0; text-align: start; }
  .col.size { width: calc(78px * var(--fs-scale)); text-align: end; }
  .col.date { width: calc(128px * var(--fs-scale)); text-align: center; }
  .col.attr { width: calc(68px * var(--fs-scale)); text-align: center; }
  [dir="rtl"] .col.size { text-align: start; }

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
  .overlay-msg i { font-size: calc(34px * var(--fs-scale)); }
  .overlay-msg.soft { color: var(--fg-muted); }

  .p-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    font-size: calc(11.5px * var(--fs-scale));
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
  .search-st i {
    display: inline-block;
    animation: search-spin 1s linear infinite;
    vertical-align: -2px;
  }
  .search-st b { font-weight: 800; }
  @keyframes search-spin {
    to { transform: rotate(360deg); }
  }
</style>
