<script lang="ts">
  import { onMount } from "svelte";
  import { chordOf, defaultKeymap, latinKeyOf, type KeyContext } from "$lib/keymap";
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
    // progress stays transparent (hotkeys keep working in the background op),
    // conflict is modal: Esc resolves it as skip
    if (ui.dialog && ui.dialog !== "progress") return "dialog";
    if (ui.mode === "editor") return "editor";
    if (ui.mode === "viewer") return "viewer";
    if (ui.cmdLineFocused) return "cmdline";
    return "panel";
  }

  function onKeyDown(e: KeyboardEvent) {
    const ctx = currentContext();
    const chord = chordOf(e);
    if (!chord) return;

    // real typing goes to whichever input has DOM focus (command line, panel
    // quick search) — never hijack keys aimed at an editable target in panel mode
    const t = e.target as HTMLElement | null;
    const editing =
      !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (editing && ctx === "panel") return;

    const cmdId = defaultKeymap[ctx]?.[chord];
    if (cmdId) {
      e.preventDefault();
      e.stopPropagation();
      runCommand(cmdId);
      return;
    }

    // FAR: F-keys and Ctrl+Tab keep working even while typing in the command
    // line; everything else falls through to the input natively
    if (ctx === "cmdline") {
      const global = defaultKeymap.panel[chord];
      const isFKey = /F\d+$/.test(chord);
      const isTabChord = chord === "Ctrl+Tab" || chord === "Ctrl+Shift+Tab";
      if (global && (isFKey || isTabChord)) {
        e.preventDefault();
        e.stopPropagation();
        runCommand(global);
      }
      return;
    }

    // panel quick-find: plain printable characters start incremental search
    if (ctx === "panel" && !ui.dialog) {
      // Alt+letter: quick jump to the first entry starting with that letter,
      // matched by physical key so any keyboard layout works
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const latin = latinKeyOf(e);
        if (latin) {
          e.preventDefault();
          runCommand("panel.quickJump", latin);
          return;
        }
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        runCommand("panel.quickFind", e.key);
      }
      // navigation keys that our virtual list needs; skip when typing in an
      // input (caret movement) — FAR note: Left/Right also move the cursor
      // (up/down) for faster two-hand walking
      if (!editing) {
        const nav = navAction(e);
        if (nav) {
          e.preventDefault();
          nav();
        }
      }
    }
  }

  function navAction(e: KeyboardEvent): (() => void) | null {
    const p = panels.active;
    const rows = p.view.length;
    if (!rows) return null;
    switch (e.key) {
      case "ArrowDown":
        return () => (p.cursor = (p.cursor + 1) % rows);
      case "ArrowUp":
        return () => (p.cursor = (p.cursor - 1 + rows) % rows);
      // FAR-style block walking: Right/Left jump by a visible page
      case "ArrowRight":
        return () => p.pageMove(1, p.viewportRows);
      case "ArrowLeft":
        return () => p.pageMove(-1, p.viewportRows);
      case "PageDown": return () => p.pageMove(1, 25);
      case "PageUp": return () => p.pageMove(-1, 25);
      case "Home": return () => (p.cursor = 0);
      case "End": return () => (p.cursor = rows - 1);
      default: return null;
    }
  }

  onMount(() => {
    // focus the app shell so the webview routes keyboard events from the start,
    // then hand focus to the command line (FAR-style: typing starts there)
    document.querySelector<HTMLElement>(".app-shell")?.focus();
    ui.cmdLineFocused = true;

    void settings.init()
      .then(async () => {
        await panels.init();
        ops.init();
        void cmdline.init();
      })
      .catch(() => {
        // outside Tauri (browser preview) panels can't load — chrome still renders
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

<div class="app-shell" tabindex="-1">
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
    outline: none;
  }
  .main {
    flex: 1;
    min-height: 0;
    display: flex;
    padding: 10px 12px 4px;
    gap: 12px;
  }
</style>
