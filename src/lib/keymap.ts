export type KeyContext = "panel" | "editor" | "viewer" | "dialog";

/**
 * Normalize a KeyboardEvent into a FAR-style chord string:
 * "Ctrl+Shift+F5", "Alt+F1", "Enter", "Gray+", "Ctrl+0" ...
 */
export function chordOf(e: KeyboardEvent): string | null {
  let key = e.key;

  // Numpad keys -> FAR "gray" names
  if (e.code.startsWith("Numpad")) {
    switch (e.code) {
      case "NumpadAdd":
        return "Gray+";
      case "NumpadSubtract":
        return "Gray-";
      case "NumpadMultiply":
        return "Gray*";
      case "NumpadDivide":
        return "Gray/";
      case "NumpadEnter":
        return mod(e) + "Enter";
      case "NumpadDecimal":
        return mod(e) + "Delete";
      default: {
        const d = e.code.slice(6);
        if (/^\d$/.test(d)) return mod(e) + d;
        break;
      }
    }
  }

  if (key === "Escape") key = "Esc";
  else if (key === " ") key = "Space";
  else if (key.startsWith("Arrow")) key = key.slice(5); // Left/Right/Up/Down
  else if (key.length === 1) {
    // with Ctrl/Alt/Cmd held, match the PHYSICAL key so chords like Ctrl+Y
    // work in any layout (Russian ЙЦУКЕН types "Н" on the Y key)
    const phys = e.ctrlKey || e.altKey || e.metaKey ? latinKeyOf(e) : null;
    key = (phys ?? key).toUpperCase();
  }

  if (key === "") return null;

  // digits via physical code so Ctrl+5 works on any layout
  if (e.code.startsWith("Digit") && !e.altKey) {
    const d = e.code.slice(5);
    if (/^\d$/.test(d)) return mod(e) + d;
  }

  return mod(e) + key;
}

function mod(e: KeyboardEvent): string {
  let m = "";
  if (e.ctrlKey) m += "Ctrl+";
  if (e.shiftKey) m += "Shift+";
  if (e.altKey) m += "Alt+";
  if (e.metaKey && !e.ctrlKey) m += "Ctrl+"; // treat Cmd as Ctrl
  return m;
}

/** Latin letter of the physical key (e.code "KeyD" -> "D") — layout-independent.
 *  Falls back to e.key when it is already an ASCII letter (synthetic events). */
export function latinKeyOf(e: KeyboardEvent): string | null {
  if (e.code.length === 4 && e.code.startsWith("Key")) return e.code[3];
  return /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : null;
}

/** Cyrillic (ЙЦУКЕН) letter sharing the physical key with the given Latin one. */
const CYR_OF_LATIN: Record<string, string> = {
  Q: "Й", W: "Ц", E: "У", R: "К", T: "Е", Y: "Н", U: "Г", I: "Ш", O: "Щ", P: "З",
  A: "Ф", S: "Ы", D: "В", F: "А", G: "П", H: "Р", J: "О", K: "Л", L: "Д",
  Z: "Я", X: "Ч", C: "С", V: "М", B: "И", N: "Т", M: "Ь",
};
export function cyrillicOfLatin(latin: string): string | null {
  return CYR_OF_LATIN[latin.toUpperCase()] ?? null;
}

