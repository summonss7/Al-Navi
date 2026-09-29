<script lang="ts">
  import { onMount } from "svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { runCommand } from "$lib/commands";

  type Key = { k: string; cmd: string | null; label: string };

  // FAR-style: while Ctrl is held, the bottom bar swaps F1..F12 for the
  // Ctrl-combo hints of the current mode (keyups can be missed when a combo
  // opens/closes windows — reset on window blur too)
  let ctrlDown = $state(false);
  onMount(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.key === "Control") ctrlDown = true;
    };
    const ku = (e: KeyboardEvent) => {
      if (e.key === "Control") ctrlDown = false;
    };
    const reset = () => (ctrlDown = false);
    window.addEventListener("keydown", kd, { capture: true });
    window.addEventListener("keyup", ku, { capture: true });
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", kd, { capture: true });
      window.removeEventListener("keyup", ku, { capture: true });
      window.removeEventListener("blur", reset);
    };
  });

  const panelKeys = $derived.by(() => {
    void i18n.locale;
    return [
      { k: "F1", cmd: "ui.help", label: i18n.t("fkeys.f1") },
      { k: "F2", cmd: "stub.userMenu", label: i18n.t("fkeys.f2") },
      { k: "F3", cmd: "viewer.open", label: i18n.t("fkeys.f3") },
      { k: "F4", cmd: "editor.open", label: i18n.t("fkeys.f4") },
      { k: "F5", cmd: "fs.copy", label: i18n.t("fkeys.f5") },
      { k: "F6", cmd: "fs.move", label: i18n.t("fkeys.f6") },
      { k: "F7", cmd: "fs.mkdir", label: i18n.t("fkeys.f7") },
      { k: "F8", cmd: "fs.delete", label: i18n.t("fkeys.f8") },
      { k: "F9", cmd: "ui.menu", label: i18n.t("fkeys.f9") },
      { k: "F10", cmd: "app.quit", label: i18n.t("fkeys.f10") },
      { k: "F11", cmd: null, label: i18n.t("fkeys.f11") },
      { k: "F12", cmd: "ui.windowList", label: i18n.t("fkeys.f12") },
    ] satisfies Key[];
  });

  const editorKeys = $derived.by(() => {
    void i18n.locale;
    return [
      { k: "F1", cmd: "ui.help", label: i18n.t("fkeys.f1") },
      { k: "F2", cmd: "editor.save", label: i18n.t("editor.fkeys.f2") },
      { k: "F3", cmd: null, label: "" },
      { k: "F4", cmd: null, label: "" },
      { k: "F5", cmd: null, label: "" },
      { k: "F6", cmd: null, label: "" },
      { k: "F7", cmd: "editor.search", label: i18n.t("editor.fkeys.f7") },
      { k: "F8", cmd: "editor.deleteLine", label: i18n.t("editor.fkeys.f8") },
      { k: "F9", cmd: null, label: "" },
      { k: "F10", cmd: "app.quit", label: i18n.t("editor.fkeys.f10") },
      { k: "F11", cmd: null, label: "" },
      { k: "F12", cmd: "ui.windowList", label: i18n.t("fkeys.f12") },
    ] satisfies Key[];
  });

  const viewerKeys = $derived.by(() => {
    void i18n.locale;
    return [
      { k: "F1", cmd: "ui.help", label: i18n.t("fkeys.f1") },
      { k: "F2", cmd: null, label: "" },
      { k: "F3", cmd: null, label: "" },
      { k: "F4", cmd: "viewer.toEditor", label: i18n.t("viewer.fkeys.f4") },
      { k: "F5", cmd: null, label: "" },
      { k: "F6", cmd: null, label: "" },
      { k: "F7", cmd: null, label: "" },
      { k: "F8", cmd: "viewer.toggleHex", label: i18n.t("viewer.fkeys.f8") },
      { k: "F9", cmd: null, label: "" },
      { k: "F10", cmd: "app.quit", label: i18n.t("fkeys.f10") },
      { k: "F11", cmd: null, label: "" },
      { k: "F12", cmd: "ui.windowList", label: i18n.t("fkeys.f12") },
    ] satisfies Key[];
  });

  const keys = $derived(ui.mode === "editor" ? editorKeys : ui.mode === "viewer" ? viewerKeys : panelKeys);

  // Ctrl-hint chips per mode; these mirror defaultKeymap bindings
  const panelHints = $derived.by(() => {
    void i18n.locale;
    return [
      { k: "Ctrl+O", cmd: "panel.hideBoth", label: i18n.t("hint.hidePanels") },
      { k: "Ctrl+P", cmd: "panel.showBoth", label: i18n.t("hint.showPanels") },
      { k: "Ctrl+U", cmd: "panel.swap", label: i18n.t("hint.swap") },
      { k: "Ctrl+R", cmd: "panel.refresh", label: i18n.t("hint.refresh") },
      { k: "Ctrl+.", cmd: "panel.toggleHidden", label: i18n.t("hint.hidden") },
      { k: "Ctrl+↑", cmd: "panel.up", label: i18n.t("hint.up") },
      { k: "Ctrl+\\", cmd: "panel.root", label: i18n.t("hint.root") },
      { k: "Ctrl+Ins", cmd: "panel.copyNames", label: i18n.t("hint.copyName") },
      { k: "Ctrl+Shift+Ins", cmd: "panel.copyPaths", label: i18n.t("hint.copyPath") },
      { k: "Ctrl+F3", cmd: "panel.sortName", label: i18n.t("hint.sortName") },
      { k: "Ctrl+F5", cmd: "panel.sortMtime", label: i18n.t("hint.sortDate") },
      { k: "Ctrl+F6", cmd: "panel.sortSize", label: i18n.t("hint.sortSize") },
      { k: "Ctrl+Tab", cmd: "ui.nextTab", label: i18n.t("hint.ring") },
      { k: "Ctrl+E", cmd: "cmdline.prevHistory", label: i18n.t("hint.cmdHist") },
      { k: "Ctrl+T", cmd: "panel.newTab", label: i18n.t("hint.newTab") },
      { k: "Ctrl+W", cmd: "panel.closeTab", label: i18n.t("hint.closeTab") },
    ] satisfies Key[];
  });

  const editorHints = $derived.by(() => {
    void i18n.locale;
    return [
      { k: "Ctrl+S", cmd: "editor.save", label: i18n.t("help.ed.save") },
      { k: "Ctrl+G", cmd: "editor.gotoLine", label: i18n.t("help.ed.goto") },
      { k: "Ctrl+Y", cmd: "editor.deleteLine", label: i18n.t("help.ed.delLine") },
      { k: "Ctrl+Tab", cmd: "ui.nextTab", label: i18n.t("hint.ring") },
    ] satisfies Key[];
  });

  const viewerHints = $derived.by(() => {
    void i18n.locale;
    return [{ k: "Ctrl+Tab", cmd: "ui.nextTab", label: i18n.t("hint.ring") }] satisfies Key[];
  });

  const hints = $derived(ui.mode === "editor" ? editorHints : ui.mode === "viewer" ? viewerHints : panelHints);
