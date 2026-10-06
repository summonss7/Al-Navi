<script lang="ts">
  import { onMount } from "svelte";
  import { chordOf, defaultKeymap, latinKeyOf, type KeyContext } from "$lib/keymap";
  import { runCommand } from "$lib/commands";
  import { registerAllCommands } from "$lib/register-commands";
  import { settings } from "$lib/stores/settings.svelte";
  import { panels } from "$lib/stores/panels.svelte";
  import { ops } from "$lib/stores/ops.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { editor } from "$lib/stores/editor.svelte";
  import { cmdline } from "$lib/stores/cmdline.svelte";
  import { fileColors } from "$lib/stores/fileColors.svelte";
  import { textColors } from "$lib/stores/textColors.svelte";
  import { ftpSites } from "$lib/stores/ftpSites.svelte";
  import { userMenu } from "$lib/stores/userMenu.svelte";
  import { searchStore } from "$lib/stores/search.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { windowState } from "$lib/windowState";

  import TitleBar from "$comp/TitleBar.svelte";
  import PanelsGrid from "$comp/PanelsGrid.svelte";
  import CmdLine from "$comp/CmdLine.svelte";
  import FKeyBar from "$comp/FKeyBar.svelte";
  import Dialogs from "$comp/Dialogs.svelte";
  import type { Component } from "svelte";

  // The editor and the viewer (with the whole CodeMirror core, ~0.5 MB) live in
  // their own chunks fetched at the first F4/F3 — the panel startup stays lean
  // (alnavi-013). Each component is cached after its first load.
  let EditorComp = $state<Component | null>(null);
  let ViewerComp = $state<Component | null>(null);
  $effect(() => {
    if (ui.mode === "editor" && !EditorComp) {
      void import("$comp/EditorArea.svelte").then((m) => (EditorComp = m.default));
    } else if (ui.mode === "viewer" && !ViewerComp) {
      void import("$comp/ViewerArea.svelte").then((m) => (ViewerComp = m.default));
    }
  });

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

    // a finished operation is a result dialog: Esc/Enter close it (while
    // the op is still running the progress dialog stays keyboard-transparent)
    if (ui.dialog === "progress" && ops.op?.phase === "done" && (chord === "Enter" || chord === "Esc")) {
      e.preventDefault();
      e.stopPropagation();
      ops.finishOp();
      return;
    }

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
      // FAR-style panel resize: slide the split between the panels. With text
      // in the line the chords fall through to the caret block below and stay
      // the input's own word jump (they are deliberately NOT in the keymap,
      // where the lookup above would swallow them before that block)
      case "Ctrl+Left":
      case "Ctrl+Right":
        if (hasText) return;
        e.preventDefault();
        e.stopPropagation();
        runCommand(chord === "Ctrl+Left" ? "panel.splitLeft" : "panel.splitRight");
        return;
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
    // Shift+Left/Right char selection, Ctrl+Shift+Left/Right word selection,
    // Shift+Home/End select to line start/end, Home/End/Delete line editing.
    // Selection here is the input's own native behavior — these chords must
    // NOT reach navAction, which would move the panel cursor instead
    if (hasText && !e.altKey) {
      switch (chord) {
        case "Left":
        case "Right":
        case "Home":
        case "End":
        case "Delete":
        case "Ctrl+Left":
        case "Ctrl+Right":
        case "Shift+Left":
        case "Shift+Right":
        case "Shift+Home":
        case "Shift+End":
        case "Ctrl+Shift+Left":
        case "Ctrl+Shift+Right":
        case "Ctrl+Shift+Home":
        case "Ctrl+Shift+End":
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

  // Ctrl+wheel zooms the interface font, browser-style — the same stepper as
  // the Ctrl+± chords, routed through ui.fontInc/ui.fontDec so the toast,
  // clamp and settings persistence are shared. Deltas accumulate to one
  // 0.5-px step per ~100 px of travel (a mouse notch is 100–120 px, trackpad
  // pinches arrive as many small ctrl-wheel deltas); line/page delta modes
  // are normalized to pixels. The listener is non-passive so preventDefault()
  // also suppresses WebView2's own ctrl+wheel page zoom.
  let wheelZoomAcc = 0;
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 100 : 1;
    if (Math.sign(e.deltaY) !== Math.sign(wheelZoomAcc)) wheelZoomAcc = 0;
    wheelZoomAcc += e.deltaY * unit;
    if (Math.abs(wheelZoomAcc) < 100) return;
    runCommand(wheelZoomAcc < 0 ? "ui.fontInc" : "ui.fontDec");
    wheelZoomAcc = 0;
  }

  onMount(() => {
    // focus the app shell so the webview routes keyboard events from the start;
    // the effect below hands the caret to the command line (FAR-style)
    document.querySelector<HTMLElement>(".app-shell")?.focus();

    void settings.init()
      .then(async () => {
        // FTP sites must load first: panels reconnect to saved servers
        // when the restored session points into ftp://, and a cmdline
        // ftp:// typed right after launch needs the saved credentials
        await ftpSites.init();
        await panels.init();
        ops.init();
        void searchStore.init();
        // awaited: an F4 in the first moments after launch must find the
        // remembered positions, not an empty map
        await editor.init();
        void cmdline.init();
        void userMenu.init();
        void fileColors.init();
        void textColors.init();
      })
      .catch(() => {
        // outside Tauri (browser preview) panels can't load — chrome still renders
      });

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    const stopWinTrack = windowState.init();

    const beforeUnload = () => {
      panels.saveSession();
      editor.persistAll();
      void windowState.flush();
    };
    window.addEventListener("beforeunload", beforeUnload);

    // native X close: persist editor/viewer caret positions before the
    // webview dies — beforeunload doesn't fire reliably on a Tauri close
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onCloseRequested(async (e) => {
          e.preventDefault();
          panels.saveSession();
          await editor.persistAll();
          await windowState.flush();
          await getCurrentWindow().destroy();
        }),
      )
      .catch(() => {
        /* browser preview: no native window */
      });

    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("beforeunload", beforeUnload);
      stopWinTrack();
      ops.dispose();
      searchStore.dispose();
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
      {#if EditorComp}<EditorComp />{/if}
    {:else if ui.mode === "viewer"}
      {#if ViewerComp}<ViewerComp />{/if}
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
