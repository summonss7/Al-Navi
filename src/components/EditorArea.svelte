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

  let host: HTMLDivElement | undefined = $state();
  let view: EditorView | null = null;
  let pos = $state({ line: 1, col: 1, sel: 0 });
  let lastDocId = -1;
  /** true while a programmatic doc swap runs — its change events must not
   *  mark the target document dirty */
  let switching = false;

  const ENCODINGS = ["utf-8", "utf-16le", "utf-16be", "windows-1251", "koi8-r", "cp866", "iso-8859-5"];
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
      },
    });
    setActiveView(view);
    lastDocId = editor.activeId ?? -1;
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

  // switch content when the active document changes
  $effect(() => {
    const id = editor.activeId ?? -1;
    const d = editor.active;
    if (!view || !d) return;
    if (id === lastDocId) return;
    if (lastDocId !== -1) editor.savePos(lastDocId, capturePos(view));
    lastDocId = id;
    switching = true;
    setStateFor(view, d.text, d.path);
    switching = false;
    if (d.pos) restorePos(view, d.pos);
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
      {#if pos.sel}<span class="mono dim">{i18n.t("editor.sel")} {pos.sel}</span>{/if}
      <span class="grow"></span>
      <label>
        {i18n.t("editor.eol")}
        <select value={doc.eol} onchange={(e) => (doc.eol = (e.currentTarget as HTMLSelectElement).value)}>
          {#each EOLS as e (e.id)}<option value={e.id}>{e.label}</option>{/each}
        </select>
      </label>
      <label>
        {i18n.t("editor.encoding")}
        <select value={doc.encoding} onchange={(e) => editor.setEncoding(doc.id, (e.currentTarget as HTMLSelectElement).value)}>
          {#each ENCODINGS as enc (enc)}<option value={enc}>{enc}</option>{/each}
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
  label { display: inline-flex; align-items: center; gap: 6px; }
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
