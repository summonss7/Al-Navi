<script lang="ts">
  import { onMount } from "svelte";
  import { cmdline, runCommand } from "$lib/stores/cmdline.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";

  let input: HTMLInputElement | undefined = $state();

  // the flag mirrors real DOM focus (set here, cleared by onblur) so the global
  // key handler routes plain typing into the input instead of the panels
  $effect(() => {
    if (ui.cmdLineFocused) input?.focus();
  });

  // a history recall (Ctrl+E / Ctrl+X) selects the recalled command, FAR
  // style: typing replaces it, Enter runs it as-is. Runs as an effect so the
  // selection lands AFTER bind:value has written the new text into the input.
  $effect(() => {
    if (cmdline.histIndex >= 0) input?.select();
  });

  onMount(() => {
    cmdline.el = input ?? null;
    return () => {
      if (cmdline.el === input) cmdline.el = null;
    };
  });

  function onKey(e: KeyboardEvent) {
    // only Enter is handled here: the global capture handler routes everything
    // else (panel navigation, bound chords) before the event reaches the input,
    // and plain typing arrives natively. No stopPropagation — keys must keep
    // bubbling so dialog key handlers (drive list, histories) still see them.
    if (e.key === "Enter") {
      const cmd = cmdline.currentCommand;
      if (cmd) {
        cmdline.submit();
        void runCommand(cmd);
      }
      e.preventDefault();
    }
  }
</script>

<div class="cmdline">
  <i class="ph-duotone ph-terminal-window lead"></i>
  <input
    bind:this={input}
    bind:value={cmdline.text}
    onkeydown={onKey}
    onfocus={() => (ui.cmdLineFocused = true)}
    onblur={() => (ui.cmdLineFocused = false)}
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
  .lead { color: var(--accent-ink); font-size: calc(17px * var(--fs-scale)); }
  .cmdline input {
    flex: 1;
    background: var(--bg-panel);
    font-family: "JetBrains Mono", Consolas, monospace;
    font-size: calc(12.5px * var(--fs-scale));
    padding: 4px 12px;
    border-radius: var(--r-tab);
  }
</style>