/** Default FAR-compatible bindings: context -> chord -> command id */
export const defaultKeymap: Record<KeyContext, Record<string, string>> = {
  panel: {
    Tab: "panel.switchActive",
    "Alt+F1": "panel.drivesLeft",
    "Alt+F2": "panel.drivesRight",
    "Ctrl+F1": "panel.toggleLeft",
    "Ctrl+F2": "panel.toggleRight",
    "Ctrl+O": "panel.hideBoth",
    "Ctrl+P": "panel.showBoth",
    "Ctrl+U": "panel.swap",
    Enter: "panel.enter",
    "Shift+Enter": "panel.enterExternal",
    "Ctrl+Enter": "cmdline.insertCursorName",
    "Ctrl+PageDown": "panel.intoDir",
    "Ctrl+PageUp": "panel.up",
    "Ctrl+Up": "panel.up",
    Backspace: "panel.up",
    "Ctrl+\\": "panel.root",
    "Ctrl+R": "panel.refresh",
    "Ctrl+L": "panel.refresh",
    "Ctrl+.": "panel.toggleHidden",
    Insert: "panel.selectCursor",
    "Gray+": "panel.selectGroup",
    "+": "panel.selectGroup",
    "Gray-": "panel.deselectGroup",
    "-": "panel.deselectGroup",
    "Gray*": "panel.invertSelection",
    "*": "panel.invertSelection",
    "Ctrl+F3": "panel.sortName",
    "Ctrl+F4": "panel.sortExt",
    "Ctrl+F5": "panel.sortMtime",
    "Ctrl+F6": "panel.sortSize",
    "Ctrl+F7": "panel.sortUnsorted",
    "Alt+Shift+Left": "panel.historyBack",
    "Alt+Shift+Right": "panel.historyForward",
    "Alt+Left": "panel.historyBack",
    "Alt+Right": "panel.historyForward",
    F3: "viewer.open",
    F4: "editor.open",
    "Shift+F4": "editor.newFile",
    F5: "fs.copy",
    "Shift+F5": "fs.copyCurrent",
    F6: "fs.move",
    "Shift+F6": "fs.renameCurrent",
    F7: "fs.mkdir",
    F8: "fs.delete",
    "Shift+F8": "fs.deleteCurrent",
    "Shift+Delete": "fs.deletePermanent",
    "Alt+F5": "stub.pack",
    "Alt+F6": "stub.unpack",
    "Alt+F7": "search.openDialog",
    "Ctrl+Insert": "panel.copyNames",
    "Ctrl+Shift+Insert": "panel.copyPaths",
    "Shift+Insert": "cmdline.pasteClipboard",
    "Ctrl+0": "shortcuts.jump0",
    "Ctrl+1": "shortcuts.jump1",
    "Ctrl+2": "shortcuts.jump2",
    "Ctrl+3": "shortcuts.jump3",
    "Ctrl+4": "shortcuts.jump4",
    "Ctrl+5": "shortcuts.jump5",
    "Ctrl+6": "shortcuts.jump6",
    "Ctrl+7": "shortcuts.jump7",
    "Ctrl+8": "shortcuts.jump8",
    "Ctrl+9": "shortcuts.jump9",
    "Ctrl+Shift+0": "shortcuts.assign0",
    "Ctrl+Shift+1": "shortcuts.assign1",
    "Ctrl+Shift+2": "shortcuts.assign2",
    "Ctrl+Shift+3": "shortcuts.assign3",
    "Ctrl+Shift+4": "shortcuts.assign4",
    "Ctrl+Shift+5": "shortcuts.assign5",
    "Ctrl+Shift+6": "shortcuts.assign6",
    "Ctrl+Shift+7": "shortcuts.assign7",
    "Ctrl+Shift+8": "shortcuts.assign8",
    "Ctrl+Shift+9": "shortcuts.assign9",
    "Ctrl+Tab": "ui.nextTab",
    "Ctrl+Shift+Tab": "ui.prevTab",
    "Ctrl+T": "panel.newTab",
    "Ctrl+W": "panel.closeTab",
    F1: "ui.help",
    F2: "stub.userMenu",
    F9: "ui.menu",
    F10: "app.quit",
    F12: "ui.windowList",
    "Alt+F12": "panel.dirHistory",
    "Alt+F8": "cmdline.history",
    "Alt+F11": "stub.viewHistory",
    "Ctrl+E": "cmdline.prevHistory",
    Esc: "panel.escape",
  },
  editor: {
    F2: "editor.save",
    "Shift+F2": "editor.saveAs",
    "Ctrl+S": "editor.save",
    F4: "editor.open",
    "Shift+F4": "editor.newFile",
    F7: "editor.search",
    F8: "editor.deleteLine",
    F11: "ui.plugins",
    "Ctrl+Y": "editor.deleteLine",
    "Ctrl+G": "editor.gotoLine",
    "Ctrl+Shift+L": "editor.convertLayout",
    F1: "ui.help",
    Esc: "editor.close",
    "Ctrl+Tab": "ui.nextTab",
    "Ctrl+Shift+Tab": "ui.prevTab",
    F10: "app.quit",
    F12: "ui.windowList",
  },
  viewer: {
    F1: "ui.help",
    F4: "viewer.toEditor",
    F8: "viewer.toggleHex",
    Esc: "viewer.close",
    "Ctrl+Tab": "ui.nextTab",
    "Ctrl+Shift+Tab": "ui.prevTab",
    F10: "app.quit",
    F12: "ui.windowList",
  },
  dialog: {
    Esc: "dialog.close",
  },
};
