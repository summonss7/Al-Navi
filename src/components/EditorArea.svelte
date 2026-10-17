<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView } from "@codemirror/view";
  import {
    createView,
    setStateFor,
    lineColOf,
    setActiveView,
    capturePos,
    restorePos,
  } from "$lib/editor/cm";
  import { editor } from "$lib/stores/editor.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { ENCODINGS } from "$lib/encodings";

  let host: HTMLDivElement | undefined = $state();
  let view: EditorView | null = null;
  let pos = $state({ line: 1, col: 1, sel: 0, ch: "", code: null as number | null });
  let stats = $state({ chars: 0, lines: 1, spaces: 0 });
  let statsTimer: ReturnType<typeof setTimeout> | undefined;
  let lastDocId = -1;
  /** content revision of lastDocId — F8 encoding reloads bump the doc's rev
   *  without changing its id, the swap effect reacts to it */
  let lastRev = 0;
  /** true while a programmatic doc swap runs — its change events must not
   *  mark the target document dirty */
  let switching = false;

  /** document totals for the status bar: characters (code points, a surrogate
   *  pair counts once), lines, spaces. One pass, no allocations. */
  function countStats(text: string) {
    let spaces = 0;
    let chars = 0;
    let nl = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 32) spaces++;
      else if (c === 10) nl++;
      if (c >= 0xd800 && c <= 0xdbff) {
        const n = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
        if (n >= 0xdc00 && n <= 0xdfff) i++;
      }
      chars++;
    }
    stats = { chars, lines: nl + 1, spaces };
  }

  /** recount now for small docs; a 64MB pass would lag typing, so big ones
   *  wait for a pause */
  function scheduleStats(text: string) {
    clearTimeout(statsTimer);
    if (text.length <= 1_000_000) countStats(text);
    else statsTimer = setTimeout(() => countStats(text), 300);
  }

  const EOLS = [
    { id: "lf", label: "LF" },
    { id: "crlf", label: "CRLF" },
    { id: "cr", label: "CR" },
    { id: "keep", label: "—" },
  ];

  const doc = $derived(editor.active);

  onMount(() => {
    if (!host) return;
    view = createView(host, doc?.text ?? "", doc?.path ?? null, {
      onChange: (text) => {
        if (!editor.activeId || switching) return;
        editor.setText(editor.activeId, text);
        editor.markDirty(editor.activeId, true);
        pos = lineColOf(view!);
        scheduleStats(text);
      },
    });
    countStats(doc?.text ?? "");
    setActiveView(view);
    lastDocId = editor.activeId ?? -1;
    lastRev = doc?.rev ?? 0;
    // returning to the editor (or a doc reopened after restart): put the
    // caret and scroll back where they were
    if (doc?.pos) restorePos(view, doc.pos);

    const trackPos = setInterval(() => {
      if (!view) return;
      pos = lineColOf(view);
      // keep the stored position fresh so a quit/beforeunload persists it
      // without waiting for a tab switch
      if (editor.activeId) editor.savePos(editor.activeId, capturePos(view));
    }, 300);

    return () => {
      clearInterval(trackPos);
      clearTimeout(statsTimer);
      // remember the caret position before the view is torn down — the
      // component remounts on every mode switch
      if (view && editor.activeId) editor.savePos(editor.activeId, capturePos(view));
      view?.destroy();
      setActiveView(null);
    };
  });

  // caret into the text whenever the editor opens and after any dialog closes
  // (save-as, confirm, goto-line); the component remounts on every mode switch
  $effect(() => {
    if (ui.dialog !== null) return;
    requestAnimationFrame(() => view?.focus());
  });

  // switch content when the active document changes — or when the same
  // document is re-read in another encoding (F8: rev bump, id unchanged)
  $effect(() => {
    const id = editor.activeId ?? -1;
    const d = editor.active;
    if (!view || !d) return;
    if (id === lastDocId && d.rev === lastRev) return;
    if (id !== lastDocId) {
      if (lastDocId !== -1) editor.savePos(lastDocId, capturePos(view));
      lastDocId = id;
    }
    lastRev = d.rev;
    switching = true;
    setStateFor(view, d.text, d.path);
    switching = false;
    if (d.pos) restorePos(view, d.pos);
    scheduleStats(d.text);
    view.focus();
  });

  function eolLabel(id: string) {
    return EOLS.find((e) => e.id === id)?.label ?? id.toUpperCase();
  }
</script>

