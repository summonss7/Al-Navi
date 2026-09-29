import { loadJson, saveJson } from "$lib/api";
import { panels } from "./panels.svelte";

const MAX_HISTORY = 100;

class CmdlineStore {
  text = $state("");
  history = $state<string[]>([]);
  histIndex = $state(-1); // -1 = editing new text
  private draft = "";
  /** the command line <input> element (for programmatic focus/blur) */
  el: HTMLInputElement | null = null;

  blurInput() {
    this.el?.blur();
  }

  async init() {
    const h = await loadJson<string[]>("cmd-history.json");
    this.history = h ?? [];
  }

  setText(t: string) {
    this.text = t;
  }

  stepHistory(dir: -1 | 1) {
    if (!this.history.length) return;
    if (this.histIndex === -1) {
      this.draft = this.text;
      this.histIndex = this.history.length - 1;
    } else {
      this.histIndex += dir;
      if (this.histIndex < 0) {
        this.histIndex = -1;
        this.text = this.draft;
        return;
      }
      if (this.histIndex >= this.history.length) {
        this.histIndex = this.history.length - 1;
        return;
      }
    }
    this.text = this.history[this.histIndex];
  }

  submit(): boolean {
    const cmd = this.text.trim();
    if (!cmd) return false;
    this.history = [cmd, ...this.history.filter((c) => c !== cmd)].slice(0, MAX_HISTORY);
    this.histIndex = -1;
    this.text = "";
    saveJson("cmd-history.json", this.history).catch(() => {});
    return true;
  }

  get currentCommand(): string {
    return this.text.trim();
  }

  /** cd is handled internally against the active panel */
  isCd(cmd: string): boolean {
    return /^(cd|chdir)\b/i.test(cmd.trim());
  }

  cdTarget(cmd: string): string | null {
    const m = /^(?:cd|chdir)\s+(.+)$/i.exec(cmd.trim());
    return m ? m[1].trim().replace(/^"(.*)"$/, "$1") : null;
  }
}

export const cmdline = new CmdlineStore();

/** Execute a command line: builtin cd changes panel path, otherwise OS shell. */
export async function runCommand(cmdlineText: string): Promise<void> {
  const cmd = cmdlineText.trim();
  if (!cmd) return;
  if (cmdline.isCd(cmd)) {
    const target = cmdline.cdTarget(cmd);
    if (target) {
      if (target === "~") {
        const { homePath } = await import("$lib/api");
        await panels.active.chdir(await homePath());
      } else {
        await panels.active.chdir(target);
      }
      panels.pushDirHistory(panels.active.path);
    }
    return;
  }
  const { runShell } = await import("$lib/api");
  try {
    await runShell(cmd);
    panels.active.refresh();
  } catch (e) {
    const { ui } = await import("./ui.svelte");
    ui.showError(String(e));
  }
}
