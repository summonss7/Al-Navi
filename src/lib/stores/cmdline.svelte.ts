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

  focusInput() {
    this.el?.focus();
  }

  async init() {
    const h = await loadJson<string[]>("cmd-history.json");
    this.history = h ?? [];
  }

  setText(t: string) {
    this.text = t;
  }

  /** Esc: wipe the line — the next Ctrl+E restarts from the newest command */
  clear() {
    this.text = "";
    this.histIndex = -1;
  }

  stepHistory(dir: -1 | 1) {
    if (!this.history.length) return;
    // history[0] is the NEWEST command (submit() prepends), so walking back
    // in time (Ctrl+E, dir = -1) ADVANCES the index toward the oldest entry
    // (clamped there), while walking forward (Ctrl+X, dir = +1) decrements it
    // back; past the newest the walk returns the unfinished draft (-1),
    // FAR-style.
    if (this.histIndex === -1) {
      this.draft = this.text;
      this.histIndex = 0;
    } else {
      this.histIndex -= dir;
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

/** Execute a command line: builtin cd changes panel path, ftp:// connects
 * the active panel to a server, otherwise the OS shell. */
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
  if (cmd.startsWith("ftp://") || cmd.startsWith("sftp://")) {
    await connectFtpUrl(cmd);
    return;
  }
  const { runShell } = await import("$lib/api");
  // run in the active panel's directory when it is a real local folder —
  // ftp://, archive:// and search panels have no on-disk cwd to offer
  const cwd = /^[A-Za-z]:[\\/]|^\\\\/.test(panels.active.path)
    ? panels.active.path
    : undefined;
  try {
    await runShell(cmd, cwd);
    panels.active.refresh();
  } catch (e) {
    const { ui } = await import("./ui.svelte");
    ui.showError(String(e));
  }
}

/** "ftp://user@host:port/dir" (or sftp://…) typed on the command line
 * connects the active panel, FAR-style. Credentials come from a saved site
 * with the same address; without one the URL's own user (anonymous by
 * default) connects with an empty password. The panel then opens the URL's
 * folder. */
async function connectFtpUrl(url: string) {
  const { remoteConnect } = await import("$lib/ftp");
  const { remoteAuthority, ftpRootOf, isRemotePath } = await import("$lib/ftp");
  const { ftpSites } = await import("./ftpSites.svelte");
  const { ui } = await import("./ui.svelte");
  if (!isRemotePath(url)) return;
  const auth = remoteAuthority(url);
  const secure = url.startsWith("sftp://");
  const site = ftpSites.sites.find((s) => ftpRootOf(s) === auth);
  // parse user@host:port out of the URL when no saved site matches
  let host = "";
  let port = secure ? 22 : 21;
  let user = "anonymous";
  if (!site) {
    const rest = url.slice(auth.indexOf("://") + 3);
    const slash = rest.indexOf("/");
    const at = rest.lastIndexOf("@", slash < 0 ? rest.length : slash);
    const hostport = slash < 0 ? rest : rest.slice(0, slash);
    if (at >= 0) {
      user = rest.slice(0, at) || "anonymous";
      host = rest.slice(at + 1, slash < 0 ? rest.length : slash);
    } else {
      host = hostport;
    }
    const colon = host.lastIndexOf(":");
    if (colon >= 0) {
      const maybePort = parseInt(host.slice(colon + 1), 10);
      if (Number.isFinite(maybePort) && maybePort > 0) {
        port = maybePort;
        host = host.slice(0, colon);
      }
    }
  }
  try {
    if (site) await remoteConnect(site);
    else await remoteConnect({ host, port, user, password: "", secure });
    // the backend path parser applies the same anonymous/21/22 defaults as
    // above, so the URL as typed addresses the session that was just opened
    await panels.active.chdir(url);
    panels.pushDirHistory(panels.active.path);
  } catch (e) {
    ui.showError(String(e));
  }
}
