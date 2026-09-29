<script lang="ts">
  import type { PanelState } from "$lib/stores/panels.svelte";
  import { iconFor, UP_ICON } from "$lib/fileIcons";
  import { formatSize, formatDate } from "$lib/format";
  import { i18n } from "$lib/stores/i18n.svelte";

  let { panel, rowHeight = 26 }: { panel: PanelState; rowHeight?: number } = $props();

  let container: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let viewportH = $state(400);
  let ensureIndex = $state(-1);

  const OVERSCAN = 6;

  // react to selection/encoding changes that alter row text
  $effect(() => {
    void i18n.locale;
    void panel.selVersion;
  });

  // scroll cursor into view when moved by keyboard
  $effect(() => {
    const c = panel.cursor;
    if (c < 0 || !container) return;
    const top = c * rowHeight;
    const bottom = top + rowHeight;
    if (top < scrollTop) container.scrollTop = top;
    else if (bottom > scrollTop + viewportH) container.scrollTop = bottom - viewportH;
  });

  const start = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN));
  const end = $derived(Math.min(panel.view.length, Math.ceil((scrollTop + viewportH) / rowHeight) + OVERSCAN));

  function onScroll() {
    if (container) {
      scrollTop = container.scrollTop;
      ensureIndex = -1;
    }
  }

  function fmtDate(ms: number) {
    return formatDate(ms, i18n.locale);
  }

  function clickRow(i: number, e: MouseEvent) {
    if (e.shiftKey) {
      // shift-click: range select from previous cursor to clicked row
      const prev = panel.cursor;
      panel.cursor = i;
      const [a, b] = [Math.min(i, prev), Math.max(i, prev)];
      const next = new Set(panel.selected);
      for (let k = a; k <= b; k++) {
        const en = panel.view[k];
        if (en && en.name !== "..") next.add(en.name);
      }
      panel.selected = next;
      panel.selVersion++;
    } else if (e.ctrlKey) {
      panel.toggleAt(i, false);
    } else {
      panel.cursor = i;
    }
  }

  function dblClickRow(i: number) {
    panel.cursor = i;
    void panel.enter();
  }
</script>

<div
  class="vlist"
  bind:this={container}
  onscroll={onScroll}
>
  <div class="spacer" style="height:{panel.view.length * rowHeight}px"></div>
  <div class="rows" style="transform: translateY({start * rowHeight}px)">
    {#each panel.view.slice(start, end) as e, k (start + k)}
      {@const i = start + k}
      {@const up = e.name === ".."}
      {@const ic = up ? UP_ICON : iconFor(e.name, e.isDir, e.isSymlink)}
      {@const selected = !up && panel.selected.has(e.name)}
      <div
        class="row"
        class:cursor={i === panel.cursor}
        class:selected
        class:dir={e.isDir && !up}
        style="height:{rowHeight}px"
        role="option"
        aria-selected={i === panel.cursor}
        onclick={(ev) => clickRow(i, ev)}
        ondblclick={() => dblClickRow(i)}
      >
        <span class="marker {selected ? 'on' : ''}"></span>
        <i class={"ph-duotone " + ic.icon} style="color:{ic.color}"></i>
        <span class="name" title={e.name}>{up ? ".." : e.name}</span>
        <span class="size mono">{up || e.isDir ? "<DIR>" : formatSize(e.size)}</span>
        <span class="date">{up ? "" : fmtDate(e.mtime)}</span>
        <span class="attr">{up ? "" : e.attrs}</span>
      </div>
    {/each}
  </div>
</div>

<style>
  .vlist {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .spacer { position: absolute; inset: 0; pointer-events: none; }
  .rows { position: absolute; inset-inline: 0; top: 0; }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-inline: 5px;
    padding-inline: 4px;
    font-size: 13px;
    cursor: default;
    white-space: nowrap;
    border-radius: 8px;
  }
  .row:hover { background: var(--row-hover); }

  .marker {
    width: 5px;
    height: 16px;
    border-radius: 3px;
    flex-shrink: 0;
    background: transparent;
  }
  .marker.on { background: var(--accent2); }

  .row.selected { background: var(--row-selected); }
  .row.selected .name { color: var(--fg); }

  /* cursor: solid bar in dark themes; orange rounded-rect + glow in light */
  .row.cursor {
    background: var(--row-cursor-bg);
    color: var(--row-cursor-fg);
    box-shadow: inset 0 0 0 2px var(--row-cursor-border), var(--row-cursor-glow);
  }
  .row.cursor .name, .row.cursor .size, .row.cursor .date, .row.cursor .attr { color: var(--row-cursor-fg); }
  /* solid-cursor themes (dark): recolor icons for contrast; outline cursor keeps file colors */
  :global([data-cursor="solid"]) .row.cursor :global(i) { color: var(--row-cursor-fg) !important; }

  .row i {
    font-size: 17px;
    flex-shrink: 0;
    width: 19px;
    text-align: center;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--fg);
  }
  .dir .name { font-weight: 600; }
  .size {
    width: 78px;
    text-align: end;
    color: var(--fg-dim);
    font-size: 12px;
    flex-shrink: 0;
  }
  .date {
    width: 128px;
    color: var(--fg-dim);
    font-size: 12px;
    flex-shrink: 0;
    text-align: center;
  }
  .attr {
    width: 68px;
    color: var(--fg-muted);
    font-size: 11.5px;
    flex-shrink: 0;
    text-align: center;
    font-family: "JetBrains Mono", monospace;
  }

  [dir="rtl"] .size { text-align: start; }
</style>
