export type UIMode = "panels" | "editor" | "viewer";

import { cmdline } from "./cmdline.svelte";

export type DialogId =
  | "confirm"
  | "input"
  | "progress"
  | "conflict"
  | "drives"
  | "driveInfo"
  | "windowList"
  | "dirHistory"
  | "cmdHistory"
  | "viewHist"
  | "userMenu"
  | "userMenuItem"
  | "multiRename"
  | "menu"
  | "help"
  | "fileColors"
  | "textColors"
  | "plugins"
  | "ftp"
  | "ftpSite"
  | "search"
  | "pack"
  | "unpack"
  | "attrs"
  | "encoding"
  | "update"
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

/** Alt+F5 pack dialog: archive name + format, into the opposite panel */
export interface PackRequest {
  name: string;
  destDir: string;
  formats: { id: string; ext: string }[];
  resolve: (r: { name: string; format: string } | null) => void;
}

/** Alt+F6 unpack dialog: target directory + "into a named subfolder" */
export interface UnpackRequest {
  destDir: string;
  variants: string[];
  subdirDefault: boolean;
  resolve: (r: { dest: string; subdir: boolean } | null) => void;
}

/** one R/O/H/S/A checkbox in the Ctrl+A dialog: clear / set / keep-unchanged */
export type AttrState = "clear" | "set" | "keep";
export type AttrBits = Record<"readOnly" | "hidden" | "system" | "archive", AttrState>;

/** Ctrl+A attributes dialog: prefilled tri-state bits over the selected paths */
export interface AttrsRequest {
  count: number;
  initial: AttrBits;
  resolve: (r: AttrBits | null) => void;
}

/** Ctrl+M multi-rename dialog: the files to transform. resolve fires on
 *  cancel/Esc only — applying is started by the dialog itself through the
 *  ops queue (like the search dialog runs its own search) */
export interface MultiRenameRequest {
  targets: { path: string; name: string }[];
  resolve: () => void;
}

class UIStore {
  mode = $state<UIMode>("panels");
  dialog = $state<DialogId>(null);
  cmdLineFocused = $state(false);
  drivesFor = $state<"left" | "right">("left");

  confirmReq = $state<ConfirmRequest | null>(null);
  inputReq = $state<InputRequest | null>(null);
  packReq = $state<PackRequest | null>(null);
  unpackReq = $state<UnpackRequest | null>(null);
  attrsReq = $state<AttrsRequest | null>(null);
  multiRenameReq = $state<MultiRenameRequest | null>(null);
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

  askPack(name: string, destDir: string, formats: { id: string; ext: string }[]): Promise<{ name: string; format: string } | null> {
    return new Promise((resolve) => {
      this.packReq = { name, destDir, formats, resolve: (r) => { this.packReq = null; this.dialog = null; resolve(r); } };
      this.dialog = "pack";
    });
  }

  askUnpack(destDir: string, variants: string[], subdirDefault: boolean): Promise<{ dest: string; subdir: boolean } | null> {
    return new Promise((resolve) => {
      this.unpackReq = { destDir, variants, subdirDefault, resolve: (r) => { this.unpackReq = null; this.dialog = null; resolve(r); } };
      this.dialog = "unpack";
    });
  }

  askAttrs(count: number, initial: AttrBits): Promise<AttrBits | null> {
    return new Promise((resolve) => {
      this.attrsReq = { count, initial, resolve: (r) => { this.attrsReq = null; this.dialog = null; resolve(r); } };
      this.dialog = "attrs";
    });
  }

  askMultiRename(targets: { path: string; name: string }[]): Promise<void> {
    return new Promise((resolve) => {
      this.multiRenameReq = {
        targets,
        resolve: () => {
          this.multiRenameReq = null;
          this.dialog = null;
          resolve();
        },
      };
      this.dialog = "multiRename";
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
