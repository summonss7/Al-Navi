// Shared Svelte actions and tiny helpers used by several dialog components.

/** focus the node shortly after mount (default button of a dialog etc.) */
export function autofocus(node: HTMLElement) {
  setTimeout(() => node.focus(), 0);
}

// input dialogs open with the whole value selected — typing then overtypes
// it; placing the caret by hand (click, arrows, Home/End) unselects and
// inserts instead. The last focusSelect'd input is remembered so other
// handlers can retype into it (variant cycling in the input dialog).
let inputEl: HTMLInputElement | null = null;

export function focusSelect(node: HTMLInputElement) {
  inputEl = node;
  // a timeout, not rAF: rAF never fires while the window is hidden/minimized
  setTimeout(() => {
    node.focus();
    node.select();
  }, 0);
  return {
    destroy: () => {
      inputEl = null;
    },
  };
}

/** put a new value into the focused input, selected for overtyping */
export function retypeVariant(v: string) {
  if (!inputEl) return;
  inputEl.value = v;
  inputEl.focus();
  setTimeout(() => inputEl?.select(), 0);
}

/** file-color rules: a small colored sample of the first mask ("*.jpg" -> "sample.jpg") */
export function sampleOf(mask: string): string {
  const p = mask.split(/[,;\s]+/).find((x) => x.trim().length > 0) ?? "*";
  return p.replace(/^\*/, "sample").replace(/\*/g, "");
}
