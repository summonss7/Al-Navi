export type UIMode = "panels" | "editor" | "viewer";

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
  }

  closeDialog() {
    this.dialog = null;
  }

  setMode(m: UIMode) {
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
