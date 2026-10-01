export type UIMode = "panels" | "editor" | "viewer";

import { cmdline } from "./cmdline.svelte";

export type DialogId =
  | "confirm"
  | "input"
  | "progress"
  | "conflict"
  | "drives"
  | "windowList"
  | "dirHistory"
  | "cmdHistory"
  | "menu"
  | "help"
  | "fileColors"
  | "textColors"
  | "plugins"
  | "ftp"
  | "ftpSite"
  | "search"
  | "errors"
  | null;

export interface ConfirmRequest {
  message: string;
  resolve: (ok: boolean) => void;
}

export interface InputRequest {
  title: string;
  prompt: string;
  value: string;
  /** name inserted by Shift+Enter (F5/F6 transfer dialogs: rename in place);
   *  undefined = Shift+Enter does nothing */
  resetTo?: string;
  /** destination presets cycled with ↑/↓ (F5/F6); undefined = plain input */
  variants?: string[];
  resolve: (value: string | null) => void;
}

class UIStore {
  mode = $state<UIMode>("panels");
  dialog = $state<DialogId>(null);
  cmdLineFocused = $state(false);
  drivesFor = $state<"left" | "right">("left");

  confirmReq = $state<ConfirmRequest | null>(null);
  inputReq = $state<InputRequest | null>(null);
  errorText = $state<string | null>(null);
  /** transient toast message (e.g. shortcut assigned) */
  toast = $state<{ text: string; at: number } | null>(null);

  openDialog(id: Exclude<DialogId, null>) {
    this.dialog = id;
    // a modal takes the keyboard. Progress stays transparent so commands
    // can keep being typed while an operation runs in background.
    if (id !== "progress") this.takeKeyboard();
  }

  /** a modal takes the keyboard from whoever holds it: the command line
   *  (the App effect hands the caret back after close) or the CodeMirror
   *  editor (EditorArea refocuses it after close). Without this, keys like
   *  Enter leak into the editor underneath the dialog. */
  private takeKeyboard() {
    if (this.cmdLineFocused) {
      this.cmdLineFocused = false;
      cmdline.blurInput();
      return;
    }
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  closeDialog() {
    this.dialog = null;
    // the errors dialog's text must not outlive the dialog itself
    this.errorText = null;
  }

  setMode(m: UIMode) {
    // entering the editor/viewer must take the keyboard away from the command
    // line — otherwise typed characters keep going into the command input
    if (m !== "panels" && this.cmdLineFocused) {
      this.cmdLineFocused = false;
      cmdline.blurInput();
    }
    this.mode = m;
  }

  askConfirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.confirmReq = { message, resolve: (ok) => { this.confirmReq = null; this.dialog = null; resolve(ok); } };
      this.dialog = "confirm";
    });
  }

  askInput(title: string, prompt: string, value = "", resetTo?: string, variants?: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      this.inputReq = { title, prompt, value, resetTo, variants, resolve: (v) => { this.inputReq = null; this.dialog = null; resolve(v); } };
      this.dialog = "input";
    });
  }

  showError(text: string) {
    this.errorText = text;
    this.dialog = "errors";
    this.takeKeyboard();
  }

  showToast(text: string) {
    this.toast = { text, at: Date.now() };
    setTimeout(() => {
      if (this.toast && Date.now() - this.toast.at >= 2900) this.toast = null;
    }, 3000);
  }
}

export const ui = new UIStore();
