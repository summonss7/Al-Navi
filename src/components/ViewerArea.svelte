<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { createView, setStateFor, setActiveView, capturePos, restorePos } from "$lib/editor/cm";
  import { readHex, archiveReadHex } from "$lib/api";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { editor } from "$lib/stores/editor.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { formatSize } from "$lib/format";
  import { encodingLabel } from "$lib/encodings";
  import { isRemotePath, remoteReadHex } from "$lib/ftp";
  import { isArchivePath } from "$lib/archive";

  let host: HTMLDivElement | undefined = $state();
  let view: EditorView | null = null;
  let lastDocId = -1;
  /** content revision of lastDocId — Shift+F8 encoding reloads swap the text
   *  of the same doc, the effect reacts to the bump */
  let lastRev = 0;
  /** last known text scroll offset — the effect that saves the position runs
   *  after the DOM teardown, when a detached scroller already reads 0 */
  let lastScrollTop = 0;

  const doc = $derived(editor.activeViewer);

  // hex state
  let hexOffset = $state(0);
  let hexRows = $state<{ off: number; bytes: number[] }[]>([]);
  let hexFileSize = $state(0);
  let lastHexId = -1;
  const PAGE = 4096;

  $effect(() => {
    const d = editor.activeViewer;
    if (d && d.mode === "hex") {
      if (d.id !== lastHexId) {
        // reopen where the file was last read (position memory)
        hexOffset = d.pos?.hexOffset ?? 0;
        lastHexId = d.id;
      }
      void loadHex(d.path, hexOffset);
    } else {
      lastHexId = -1;
    }
  });

  async function loadHex(path: string, offset: number) {
    try {
      const res = isRemotePath(path)
        ? await remoteReadHex(path, offset, PAGE)
        : isArchivePath(path)
          ? await archiveReadHex(path, offset, PAGE)
          : await readHex(path, offset, PAGE);
      hexFileSize = res.fileSize;
      const rows: { off: number; bytes: number[] }[] = [];
      for (let i = 0; i < res.data.length; i += 16) {
        rows.push({ off: offset + i, bytes: res.data.slice(i, i + 16) });
      }
      hexRows = rows;
    } catch (e) {
      hexRows = [];
    }
  }

  function hexPage(delta: number) {
    const next = Math.max(0, Math.min(hexOffset + delta * PAGE, hexFileSize - 1));
    hexOffset = Math.floor(next / 16) * 16;
    // remember the page for the next open of this file
    const d = editor.activeViewer;
    if (d) editor.saveViewPos(d.id, { ...(d.pos ?? { anchor: 0, head: 0, scrollTop: 0 }), hexOffset });
  }

  const hex = (b: number) => b.toString(16).padStart(2, "0").toUpperCase();
  const offFmt = (o: number) => o.toString(16).padStart(8, "0").toUpperCase();

  onMount(() => {
    // keep the scroll offset fresh: scroll events don't fire reliably on the
    // CodeMirror scroller, and the save happens after the DOM teardown
    const track = setInterval(() => {
      if (!view) return;
      lastScrollTop = view.scrollDOM.scrollTop;
      // push the live position into the store: closeViewer's keepOnClose runs
      // BEFORE this component's unmount save (which no longer finds the doc),
      // so without this the close would remember a stale scroll (alnavi-015)
      if (lastDocId !== -1 && editor.activeViewer?.id === lastDocId) {
        editor.saveViewPos(lastDocId, { ...capturePos(view), scrollTop: lastScrollTop });
      }
    }, 300);
    return () => {
      clearInterval(track);
      if (view && lastDocId !== -1) {
        editor.saveViewPos(lastDocId, { ...capturePos(view), scrollTop: lastScrollTop });
      }
      view?.destroy();
      setActiveView(null);
    };
  });

  // create/refresh the readonly text view lazily (host exists only in text mode)
  $effect(() => {
    const d = editor.activeViewer;
    if (!d) return;
    if (d.mode === "text") {
      if (!view && host) {
        view = createView(host, d.text, d.path, { readOnly: true });
        setActiveView(view);
        lastDocId = d.id;
        lastRev = d.rev;
        lastScrollTop = d.pos?.scrollTop ?? 0;
        if (d.pos) restorePos(view, d.pos);
        view.focus();
      } else if (view) {
        if (d.id !== lastDocId) {
          if (lastDocId !== -1) editor.saveViewPos(lastDocId, { ...capturePos(view), scrollTop: lastScrollTop });
          lastDocId = d.id;
          lastRev = d.rev;
          setStateFor(view, d.text, d.path, true);
          if (d.pos) restorePos(view, d.pos);
          view.focus();
        } else if (d.rev !== lastRev) {
          // same doc re-read in another encoding (Shift+F8): swap the text,
          // keep the reading position
          const keep = { ...capturePos(view), scrollTop: lastScrollTop };
          setStateFor(view, d.text, d.path, true);
          restorePos(view, keep);
          lastRev = d.rev;
        }
      }
    } else if (view) {
      // leaving text mode: remember the position, release the stale view (its
      // host div is gone) so the next text doc builds a fresh one
      if (lastDocId !== -1) editor.saveViewPos(lastDocId, { ...capturePos(view), scrollTop: lastScrollTop });
      view.destroy();
      view = null;
      setActiveView(null);
      lastDocId = -1;
    }
  });

  // caret into the text whenever the viewer is up and after any dialog closes
  // (help, viewer history...): without focus the keyboard stays with the page
  // shell and arrows/PgUp/PgDn never scroll the text (alnavi-015). The
  // component remounts on every mode switch; doc switches focus in the effect
  // above.
  $effect(() => {
    if (ui.dialog !== null) return;
    if (!view) return;
    requestAnimationFrame(() => view?.focus());
  });
