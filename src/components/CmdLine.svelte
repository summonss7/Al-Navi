<script lang="ts">
  import { cmdline, runCommand } from "$lib/stores/cmdline.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";

  let input: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (ui.cmdLineFocused) {
      input?.focus();
      ui.cmdLineFocused = false;
    }
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      const cmd = cmdline.currentCommand;
      if (cmd) {
        cmdline.submit();
        void runCommand(cmd);
      }
      e.preventDefault();
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "e")) {
      cmdline.stepHistory(-1);
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      cmdline.stepHistory(1);
      e.preventDefault();
    }
    e.stopPropagation();
  }

  function blurNow() {
    input?.blur();
  }
</script>

<div class="cmdline">
  <i class="ph-duotone ph-terminal-window lead"></i>
  <input
    bind:this={input}
    bind:value={cmdline.text}
    onkeydown={onKey}
    onblur={blurNow}
    placeholder={i18n.t("cmdline.hint")}
    spellcheck="false"
  />
</div>

<style>
  .cmdline {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-top: 1px solid var(--border);
    background: var(--bg-chrome);
    flex-shrink: 0;
  }
  .lead { color: var(--accent-ink); font-size: 17px; }
  .cmdline input {
    flex: 1;
    background: var(--bg-panel);
    font-family: "JetBrains Mono", Consolas, monospace;
    font-size: 12.5px;
    padding: 4px 12px;
    border-radius: var(--r-tab);
  }
</style>
