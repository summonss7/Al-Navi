/** F1 help content: fixed chord/description rows, grouped into sections.
 *  Descriptions are i18n keys (en+ru translated, other locales fall back to en). */

export interface HelpItem {
  /** key combination shown in the kbd chip; "" = description-only row */
  chord: string;
  /** i18n key of the description */
  key: string;
}

export interface HelpSection {
  title: string;
  /** Phosphor duotone icon class shown next to the section title */
  icon: string;
  items: HelpItem[];
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    title: "help.nav",
    icon: "ph-arrows-out",
    items: [
      { chord: "↑ ↓", key: "help.nav.cursor" },
      { chord: "← →", key: "help.nav.page" },
      { chord: "Home / End", key: "help.nav.home" },
      { chord: "PgUp / PgDn", key: "help.nav.pg" },
      { chord: "Enter", key: "help.nav.enter" },
      { chord: "Shift+Enter", key: "help.nav.enterExt" },
      { chord: "Ctrl+↑", key: "help.nav.up" },
      { chord: "Ctrl+PgUp", key: "help.nav.parent" },
      { chord: "Ctrl+PgDn", key: "help.nav.into" },
      { chord: "Backspace", key: "help.nav.backspace" },
      { chord: "Ctrl+\\", key: "help.nav.root" },
      { chord: "Tab", key: "help.nav.tab" },
      { chord: "Alt+← / →", key: "help.nav.history" },
      { chord: "Alt+F12", key: "help.nav.dirHist" },
      { chord: "Alt+F1 / F2", key: "help.nav.drives" },
      { chord: "Ctrl+Tab", key: "help.nav.ring" },
      { chord: "Ctrl+0…9", key: "help.nav.shortcuts" },
      { chord: "Ctrl+Shift+0…9", key: "help.nav.pin" },
      { chord: "Ctrl+T / W", key: "help.nav.tabs" },
      { chord: "F12", key: "help.nav.windows" },
    ],
  },
  {
    title: "help.ops",
    icon: "ph-copy",
    items: [
      { chord: "F3", key: "help.ops.view" },
      { chord: "Alt+F11", key: "help.ops.viewHist" },
      { chord: "F4", key: "help.ops.edit" },
      { chord: "Shift+F4", key: "help.ops.new" },
      { chord: "Ctrl+Shift+F4", key: "help.ops.scratch" },
      { chord: "F5", key: "help.ops.copy" },
      { chord: "Shift+F5", key: "help.ops.copyCur" },
      { chord: "F6", key: "help.ops.move" },
      { chord: "Shift+F6", key: "help.ops.rename" },
      { chord: "Ctrl+M", key: "help.ops.multiRename" },
      { chord: "F2", key: "help.ops.userMenu" },
      { chord: "Shift+Enter · F5/F6", key: "help.ops.selfName" },
      { chord: "F7", key: "help.ops.mkdir" },
      { chord: "Ctrl+A", key: "help.ops.attrs" },
      { chord: "F8", key: "help.ops.delete" },
      { chord: "Shift+F8", key: "help.ops.deleteCur" },
      { chord: "Shift+Del", key: "help.ops.wipe" },
      { chord: "Alt+F5", key: "help.ops.pack" },
      { chord: "Alt+F6", key: "help.ops.unpack" },
      { chord: "Alt+F7", key: "help.ops.find" },
      { chord: "Ctrl+R", key: "help.ops.refresh" },
      { chord: "Ctrl+L", key: "help.ops.driveInfo" },
    ],
  },
  {
    title: "help.sel",
    icon: "ph-check-square",
    items: [
      { chord: "Insert", key: "help.sel.toggle" },
      { chord: "+ / −", key: "help.sel.group" },
      { chord: "*", key: "help.sel.invert" },
      { chord: "Ctrl+Insert", key: "help.sel.copyName" },
      { chord: "Ctrl+Shift+Insert", key: "help.sel.copyPath" },
      { chord: "Shift+Insert", key: "help.sel.paste" },
      { chord: "Alt+letter", key: "help.sel.jump" },
      { chord: "Ctrl+F3…F7", key: "help.sel.sort" },
      { chord: "Ctrl+.", key: "help.sel.hidden" },
      { chord: "Ctrl+O / P / U", key: "help.sel.panels" },
      { chord: "Ctrl+F1 / F2", key: "help.sel.panelOne" },
      { chord: "Ctrl+← / →", key: "help.sel.split" },
    ],
  },
  {
    title: "help.cmd",
    icon: "ph-terminal-window",
    items: [
      { chord: "", key: "help.cmd.always" },
      { chord: "Enter", key: "help.cmd.run" },
      { chord: "Esc", key: "help.cmd.clear" },
      { chord: "Shift+← / →", key: "help.cmd.selChar" },
      { chord: "Ctrl+Shift+← / →", key: "help.cmd.selWord" },
      { chord: "Shift+Home / End", key: "help.cmd.selLine" },
      { chord: "Ctrl+E", key: "help.cmd.hist" },
      { chord: "Ctrl+X", key: "help.cmd.histNext" },
      { chord: "Alt+F8", key: "help.cmd.histDlg" },
      { chord: "Ctrl+Enter", key: "help.cmd.insName" },
      { chord: "cd <path>", key: "help.cmd.cd" },
    ],
  },
  {
    title: "help.ed",
    icon: "ph-text-aa",
    items: [
      { chord: "F2 / Ctrl+S", key: "help.ed.save" },
      { chord: "Shift+F2", key: "help.ed.saveAs" },
      { chord: "F4", key: "help.ed.open" },
      { chord: "Shift+F4", key: "help.ed.new" },
      { chord: "F7", key: "help.ed.search" },
      { chord: "F11 · editor", key: "help.ed.plugins" },
      { chord: "Ctrl+Shift+L", key: "help.ed.layout" },
      { chord: "Shift+Alt+↑ ↓ ← → · PgUp/PgDn", key: "help.ed.column" },
      { chord: "Shift+Alt+Home / End", key: "help.ed.columnFull" },
      { chord: "Ctrl+PgUp / Ctrl+PgDn", key: "help.ed.docHome" },
      { chord: "Ctrl+G", key: "help.ed.goto" },
      { chord: "Ctrl+Y", key: "help.ed.delLine" },
      { chord: "F8 · editor / Shift+F8 · viewer", key: "help.ed.encoding" },
      { chord: "F8 · viewer", key: "help.ed.hex" },
      { chord: "F4 · viewer", key: "help.ed.toEditor" },
      { chord: "Esc", key: "help.ed.close" },
    ],
  },
  {
    title: "help.dlg",
    icon: "ph-dialog",
    items: [
      { chord: "↑ ↓ ← →", key: "help.dlg.nav" },
      { chord: "↑ ↓ · F5/F6", key: "help.dlg.variants" },
      { chord: "Enter", key: "help.dlg.ok" },
      { chord: "Esc", key: "help.dlg.close" },
      { chord: "C:, D: …", key: "help.dlg.drive" },
      { chord: "2", key: "help.dlg.ftpKey" },
      { chord: "3", key: "help.dlg.sftpKey" },
    ],
  },
  {
    title: "help.app",
    icon: "ph-gear",
    items: [
      { chord: "F1", key: "help.app.help" },
      { chord: "F9", key: "help.app.settings" },
      { chord: "Ctrl+− / + · Ctrl+Wheel", key: "help.app.font" },
      { chord: "F10", key: "help.app.quit" },
    ],
  },
  {
    title: "help.tips",
    icon: "ph-lightbulb",
    items: [
      { chord: "", key: "help.tips.sort" },
      { chord: "", key: "help.tips.f9" },
      { chord: "", key: "help.tips.colors" },
      { chord: "", key: "help.tips.watch" },
      { chord: "", key: "help.tips.trash" },
      { chord: "", key: "help.tips.version" },
    ],
  },
];
