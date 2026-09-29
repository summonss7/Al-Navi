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
    // a modal takes the keyboard: the command line gives up the caret (the
    // App effect hands it back after close). Progress stays transparent so
    // commands can keep being typed while an operation runs in background.
    if (id !== "progress" && this.cmdLineFocused) {
      this.cmdLineFocused = false;
      cmdline.blurInput();
    }
  }

  closeDialog() {
    this.dialog = null;
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

  askInput(title: string, prompt: string, value = ""): Promise<string | null> {
    return new Promise((resolve) => {
      this.inputReq = { title, prompt, value, resolve: (v) => { this.inputReq = null; this.dialog = null; resolve(v); } };
      this.dialog = "input";
    });
  }

  showError(text: string) {
    this.errorText = text;
    this.dialog = "errors";
  }

  showToast(text: string) {
    this.toast = { text, at: Date.now() };
    setTimeout(() => {
      if (this.toast && Date.now() - this.toast.at >= 2900) this.toast = null;
    }, 3000);
  }
}

export const ui = new UIStore();
