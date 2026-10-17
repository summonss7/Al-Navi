// Keyboard navigation for the list-style dialogs (drives, F12 windows,
// histories, F2 user menu, F11 plugins, FTP) and arrow-walking for the button
// dialogs (confirm / conflict). FAR semantics: Left/Right also move the cursor
// by a visible page, Up/Down one row (with wrap).
// The handler is attached to the window in the CAPTURE phase by the Dialogs
// router: keys handled by a dialog must be stopped on the way down — the
// editor's CodeMirror listens on its focused content DOM and would run before
// a bubble-phase window listener (Enter inserted a newline while the F11
// plugins dialog was open).
import { ui } from "$lib/stores/ui.svelte";
import { panels } from "$lib/stores/panels.svelte";
import { editor } from "$lib/stores/editor.svelte";
import { cmdline } from "$lib/stores/cmdline.svelte";
import { ftpSites } from "$lib/stores/ftpSites.svelte";
import { userMenu } from "$lib/stores/userMenu.svelte";
import { latinKeyOf, digitKeyOf } from "$lib/keymap";
import { FTP_DRIVE_KEY, SFTP_DRIVE_KEY } from "$lib/ftp";
import { EDITOR_PLUGINS } from "$lib/plugins";
import { ENCODING_MENU } from "$lib/encodings";
import { drivesState, pickDrive } from "./drivesState.svelte";
import { pluginSel, pluginModes, applyPluginMode } from "./pluginsState.svelte";
import { ftpConnectSite, presetFtpScheme } from "./ftpState.svelte";
import { umAdd, umEdit, umDelete, execUserMenuItem } from "./userMenuState.svelte";

export const LIST_DIALOGS = new Set([
  "drives",
  "windowList",
  "dirHistory",
  "cmdHistory",
  "viewHist",
  "userMenu",
  "plugins",
  "ftp",
  "encoding",
]);

/** keyboard cursor of whichever list dialog is open (-1 = none yet);
 *  object state so dialog components can read and reset it (property
 *  mutation) — exported state must never be reassigned */
export const listCursor = $state<{ idx: number }>({ idx: -1 });

export function listCount(): number {
  switch (ui.dialog) {
    case "drives":
      return drivesState.list.length;
    case "windowList":
      return 1 + editor.docs.length + editor.viewDocs.length;
    case "dirHistory":
      return panels.dirHistory.length;
    case "cmdHistory":
      return cmdline.history.length;
    case "viewHist":
      return editor.viewHistory.length;
    case "userMenu":
      return userMenu.items.length;
    case "plugins":
      return pluginSel.id ? pluginModes().length : EDITOR_PLUGINS.length;
    case "ftp":
      return ftpSites.sites.length;
    case "encoding":
      return ENCODING_MENU.length;
    default:
      return 0;
  }
}

export function activateListItem(i: number) {
  switch (ui.dialog) {
    case "drives":
      if (drivesState.list[i]) void pickDrive(drivesState.list[i]);
      break;
    case "windowList": {
      if (i === 0) {
        ui.setMode("panels");
        ui.closeDialog();
        return;
      }
      const d = i - 1;
      if (d < editor.docs.length) {
        editor.activate(editor.docs[d].id);
      } else {
        const v = editor.viewDocs[d - editor.docs.length];
        if (v) editor.activate(v.id);
      }
      ui.closeDialog();
      break;
    }
    case "dirHistory": {
      const p = panels.dirHistory[i];
      if (p !== undefined) {
        void panels.active.chdir(p);
        ui.closeDialog();
      }
      break;
    }
    case "cmdHistory": {
      const c = cmdline.history[i];
      if (c !== undefined) {
        cmdline.setText(c);
        ui.closeDialog();
      }
      break;
    }
    case "viewHist": {
      const p = editor.viewHistory[i];
      if (p !== undefined) {
        void editor.view(p);
        ui.closeDialog();
      }
      break;
    }
    case "userMenu": {
      const it = userMenu.items[i];
      if (it) execUserMenuItem(it);
      break;
    }
    case "plugins": {
      if (pluginSel.id === null) {
        const p = EDITOR_PLUGINS[i];
        if (p) {
          pluginSel.id = p.id;
          listCursor.idx = 0;
        }
      } else {
        const m = pluginModes()[i];
        if (m && pluginSel.id) applyPluginMode(pluginSel.id, m.id);
      }
      break;
    }
    case "ftp": {
      const s = ftpSites.sites[i];
      if (s) void ftpConnectSite(s, false);
      break;
    }
    case "encoding": {
      // the dialog must be gone before the (possibly async) reload opens its
      // own confirm for unsaved changes — closeDialog would otherwise clear it
      const enc = ENCODING_MENU[i];
      const editId = editor.active?.id ?? null;
      const viewId = editor.activeViewer?.id ?? null;
      const mode = ui.mode;
      ui.closeDialog();
      if (enc === undefined) break;
      if (mode === "viewer" && viewId !== null) void editor.reopenViewerWithEncoding(viewId, enc);
      else if (editId !== null) void editor.reopenWithEncoding(editId, enc);
      break;
    }
  }
}

/** clamp the cursor into the live list length (called from the router's
 *  $effect so every list source stays reactive) */
export function clampListIdx() {
  void ui.dialog;
  void drivesState.list.length;
  void editor.docs.length;
  void editor.viewDocs.length;
  void panels.dirHistory.length;
  void cmdline.history.length;
  void editor.viewHistory.length;
  void userMenu.items.length;
  if (!LIST_DIALOGS.has(ui.dialog ?? "")) {
    if (listCursor.idx !== -1) listCursor.idx = -1;
    return;
  }
  const n = listCount();
  if (n && listCursor.idx < 0) listCursor.idx = 0;
  else if (n && listCursor.idx > n - 1) listCursor.idx = n - 1;
}