</script>

<footer class="fkeys">
  {#if ctrlDown}
    {#each hints as h}
      <button
        class="fkey chip"
        class:dim={!h.cmd || !h.label}
        disabled={!h.cmd}
        onmousedown={(e) => e.preventDefault()}
        onclick={() => h.cmd && runCommand(h.cmd)}
      >
        <kbd>{h.k}</kbd>
        {#if h.label}<span class="lbl">{h.label}</span>{/if}
      </button>
    {/each}
  {:else}
    {#each keys as f}
      <!-- preventDefault on mousedown keeps focus in the editor text / command line -->
      <button
        class="fkey"
        class:dim={!f.cmd || !f.label}
        disabled={!f.cmd}
        onmousedown={(e) => e.preventDefault()}
        onclick={() => f.cmd && runCommand(f.cmd)}
      >
        <kbd>{f.k}</kbd>
        {#if f.label}<span class="lbl">{f.label}</span>{/if}
      </button>
    {/each}
  {/if}
</footer>

<style>
  .fkeys {
    display: flex;
    gap: 5px;
    padding: 6px 10px;
    border-top: 1px solid var(--border);
    background: var(--bg-chrome);
    flex-shrink: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .fkeys::-webkit-scrollbar { display: none; }
  .fkey {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 3px 12px;
    border-radius: var(--r-tab);
    border: 1px solid var(--border);
    background: var(--bg-panel);
    color: var(--fg-dim);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    flex: 1;
    justify-content: center;
    min-width: 0;
  }
  .fkey:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--accent2) 50%, var(--border));
    color: var(--fg);
  }
  .fkey.dim { opacity: 0.45; }
  .lbl { overflow: hidden; text-overflow: ellipsis; }

  /* Ctrl-hint chips: natural width, smaller, in one scrollable row */
  .fkey.chip {
    flex: 0 0 auto;
    padding: 3px 9px;
    font-size: 11px;
    gap: 6px;
  }
  .fkey.chip kbd {
    min-width: 0;
    font-size: 10.5px;
  }
</style>