{#if doc}
  <div class="editor">
    <div class="doc-tabs">
      {#each editor.docs as d (d.id)}
        <button
          class="doc-tab"
          class:on={d.id === editor.activeId}
          onclick={() => editor.activate(d.id)}
          onmousedown={(e) => e.preventDefault()}
          title={d.path ?? d.name}
        >
          {#if d.dirty}<span class="dot">●</span>{/if}
          <span class="doc-name">{d.name}</span>
          <span
            class="x"
            role="button"
            tabindex="-1"
            aria-label="close"
            onclick={(e) => {
              e.stopPropagation();
              void editor.close(d.id);
            }}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                void editor.close(d.id);
              }
            }}
          >×</span>
        </button>
      {/each}
    </div>

    <div class="ed-status top">
      <span class="path mono" title={doc.path ?? ""}>{doc.path ?? doc.name}</span>
      {#if doc.dirty}<span class="dirty">●</span>{/if}
      {#if doc.truncated}<span class="warn" title={i18n.t("editor.truncated")}><i class="ph ph-warning"></i> 64MB</span>{/if}
    </div>

    <div class="cm-host" bind:this={host}></div>

    <div class="ed-status">
      <span class="mono">{i18n.t("editor.line")} {pos.line}, {i18n.t("editor.col")} {pos.col}</span>
      {#if pos.code !== null}
        <span class="mono dim char-chip" title={i18n.t("editor.charUnder")}
          >'{pos.ch}' {pos.code} 0x{pos.code.toString(16).toUpperCase().padStart(2, "0")}</span
        >
      {/if}
      {#if pos.sel}<span class="mono dim">{i18n.t("editor.sel")} {pos.sel}</span>{/if}
      <span class="grow"></span>
      <span class="mono dim totals" title={i18n.t("editor.totals")}>{i18n.t("editor.totalChars")} {stats.chars} · {i18n.t("editor.totalLines")} {stats.lines} · {i18n.t("editor.totalSpaces")} {stats.spaces}</span>
      <label>
        {i18n.t("editor.eol")}
        <select value={doc.eol} onchange={(e) => (doc.eol = (e.currentTarget as HTMLSelectElement).value)}>
          {#each EOLS as e (e.id)}<option value={e.id}>{e.label}</option>{/each}
        </select>
      </label>
      <label>
        {i18n.t("editor.encoding")}
        <select
          value={doc.encoding}
          onchange={(e) => {
            const sel = e.currentTarget as HTMLSelectElement;
            const enc = sel.value;
            // revert the visible choice until the reload lands — a cancelled
            // confirm (dirty doc) must not leave a stale label on screen
            sel.value = doc.encoding;
            void editor.reopenWithEncoding(doc.id, enc);
          }}
        >
          {#each ENCODINGS as enc (enc.id)}<option value={enc.id}>{enc.label}</option>{/each}
        </select>
      </label>
    </div>
  </div>
{:else}
  <div class="no-doc">
    <i class="ph-duotone ph-note-pencil"></i>
  </div>
{/if}

<style>
  .editor {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .ed-status {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 5px 12px;
    background: var(--bg-header);
    font-size: calc(11.5px * var(--fs-scale));
    color: var(--fg-dim);
    flex-shrink: 0;
  }
  .ed-status.top { border-bottom: 1px solid var(--border); }
  .ed-status:not(.top) { border-top: 1px solid var(--border); }
  .doc-tabs {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 6px 8px 0;
    background: var(--bg-header);
    flex-shrink: 0;
  }
  .doc-tabs::-webkit-scrollbar { display: none; }
  .doc-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: var(--r-tab);
    color: var(--fg-dim);
    font-size: calc(12px * var(--fs-scale));
    font-weight: 600;
    max-width: 180px;
    border: 1px solid transparent;
    flex-shrink: 0;
  }
  .doc-tab:hover { color: var(--fg); background: var(--row-hover); }
  .doc-tab.on {
    background: color-mix(in srgb, var(--accent) 24%, transparent);
    color: var(--accent-ink);
  }
  .doc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { color: var(--accent2); font-size: calc(10px * var(--fs-scale)); }
  .x {
    padding: 0 3px;
    border-radius: 5px;
    color: var(--fg-muted);
    font-size: calc(13px * var(--fs-scale));
    line-height: 1;
  }
  .x:hover { color: var(--danger); background: var(--row-hover); }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr; }
  .dirty { color: var(--accent2); }
  .warn { color: var(--accent2); }
  .grow { flex: 1; }
  .dim { color: var(--fg-muted); }
  /* caret-following chip must never fold; the totals ellipsize when the bar
   * gets crowded so the EOL/encoding selects stay intact */
  .char-chip { white-space: nowrap; flex-shrink: 0; }
  .totals {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex-shrink: 1;
    min-width: 0;
  }
  label { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
  select {
    font-size: calc(11.5px * var(--fs-scale));
    padding: 2px 6px;
    border-radius: 5px;
    background: var(--bg);
    border: 1px solid var(--border);
  }
  .cm-host { flex: 1; min-height: 0; overflow: hidden; }
  .cm-host :global(.cm-editor) { height: 100%; }

  .no-doc {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-muted);
    font-size: calc(44px * var(--fs-scale));
  }
</style>
