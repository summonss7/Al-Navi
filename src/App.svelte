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
  import { fileColors } from "$lib/stores/fileColors.svelte";
  import { textColors } from "$lib/stores/textColors.svelte";
  import { ftpSites } from "$lib/stores/ftpSites.svelte";
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
    return "panel";
  }

  function onKeyDown(e: KeyboardEvent) {
    const ctx = currentContext();
    const chord = chordOf(e);
    if (!chord) return;

    if (ctx !== "panel") {
      const cmdId = defaultKeymap[ctx]?.[chord];
      if (cmdId) {
        e.preventDefault();
        e.stopPropagation();
        runCommand(cmdId);
      }
      return;
    }

    // ---- panels mode ----
    // The command line keeps the caret at all times (FAR model): plain typing
    // lands in the line, while bound chords and navigation still drive the
    // panels. Keys below are routed to the line whenever it has text.
    const hasText = cmdline.text.length > 0;
    switch (chord) {
      case "Enter":
        if (hasText) return; // the input's own handler executes the command
        break; // empty line: act on the panel (panel.enter below)
      case "Esc":
        if (hasText) {
          e.preventDefault();
          cmdline.setText("");
          return;
        }
        break;
      case "Backspace":
        if (hasText) return; // delete a char in the line
        break; // empty line: go up one directory
    }

    const cmdId = defaultKeymap.panel[chord];
    if (cmdId) {
      e.preventDefault();
      e.stopPropagation();
      runCommand(cmdId);
      return;
    }

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

    // caret keys with text stay in the line: Ctrl+Left/Right word jump,
    // Shift+Left char selection, Home/End line start/end
    if (hasText && !e.altKey) {
      switch (chord) {
        case "Left":
        case "Right":
        case "Home":
        case "End":
        case "Delete":
          return;
      }
    }

    // navigation keys for the panel list; Up/Down always move the cursor
    // even while a command is being typed (Left/Right etc. were routed above)
    const nav = navAction(e);
    if (nav) {
      e.preventDefault();
      nav();
      return;
    }

    // everything else (plain characters) is typed into the focused command line
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
      case "PageDown": return () => p.pageMove(1, p.viewportRows);
      case "PageUp": return () => p.pageMove(-1, p.viewportRows);
      case "Home": return () => (p.cursor = 0);
      case "End": return () => (p.cursor = rows - 1);
      default: return null;
    }
  }

  onMount(() => {
    // focus the app shell so the webview routes keyboard events from the start;
    // the effect below hands the caret to the command line (FAR-style)
    document.querySelector<HTMLElement>(".app-shell")?.focus();

    void settings.init()
      .then(async () => {
        // FTP sites must load first: panels reconnect to saved servers
        // when the restored session points into ftp://
        void ftpSites.init();
        await panels.init();
        ops.init();
        void cmdline.init();
        void fileColors.init();
        void textColors.init();
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

  // the command line owns the caret whenever the panels are on screen: it is
  // focused at startup and comes back by itself after a dialog closes, the
  // editor/viewer is left, or anything steals the DOM focus — no Ctrl+K, no mouse
  $effect(() => {
    if (ui.mode === "panels" && ui.dialog === null && !ui.cmdLineFocused) {
      cmdline.focusInput();
    }
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