</script>

{#if doc}
  <div class="viewer">
    <div class="v-status">
      <i class="ph-duotone ph-eye lead"></i>
      <span class="path mono" title={doc.path}>{doc.path}</span>
      <span class="dim mono">{formatSize(hexFileSize || doc.text.length)}</span>
      <span class="grow"></span>
      {#if doc.mode !== "image"}
        {#if doc.mode === "text"}
          <button
            class="btn small"
            title={i18n.t("hint.encoding") + " (Shift+F8)"}
            onclick={() => {
              void import("$lib/commands").then(({ runCommand }) => runCommand("viewer.selectEncoding"));
            }}
          >{encodingLabel(doc.encoding)}</button>
        {/if}
        <span class="mode-badge">{doc.mode === "hex" ? i18n.t("viewer.hex") : i18n.t("viewer.textMode")}</span>
        <button class="btn small" onclick={() => editor.toggleHexActive()}>F8 {i18n.t("viewer.hex")}</button>
      {/if}
    </div>

    {#if doc.mode === "image"}
      <div class="img-wrap">
        <img src={convertFileSrc(doc.path)} alt={doc.name} />
      </div>
    {:else if doc.mode === "hex"}
      <div class="hex-wrap">
        <div class="hex">
          {#each hexRows as r (r.off)}
            <div class="hrow mono">
              <span class="hoff">{offFmt(r.off)}</span>
              <span class="hbytes">{r.bytes.map(hex).join(" ")}</span>
              <span class="hascii">{r.bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("")}</span>
            </div>
          {/each}
        </div>
        <div class="hex-nav">
          <button class="btn" disabled={hexOffset === 0} onclick={() => hexPage(-1)}>← 4KB</button>
          <span class="mono dim">0x{offFmt(hexOffset)} … 0x{offFmt(Math.min(hexOffset + PAGE, hexFileSize))} / 0x{offFmt(hexFileSize)}</span>
          <button class="btn" disabled={hexOffset + PAGE >= hexFileSize} onclick={() => hexPage(1)}>4KB →</button>
        </div>
      </div>
    {:else}
      <div class="text-wrap">
        {#if doc.truncated}
          <div class="trunc-warn">{i18n.t("editor.truncated")}</div>
        {/if}
        <div class="cm-host" bind:this={host}></div>
      </div>
    {/if}
  </div>
{:else}
  <div class="no-doc"><i class="ph-duotone ph-eye"></i></div>
{/if}

<style>
  .viewer {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .v-status {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    background: var(--bg-header);
    border-bottom: 1px solid var(--border);
    font-size: calc(12px * var(--fs-scale));
    color: var(--fg-dim);
    flex-shrink: 0;
  }
  .lead { color: var(--accent2); font-size: calc(16px * var(--fs-scale)); }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr; }
  .grow { flex: 1; }
  .dim { color: var(--fg-muted); }
  .mode-badge {
    font-size: calc(10.5px * var(--fs-scale));
    padding: 2px 8px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--accent2) 18%, transparent);
    color: var(--accent2);
    font-weight: 600;
  }
  .btn.small { padding: 3px 9px; font-size: calc(11.5px * var(--fs-scale)); }

  .img-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    background:
      linear-gradient(45deg, var(--row-hover) 25%, transparent 25%, transparent 75%, var(--row-hover) 75%),
      linear-gradient(45deg, var(--row-hover) 25%, transparent 25%, transparent 75%, var(--row-hover) 75%);
    background-size: 24px 24px;
    background-position: 0 0, 12px 12px;
  }
  .img-wrap img { max-width: 100%; max-height: 100%; }

  .text-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .trunc-warn {
    padding: 6px 12px;
    font-size: calc(11.5px * var(--fs-scale));
    color: var(--accent2);
    background: color-mix(in srgb, var(--accent2) 10%, transparent);
  }
  .cm-host { flex: 1; min-height: 0; overflow: hidden; }
  .cm-host :global(.cm-editor) { height: 100%; }

  .hex-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .hex { flex: 1; overflow: auto; padding: 8px 12px; direction: ltr; }
  .hrow { display: flex; gap: 16px; font-size: calc(12px * var(--fs-scale)); line-height: 1.7; white-space: pre; }
  .hrow:hover { background: var(--row-hover); }
  .hoff { color: var(--fg-muted); }
  .hbytes { color: var(--fg); }
  .hascii { color: var(--fg-dim); }
  .hex-nav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 7px;
    border-top: 1px solid var(--border);
  }

  .no-doc {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-muted);
    font-size: calc(44px * var(--fs-scale));
  }
</style>