/** F8 (editor) / Shift+F8 (viewer): open the encoding picker with the
 *  keyboard cursor already on the document's current encoding */
export function openEncodingDialog() {
  const cur = ui.mode === "viewer" ? editor.activeViewer?.encoding : editor.active?.encoding;
  const idx = cur ? ENCODING_MENU.indexOf(cur) : 0;
  listCursor.idx = idx >= 0 ? idx : 1; // unknown label -> first real encoding
  ui.openDialog("encoding");
}

/** keep the keyboard cursor row visible while walking (router's $effect) */
export function scrollListSel() {
  void listCursor.idx;
  if (LIST_DIALOGS.has(ui.dialog ?? "") && listCursor.idx >= 0) {
    document.querySelector(".drive.kbd, .li.kbd")?.scrollIntoView({ block: "nearest" });
  }
}

// visible items in the dialog list, measured live (for block jumps)
function listPageStep(): number {
  const item =
    document.querySelector<HTMLElement>(".drive.kbd") ??
    document.querySelector<HTMLElement>(".li.kbd") ??
    document.querySelector<HTMLElement>(".dlg-body .drive") ??
    document.querySelector<HTMLElement>(".dlg-body .li");
  const body = item?.closest<HTMLElement>(".dlg-body");
  if (!item || !body || !item.offsetHeight) return 8;
  return Math.max(1, Math.floor(body.clientHeight / item.offsetHeight) - 1);
}

export function onListKey(e: KeyboardEvent) {
  if (!LIST_DIALOGS.has(ui.dialog ?? "")) return;
  // user menu: Ins adds, F4 edits and Del removes the highlighted item
  if (ui.dialog === "userMenu" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    if (e.key === "Insert") {
      e.preventDefault();
      e.stopPropagation();
      umAdd();
      return;
    }
    if (e.key === "F4") {
      e.preventDefault();
      e.stopPropagation();
      umEdit(listCursor.idx);
      return;
    }
    if (e.key === "Delete") {
      e.preventDefault();
      e.stopPropagation();
      void umDelete(listCursor.idx);
      return;
    }
  }
  const n = listCount();
  if (!n) return;
  // drives dialog: the FTP/SFTP entries have the assigned digit keys
  // (2/3 — drive letters can't collide with digits); pressing one opens the
  // site list with that protocol preset for new sites
  if (ui.dialog === "drives" && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const digit = digitKeyOf(e);
    if (digit === FTP_DRIVE_KEY || digit === SFTP_DRIVE_KEY) {
      e.preventDefault();
      e.stopPropagation();
      presetFtpScheme(digit === SFTP_DRIVE_KEY);
      ui.openDialog("ftp");
      return;
    }
    // pressing a drive letter switches to it right away,
    // matched by physical key so any keyboard layout works (FAR behavior)
    if (e.key.length === 1) {
      const latin = latinKeyOf(e);
      if (latin) {
        const idx = drivesState.list.findIndex((d) => d.mountPoint.toUpperCase().startsWith(latin));
        if (idx >= 0) {
          e.preventDefault();
          e.stopPropagation();
          void pickDrive(drivesState.list[idx]);
          return;
        }
      }
    }
  }
  // FTP list: a site's assigned jump key (letter or digit, physical)
  // connects to that site right away
  if (ui.dialog === "ftp" && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
    const hk = latinKeyOf(e) ?? digitKeyOf(e);
    const s = hk ? ftpSites.sites.find((x) => x.hotkey === hk) : undefined;
    if (s) {
      e.preventDefault();
      e.stopPropagation();
      void ftpConnectSite(s, false);
      return;
    }
  }
  let handled = true;
  switch (e.key) {
    case "ArrowDown":
      listCursor.idx = listCursor.idx < 0 ? 0 : (listCursor.idx + 1) % n;
      break;
    case "ArrowUp":
      listCursor.idx = listCursor.idx < 0 ? 0 : (listCursor.idx - 1 + n) % n;
      break;
    // block walking: jump by a visible page, clamped (no wrap)
    case "ArrowRight": {
      const s = listPageStep();
      listCursor.idx = listCursor.idx < 0 ? 0 : Math.min(n - 1, listCursor.idx + s);
      break;
    }
    case "ArrowLeft": {
      const s = listPageStep();
      listCursor.idx = listCursor.idx < 0 ? 0 : Math.max(0, listCursor.idx - s);
      break;
    }
    case "Home":
      listCursor.idx = 0;
      break;
    case "End":
      listCursor.idx = n - 1;
      break;
    case "Enter":
      if (listCursor.idx >= 0) activateListItem(listCursor.idx);
      else handled = false;
      break;
    default:
      handled = false;
  }
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

// ---- button dialogs (confirm / conflict): focus the default button and let
// arrows walk the actions so the "cursor" sits on the form, not in the text ----
export function onButtonDialogKey(e: KeyboardEvent) {
  const id = ui.dialog;
  if (id !== "confirm" && id !== "conflict") return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const dlg = document.querySelector(".overlay .dlg");
  const btns = dlg
    ? Array.from(dlg.querySelectorAll<HTMLButtonElement>(".dlg-actions button")).filter(
        (b) => !b.disabled,
      )
    : [];
  if (btns.length < 2) return;
  const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
  const dir = e.key === "ArrowRight" ? 1 : -1;
  btns[(idx < 0 ? 0 : idx + dir + btns.length) % btns.length].focus();
  e.preventDefault();
  e.stopPropagation();
}

export function onWindowKey(e: KeyboardEvent) {
  onListKey(e);
  onButtonDialogKey(e);
}
