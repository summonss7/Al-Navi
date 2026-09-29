<script lang="ts">
  import { onMount } from "svelte";
  import { chordOf, defaultKeymap, type KeyContext } from "$lib/keymap";
  import { runCommand } from "$lib/commands";
  import { registerAllCommands } from "$lib/register-commands";
  import { settings } from "$lib/stores/settings.svelte";
  import { panels } from "$lib/stores/panels.svelte";
  import { ops } from "$lib/stores/ops.svelte";
  import { ui, type DialogId } from "$lib/stores/ui.svelte";
  import { editor } from "$lib/stores/editor.svelte";
  import { cmdline } from "$lib/stores/cmdline.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";

  import TitleBar from "$comp/TitleBar.svelte";
  import PanelsGrid from "$comp/PanelsGrid.svelte";
  import EditorArea from "$comp/EditorArea.svelte";
  import ViewerArea from "$comp/ViewerArea.svelte";
  import CmdLine from "$comp/CmdLine.svelte";
  import FKeyBar from "$comp/FKeyBar.svelte";
  import Dialogs from "$comp/Dialogs.svelte";

  registerAllCommands();

  function currentContext(): KeyContext {
    if (ui.dialog && ui.dialog !== "progress" && ui.dialog !== "conflict") return "dialog";
    if (ui.mode === "editor") return "editor";
    if (ui.mode === "viewer") return "viewer";
    if (ui.cmdLineFocused) return "cmdline";
    return "panel";
  }

  function onKeyDown(e: KeyboardEvent) {
    // don't touch editor/editor-ish typing unless a bound chord is hit
    const ctx = currentContext();
    const chord = chordOf(e);
    if (!chord) return;
    const cmdId = defaultKeymap[ctx]?.[chord];

    if (cmdId) {
      e.preventDefault();
      e.stopPropagation();
      runCommand(cmdId);
      return;
    }

    // panel quick-find: plain printable characters start incremental search
    if (ctx === "panel" && !ui.dialog) {
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        runCommand("panel.quickFind", e.key);
      }
      // navigation keys that our virtual list needs
      const nav = navAction(e);
      if (nav) {
        e.preventDefault();
        nav();
      }
    }
  }

  function navAction(e: KeyboardEvent): (() => void) | null {
    const p = panels.active;
    const rows = p.view.length;
    if (!rows) return null;
    switch (e.key) {
      case "ArrowDown": return () => p.moveCursor(1);
      case "ArrowUp": return () => p.moveCursor(-1);
      case "PageDown": return () => p.pageMove(1, 25);
      case "PageUp": return () => p.pageMove(-1, 25);
      case "Home": return () => (p.cursor = 0);
      case "End": return () => (p.cursor = rows - 1);
      default: return null;
    }
  }

  onMount(() => {
    void settings.init().then(async () => {
      await panels.init();
      ops.init();
      void cmdline.init();
    });

    window.addEventListener("keydown", onKeyDown, { capture: true });

    const beforeUnload = () => panels.saveSession();
    window.addEventListener("beforeunload", beforeUnload);

    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("beforeunload", beforeUnload);
      ops.dispose();
    };
  });

  // keep document title in sync (top-level effect: allowed in runes mode)
  $effect(() => {
    document.title = `Al-Navi — ${i18n.t("menu.about")}`;
  });
</script>

<div class="app-shell">
  <TitleBar />
  <main class="main">
    {#if ui.mode === "editor"}
      <EditorArea />
    {:else if ui.mode === "viewer"}
      <ViewerArea />
    {:else}
      <PanelsGrid />
    {/if}
  </main>
  <CmdLine />
  <FKeyBar />
  <Dialogs />
</div>

{#if ui.toast}
  <div class="toast">{ui.toast.text}</div>
{/if}

<style>
  .app-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .main {
    flex: 1;
    min-height: 0;
    display: flex;
    padding: 6px 8px 2px;
    gap: 8px;
  }
</style>
