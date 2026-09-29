<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { runCommand } from "$lib/commands";

  type Key = { k: string; cmd: string | null; label: string };

  const panelKeys = $derived.by(() => {
    void i18n.locale;
    return [
      { k: "F1", cmd: "stub.help", label: i18n.t("fkeys.f1") },
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
      { k: "F1", cmd: "stub.help", label: i18n.t("fkeys.f1") },
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
      { k: "F1", cmd: "stub.help", label: i18n.t("fkeys.f1") },
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
</script>

<footer class="fkeys">
  {#each keys as f}
    <button class="fkey" class:dim={!f.cmd || !f.label} disabled={!f.cmd} onclick={() => f.cmd && runCommand(f.cmd)}>
      <kbd>{f.k}</kbd>
      {#if f.label}<span class="lbl">{f.label}</span>{/if}
    </button>
  {/each}
</footer>

<style>
  .fkeys {
    display: flex;
    gap: 4px;
    padding: 5px 8px;
    border-top: 1px solid var(--border);
    background: var(--bg-elev);
    flex-shrink: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .fkeys::-webkit-scrollbar { display: none; }
  .fkey {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 3px 10px;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--fg-dim);
    font-size: 12px;
    white-space: nowrap;
    flex: 1;
    justify-content: center;
    min-width: 0;
  }
  .fkey:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    color: var(--fg);
  }
  .fkey.dim { opacity: 0.45; }
  .lbl { overflow: hidden; text-overflow: ellipsis; }
</style>
