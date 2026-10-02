<script lang="ts">
  import { onMount } from "svelte";
  import { ui, type AttrBits } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { ops } from "$lib/stores/ops.svelte";
  import { panels } from "$lib/stores/panels.svelte";
  import { editor } from "$lib/stores/editor.svelte";
  import { cmdline, runCommand as runCmdline } from "$lib/stores/cmdline.svelte";
  import { settings, THEMES, type ThemeId } from "$lib/stores/settings.svelte";
  import { LOCALES, type Locale } from "$lib/stores/i18n.svelte";
  import { drivesList, appInfo, ftpConnect, pathExists, type AppInfo } from "$lib/api";
  import { latinKeyOf } from "$lib/keymap";
  import { formatSize, pathKey, basename, parentOf, joinPath } from "$lib/format";
  import { applyMultiRename, defaultMrForm } from "$lib/multiRename";
  import { HELP_SECTIONS } from "$lib/help";
  import { fileColors } from "$lib/stores/fileColors.svelte";
  import { textColors, type BuiltinRule, type MaskRule } from "$lib/stores/textColors.svelte";
  import { ftpSites } from "$lib/stores/ftpSites.svelte";
  import { userMenu, expandUserPlaceholders, type UserMenuItem } from "$lib/stores/userMenu.svelte";
  import { newFtpSite, isFtpPath, type FtpSite } from "$lib/ftp";
  import { isSearchPath, searchStore } from "$lib/stores/search.svelte";
  import { EDITOR_PLUGINS, type CaseMode, type LayoutMode } from "$lib/plugins";
  import type { DriveInfo } from "$lib/types";

  let appVer = $state<AppInfo | null>(null);
  $effect(() => {
    if (ui.dialog === "menu" && !appVer) {
      appInfo().then((i) => (appVer = i)).catch(() => {});
    }
  });

  // generic focus helper
  function autofocus(node: HTMLElement) {
    setTimeout(() => node.focus(), 0);
  }
  // input dialogs open with the whole value selected — typing then overtypes
  // it; placing the caret by hand (click, arrows, Home/End) unselects and
  // inserts instead
  let inputEl: HTMLInputElement | null = null;
  function focusSelect(node: HTMLInputElement) {
    inputEl = node;
    // a timeout, not rAF: rAF never fires while the window is hidden/minimized
    setTimeout(() => { node.focus(); node.select(); }, 0);
    return { destroy: () => { inputEl = null; } };
  }

  // ---- confirm ----
  let confirmVal = $state(false);

  // ---- input ----
  let inputVal = $state("");
  // highlighted destination variant; -1 = hand-edited field (or the initial
  // value isn't a variant, e.g. a single file's dest+name prefill)
  let variantIdx = $state(-1);
  $effect(() => {
    const req = ui.inputReq;
    if (!req) return;
    inputVal = req.value;
    variantIdx = req.variants?.findIndex((v) => pathKey(v) === pathKey(req.value)) ?? -1;
  });

  // ---- drives ----
  let drives = $state<DriveInfo[]>([]);
  $effect(() => {
    if (ui.dialog === "drives") {
      // the FTP entry rides at the end of the drive list (jump key: F)
      drivesList()
        .then((d) => (drives = [...d, { name: "FTP", mountPoint: "ftp://", kind: "ftp", totalBytes: 0, freeBytes: 0 }]))
        .catch(console.error);
    }
  });

  async function pickDrive(d: DriveInfo) {
    if (d.kind === "ftp") {
      ui.openDialog("ftp");
      return;
    }
    const panel = ui.drivesFor === "left" ? panels.left : panels.right;
    panels.activeSide = ui.drivesFor;
    await panel.chdir(d.mountPoint);
    panels.pushDirHistory(d.mountPoint);
    ui.closeDialog();
  }

  function driveIcon(kind: string): string {
    switch (kind) {
      case "removable": return "ph-usb";
      case "cd": return "ph-disc";
      case "network": return "ph-hard-drives";
      case "home": return "ph-house";
      case "root": return "ph-drives";
      case "ftp": return "ph-globe-hemisphere-west";
      default: return "ph-hard-drive";
    }
  }

  // ---- FTP sites (drive menu → FTP) ----
  let ftpForm = $state<FtpSite>(newFtpSite());
  /** which flavor of the site form is open */
  let ftpFormMode = $state<"quick" | "add" | "edit">("add");

  async function ftpConnectSite(site: FtpSite, save: boolean) {
    if (!site.host.trim()) {
      ui.showToast(i18n.t("ftp.hostMissing"));
      return;
    }
    if (save) {
      ftpSites.upsert({ ...site, name: site.name.trim() || site.host.trim() });
    }
    try {
      const root = await ftpConnect(site.host, site.port || 21, site.user, site.password);
      const panel = ui.drivesFor === "left" ? panels.left : panels.right;
      panels.activeSide = ui.drivesFor;
      await panel.chdir(root);
      panels.pushDirHistory(root);
      ui.closeDialog();
    } catch (e) {
      ui.showError(String(e));
    }
  }

  function ftpQuick() {
    ftpForm = newFtpSite();
    ftpFormMode = "quick";
    ui.openDialog("ftpSite");
  }

  function ftpAdd() {
    ftpForm = newFtpSite();
    ftpFormMode = "add";
    ui.openDialog("ftpSite");
  }

  function ftpEdit() {
    const s = ftpSites.sites[listIdx];
    if (!s) return;
    ftpForm = { ...s };
    ftpFormMode = "edit";
    ui.openDialog("ftpSite");
  }

  function ftpDelete() {
    const s = ftpSites.sites[listIdx];
    if (s) ftpSites.remove(s.id);
  }

  function submitFtpForm() {
    void ftpConnectSite(ftpForm, ftpFormMode !== "quick");
  }

  // ---- user menu (F2) ----
  let umFormMode = $state<"add" | "edit">("add");
  let umEditId = $state<number | undefined>(undefined);
  let umTitle = $state("");
  let umCommand = $state("");

  function umAdd() {
    umFormMode = "add";
    umEditId = undefined;
    umTitle = "";
    umCommand = "";
    ui.openDialog("userMenuItem");
  }

  function umEdit() {
    const it = userMenu.items[listIdx];
    if (!it) return;
    umFormMode = "edit";
    umEditId = it.id;
    umTitle = it.title;
    umCommand = it.command;
    ui.openDialog("userMenuItem");
  }

  async function umDelete() {
    const it = userMenu.items[listIdx];
    if (!it) return;
    ui.closeDialog();
    if (await ui.askConfirm(i18n.t("umenu.delConfirm", { title: it.title }))) {
      userMenu.remove(it.id);
    }
    ui.openDialog("userMenu");
  }

  function submitUmForm() {
    if (!umCommand.trim()) return;
    userMenu.upsert({
      id: umEditId,
      title: umTitle.trim() || umCommand.trim(),
      command: umCommand.trim(),
    });
    ui.openDialog("userMenu");
  }

  /** run a menu command exactly as if typed on the command line: placeholders
   *  expand against the panel cursor, the result lands in Alt+F8 history and
   *  goes through runCommand (cd / ftp:// / external shell) */
  function execUserMenuItem(item: UserMenuItem) {
    const final = expandUserPlaceholders(item.command);
    ui.closeDialog();
    cmdline.setText(final);
    cmdline.submit();
    void runCmdline(final);
  }

  // ---- multi-rename (Ctrl+M) ----
  let mrForm = $state(defaultMrForm());
  $effect(() => {
    // every fresh request starts from a clean form
    if (ui.multiRenameReq) mrForm = defaultMrForm();
  });
  const mrRows = $derived(applyMultiRename(ui.multiRenameReq?.targets ?? [], mrForm));
  const mrOkCount = $derived(mrRows.reduce((n, r) => n + (r.status === "ok" ? 1 : 0), 0));
  /** new names already occupied on disk (filled by the debounced check below) */
  let mrConflicts = $state<Set<string>>(new Set());
  const mrBlocked = $derived(
    mrOkCount === 0 ||
      mrRows.some(
        (r) => r.status === "invalid" || r.status === "dup" || mrConflicts.has(r.newName.toLowerCase()),
      ),
  );
  const MR_PREVIEW_MAX = 300;

  // new names already occupied on disk (debounced, capped): the pure transform
  // can only see the batch itself, existing targets are an async question
  let mrSeq = 0;
  let mrTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const rows = mrRows;
    if (!ui.multiRenameReq) {
      mrConflicts = new Set();
      return;
    }
    clearTimeout(mrTimer);
    mrConflicts = new Set();
    const seq = ++mrSeq;
    mrTimer = setTimeout(async () => {
      if (seq !== mrSeq || !ui.multiRenameReq) return;
      const found = new Set<string>();
      const checks: Promise<void>[] = [];
      for (const r of rows) {
        if (r.status !== "ok") continue;
        // a case-only rename targets the file itself — not a conflict
        if (r.newName.toLowerCase() === r.oldName.toLowerCase()) continue;
        const dir = parentOf(r.oldPath);
        if (!dir) continue;
        const target = joinPath(dir, r.newName);
        checks.push(
          pathExists(target)
            .then((yes) => {
              if (yes) found.add(r.newName.toLowerCase());
            })
            .catch(() => {}),
        );
        if (checks.length >= MR_PREVIEW_MAX) break;
      }
      await Promise.all(checks);
      if (seq === mrSeq) mrConflicts = found;
    }, 250);
  });

  function submitMultiRename() {
    const req = ui.multiRenameReq;
    if (!req || mrBlocked) return;
    const pairs = mrRows
      .filter((r) => r.status === "ok")
      .map((r) => ({ old: r.oldPath, new: joinPath(parentOf(r.oldPath) ?? "", r.newName) }));
    if (!pairs.length) return;
    req.resolve();
    void ops.startRename(pairs);
  }

  function closeMultiRename() {
    ui.multiRenameReq?.resolve();
  }

  // ---- find files (Alt+F7) ----
  interface SearchFormState {
    root: string;
    mask: string;
    useRegex: boolean;
    text: string;
    textCase: boolean;
    dateFrom: string; // yyyy-mm-dd from <input type=date>
    dateTo: string;
    sizeFrom: string; // bytes or 10k / 2m / 1g
    sizeTo: string;
    findDirs: boolean;
  }
  let searchForm = $state<SearchFormState>({
    root: "", mask: "", useRegex: false, text: "", textCase: false,
    dateFrom: "", dateTo: "", sizeFrom: "", sizeTo: "", findDirs: true,
  });

  function defaultSearchRoot(): string {
    const a = panels.active.path;
    if (!isFtpPath(a) && !isSearchPath(a)) return a;
    const b = panels.inactive.path;
    if (!isFtpPath(b) && !isSearchPath(b)) return b;
    return searchStore.originPath ?? "";
  }

  $effect(() => {
    if (ui.dialog !== "search") return;
    const lp = searchStore.lastParams;
    searchForm = {
      root: lp?.root || defaultSearchRoot(),
      mask: lp?.mask ?? "*",
      useRegex: lp?.useRegex ?? false,
      text: lp?.text ?? "",
      textCase: lp?.textCaseSensitive ?? false,
      dateFrom: lp?.dateFrom != null ? datePickerOf(lp.dateFrom) : "",
      dateTo: lp?.dateTo != null ? datePickerOf(lp.dateTo) : "",
      sizeFrom: lp?.sizeFrom != null ? String(lp.sizeFrom) : "",
      sizeTo: lp?.sizeTo != null ? String(lp.sizeTo) : "",
      findDirs: lp?.findDirs ?? true,
    };
  });

  function datePickerOf(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** "10k" / "2m" / "1g" / plain bytes; null = empty, NaN = unparseable */
  function parseSizeInput(v: string): number | null {
    const t = v.trim().toLowerCase();
    if (!t) return null;
    const m = /^(\d+(?:\.\d+)?)\s*(k|kb|m|mb|g|gb|b)?$/.exec(t);
    if (!m) return NaN;
    const mult =
      m[2] === "k" || m[2] === "kb" ? 1024 :
      m[2] === "m" || m[2] === "mb" ? 1024 ** 2 :
      m[2] === "g" || m[2] === "gb" ? 1024 ** 3 : 1;
    return Math.round(parseFloat(m[1]) * mult);
  }

  function submitSearch() {
    const root = searchForm.root.trim();
    if (!root) {
      ui.showToast(i18n.t("search.rootMissing"));
      return;
    }
    const sizeFrom = parseSizeInput(searchForm.sizeFrom);
    const sizeTo = parseSizeInput(searchForm.sizeTo);
    if (Number.isNaN(sizeFrom) || Number.isNaN(sizeTo)) {
      ui.showToast(i18n.t("search.badSize"));
      return;
    }
    const dateFrom = searchForm.dateFrom ? new Date(searchForm.dateFrom + "T00:00:00").getTime() : null;
    const dateTo = searchForm.dateTo ? new Date(searchForm.dateTo + "T23:59:59.999").getTime() : null;
    ui.closeDialog();
    void searchStore.start({
      root,
      mask: searchForm.mask.trim(),
      useRegex: searchForm.useRegex,
      text: searchForm.text.trim() || null,
      textCaseSensitive: searchForm.textCase,
      dateFrom,
      dateTo,
      sizeFrom,
      sizeTo,
      findDirs: searchForm.findDirs,
    });
  }

  // ---- keyboard navigation for list dialogs (drives, F12 windows, histories)
  // FAR semantics: Left/Right also move the cursor (up/down) for fast walking
  const LIST_DIALOGS = new Set(["drives", "windowList", "dirHistory", "cmdHistory", "viewHist", "userMenu", "plugins", "ftp"]);
  let listIdx = $state(-1);

  // ---- plugins (F11): plugin list -> mode list of the chosen plugin ----
  let pluginSel = $state<string | null>(null);
  $effect(() => {
    if (ui.dialog !== "plugins") pluginSel = null;
  });

  function pluginModes() {
    return EDITOR_PLUGINS.find((p) => p.id === pluginSel)?.modes ?? [];
  }

  function pluginIcon(): string {
    return EDITOR_PLUGINS.find((p) => p.id === pluginSel)?.icon ?? "ph-puzzle-piece";
  }

  async function applyCaseMode(mode: CaseMode) {
    ui.closeDialog();
    pluginSel = null;
    const { changeCaseCmd } = await import("$lib/editor/cm");
    const n = changeCaseCmd(mode);
    if (!n) ui.showToast(i18n.t("plug.noSel"));
  }

  async function applyLayoutMode(mode: LayoutMode) {
    ui.closeDialog();
    pluginSel = null;
    const { convertLayoutCmd } = await import("$lib/editor/cm");
    const n = convertLayoutCmd(mode);
    if (!n) ui.showToast(i18n.t("plug.noSel"));
  }

  /** run the chosen mode of the chosen F11 plugin */
  function applyPluginMode(pluginId: string, modeId: string) {
    if (pluginId === "layout") return void applyLayoutMode(modeId as LayoutMode);
    return void applyCaseMode(modeId as CaseMode);
  }

  function listCount(): number {
    switch (ui.dialog) {
      case "drives": return drives.length;
      case "windowList": return 1 + editor.docs.length + editor.viewDocs.length;
      case "dirHistory": return panels.dirHistory.length;
      case "cmdHistory": return cmdline.history.length;
      case "viewHist": return editor.viewHistory.length;
      case "userMenu": return userMenu.items.length;
      case "plugins": return pluginSel ? pluginModes().length : EDITOR_PLUGINS.length;
      case "ftp": return ftpSites.sites.length;
      default: return 0;
    }
  }

  function activateListItem(i: number) {
    switch (ui.dialog) {
      case "drives":
        if (drives[i]) void pickDrive(drives[i]);
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
        if (pluginSel === null) {
          const p = EDITOR_PLUGINS[i];
          if (p) {
            pluginSel = p.id;
            listIdx = 0;
          }
        } else {
          const m = pluginModes()[i];
          if (m && pluginSel) applyPluginMode(pluginSel, m.id);
        }
        break;
      }
      case "ftp": {
        const s = ftpSites.sites[i];
        if (s) void ftpConnectSite(s, false);
        break;
      }
    }
  }

  $effect(() => {
    void ui.dialog;
    void drives.length;
    void editor.docs.length;
    void editor.viewDocs.length;
    void panels.dirHistory.length;
    void cmdline.history.length;
    void editor.viewHistory.length;
    void userMenu.items.length;
    if (!LIST_DIALOGS.has(ui.dialog ?? "")) {
      if (listIdx !== -1) listIdx = -1;
      return;
    }
    const n = listCount();
    if (n && listIdx < 0) listIdx = 0;
    else if (n && listIdx > n - 1) listIdx = n - 1;
  });

  $effect(() => {
    if (LIST_DIALOGS.has(ui.dialog ?? "") && listIdx >= 0) {
      document.querySelector(".drive.kbd, .li.kbd")?.scrollIntoView({ block: "nearest" });
    }
  });

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

  function onListKey(e: KeyboardEvent) {
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
        umEdit();
        return;
      }
      if (e.key === "Delete") {
        e.preventDefault();
        e.stopPropagation();
        void umDelete();
        return;
      }
    }
    const n = listCount();
    if (!n) return;
    // drives dialog: pressing a drive letter switches to it right away,
    // matched by physical key so any keyboard layout works (FAR behavior)
    if (ui.dialog === "drives" && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      const latin = latinKeyOf(e);
      if (latin) {
        const idx = drives.findIndex((d) => d.mountPoint.toUpperCase().startsWith(latin));
        if (idx >= 0) {
          e.preventDefault();
          e.stopPropagation();
          void pickDrive(drives[idx]);
          return;
        }
      }
    }
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        listIdx = listIdx < 0 ? 0 : (listIdx + 1) % n;
        break;
      case "ArrowUp":
        listIdx = listIdx < 0 ? 0 : (listIdx - 1 + n) % n;
        break;
      // block walking: jump by a visible page, clamped (no wrap)
      case "ArrowRight": {
        const s = listPageStep();
        listIdx = listIdx < 0 ? 0 : Math.min(n - 1, listIdx + s);
        break;
      }
      case "ArrowLeft": {
        const s = listPageStep();
        listIdx = listIdx < 0 ? 0 : Math.max(0, listIdx - s);
        break;
      }
      case "Home":
        listIdx = 0;
        break;
      case "End":
        listIdx = n - 1;
        break;
      case "Enter":
        if (listIdx >= 0) activateListItem(listIdx);
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
  function onButtonDialogKey(e: KeyboardEvent) {
    const id = ui.dialog;
    if (id !== "confirm" && id !== "conflict") return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const dlg = document.querySelector(".overlay .dlg");
    const btns = dlg
      ? Array.from(dlg.querySelectorAll<HTMLButtonElement>(".dlg-actions button")).filter((b) => !b.disabled)
      : [];
    if (btns.length < 2) return;
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    const dir = e.key === "ArrowRight" ? 1 : -1;
    btns[(idx < 0 ? 0 : idx + dir + btns.length) % btns.length].focus();
    e.preventDefault();
    e.stopPropagation();
  }

  function onWindowKey(e: KeyboardEvent) {
    onListKey(e);
    onButtonDialogKey(e);
  }

  // capture phase: keys handled by a dialog must be stopped on the way down —
  // the editor's CodeMirror listens on its focused content DOM and would run
  // before a bubble-phase window listener (Enter inserted a newline while the
  // F11 plugins dialog was open)
  onMount(() => {
    window.addEventListener("keydown", onWindowKey, { capture: true });
    return () => window.removeEventListener("keydown", onWindowKey, { capture: true });
  });

  // ---- input submit ----
  function submitInput() {
    ui.inputReq?.resolve(inputVal);
  }

  function closeInput() {
    ui.inputReq?.resolve(null);
  }

  // ---- archives: Alt+F5 pack ----
  let packName = $state("");
  let packFormat = $state("zip");
  let packFmtIdx = $state(0);
  $effect(() => {
    const req = ui.packReq;
    if (!req) return;
    packName = req.name;
    packFormat = req.formats[0]?.id ?? "zip";
    packFmtIdx = 0;
  });
  function submitPack() {
    ui.packReq?.resolve({ name: packName, format: packFormat });
  }
  function closePack() {
    ui.packReq?.resolve(null);
  }
  // ↑/↓ walk the format list when the focus is outside the name field; inside
  // it they keep their native caret meaning (dialogs own their arrow keys)
  function onPackDlgKey(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const n = ui.packReq?.formats.length ?? 0;
    if (!n) return;
    e.preventDefault();
    packFmtIdx = (packFmtIdx + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    packFormat = ui.packReq!.formats[packFmtIdx].id;
  }

  // ---- archives: Alt+F6 unpack ----
  let unpackDest = $state("");
  let unpackIdx = $state(-1);
  let unpackSubdir = $state(true);
  $effect(() => {
    const req = ui.unpackReq;
    if (!req) return;
    unpackDest = req.destDir;
    unpackIdx = req.variants.findIndex((v) => pathKey(v) === pathKey(req.destDir));
    unpackSubdir = req.subdirDefault;
  });
  function submitUnpack() {
    ui.unpackReq?.resolve({ dest: unpackDest, subdir: unpackSubdir });
  }
  function closeUnpack() {
    ui.unpackReq?.resolve(null);
  }
  // bare ↑/↓ cycle the destination variants, like the F5/F6 transfer dialog
  function onUnpackKey(e: KeyboardEvent) {
    const el = e.currentTarget as HTMLInputElement;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const vars = ui.unpackReq?.variants;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !vars?.length) return;
      e.preventDefault();
      const n = vars.length;
      unpackIdx = unpackIdx < 0
        ? (e.key === "ArrowDown" ? 0 : n - 1)
        : (unpackIdx + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      unpackDest = vars[unpackIdx];
      el.value = vars[unpackIdx];
      setTimeout(() => el.select(), 0);
    }
  }
  function pickUnpackVariant(i: number) {
    const v = ui.unpackReq?.variants[i];
    if (v === undefined) return;
    unpackIdx = i;
    unpackDest = v;
  }

  // ---- Ctrl+A attributes ----
  const ATTR_KEYS = ["readOnly", "hidden", "system", "archive"] as const;
  let attrBits = $state<AttrBits>({ readOnly: "clear", hidden: "clear", system: "clear", archive: "clear" });
  $effect(() => {
    const req = ui.attrsReq;
    if (!req) return;
    attrBits = { ...req.initial };
  });
  function submitAttrs() {
    ui.attrsReq?.resolve({ ...attrBits });
  }
  function closeAttrs() {
    ui.attrsReq?.resolve(null);
  }
  // FAR's tri-state checkbox: clear -> set -> keep(unchanged) -> clear
  function cycleAttr(i: number) {
    const k = ATTR_KEYS[i];
    attrBits[k] = attrBits[k] === "clear" ? "set" : attrBits[k] === "set" ? "keep" : "clear";
  }
  // the dialog opens with the first checkbox focused (autofocus fires on
  // every node it's attached to; here only row 0 should take the caret)
  function autofocusFirst(node: HTMLElement, first?: boolean) {
    if (first) setTimeout(() => node.focus(), 0);
  }
  function onAttrsDlgKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter" && e.key !== " ") return;
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>("#attrs-form input[type=checkbox]"));
    if (!boxes.length) return;
    const idx = boxes.indexOf(document.activeElement as HTMLInputElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      boxes[(idx < 0 ? 0 : idx + (e.key === "ArrowDown" ? 1 : -1) + boxes.length) % boxes.length].focus();
    } else if (e.key === "Enter") {
      // on the action buttons Enter keeps its native meaning (focused button)
      if ((document.activeElement as HTMLElement | null)?.closest(".dlg-actions")) return;
      e.preventDefault();
      submitAttrs();
    } else if (idx >= 0) {
      // space toggles the native checkbox before our state knows about it;
      // cycle ourselves so keep/set/clear never desync from the visual box
      e.preventDefault();
      cycleAttr(idx);
    }
  }

  // F5/F6 transfer dialogs seed `resetTo` with the current file name —
  // Shift+Enter clears the field and drops that name in (selected, ready to
  // be retyped over), so a bare name + Enter renames in the current folder.
  // In dialogs without a name Shift+Enter is simply swallowed: it must not
  // submit, or a slipped Shift turns Enter into an accidental transfer.
  // With destination variants, bare ↑/↓ cycle them (wrapping like the list
  // dialogs), the field takes the variant — selected for overtype, like open.
  function onInputKey(e: KeyboardEvent) {
    const el = e.currentTarget as HTMLInputElement;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const vars = ui.inputReq?.variants;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !vars?.length) return;
      e.preventDefault(); // keep the native caret jump to start/end out
      const n = vars.length;
      variantIdx = variantIdx < 0
        ? (e.key === "ArrowDown" ? 0 : n - 1)
        : (variantIdx + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      inputVal = vars[variantIdx];
      el.value = vars[variantIdx]; // applied now; the binding flush would be too late for select()
      setTimeout(() => el.select(), 0);
      return;
    }
    if (e.key !== "Enter" || !e.shiftKey) return;
    e.preventDefault(); // stop the implicit form submit
    const name = ui.inputReq?.resetTo;
    if (name === undefined) return;
    inputVal = name;
    el.value = name; // applied now; the binding flush would be too late for select()
    setTimeout(() => el.select(), 0);
  }

  // clicking a variant = cycling onto it: the field takes it, overtype-ready
  function pickVariant(i: number) {
    const v = ui.inputReq?.variants?.[i];
    if (v === undefined) return;
    variantIdx = i;
    inputVal = v;
    if (inputEl) {
      inputEl.value = v;
      inputEl.focus();
      setTimeout(() => inputEl?.select(), 0);
    }
  }

  $effect(() => {
    void variantIdx;
    document.querySelector(".variants .li.kbd")?.scrollIntoView({ block: "nearest" });
  });

  // progress helpers — byte-based when the op reports bytes, otherwise
  // file/item-count based (instant renames, deletes without a pre-scan)
  function pct(op: { bytesDone: number; bytesTotal: number; filesDone: number; filesTotal: number }): number {
    if (op.bytesTotal) {
      return Math.min(100, Math.round((op.bytesDone / op.bytesTotal) * 100));
    }
    if (op.filesTotal) {
      return Math.min(100, Math.round((op.filesDone / op.filesTotal) * 100));
    }
    return 0;
  }

  // file-color rules: a small colored sample of the first mask ("*.jpg" -> "sample.jpg")
  function sampleOf(mask: string): string {
    const p = mask.split(/[,;\s]+/).find((x) => x.trim().length > 0) ?? "*";
    return p.replace(/^\*/, "sample").replace(/\*/g, "");
  }

  function setViewFlag(patch: Partial<{ dirsFirst: boolean; showHidden: boolean; showSystem: boolean; markedFirst: boolean }>) {
    settings.set(patch);
    panels.refreshView();
  }

  // font-size stepper bounds; 0.5 steps, value rounded to kill FP noise
  function stepFont(d: number) {
    const v = Math.min(24, Math.max(10, Math.round((settings.s.fontSize + d) * 2) / 2));
    settings.set({ fontSize: v });
  }

  function setDecor(on: boolean) {
    settings.set({ editorDecor: on });
    void import("$lib/editor/cm").then(({ applyEditorDecor }) => applyEditorDecor());
  }

  // ---- text highlight rules (dates / 2+ symbol runs / masks) ----
  // every edit rebuilds the editor decorations immediately
  function bumpDecor() {
    void import("$lib/editor/cm").then(({ applyEditorDecor }) => applyEditorDecor());
  }
  function trBuiltin(kind: "dates" | "special", patch: Partial<BuiltinRule>) {
    textColors.setBuiltin(kind, patch);
    bumpDecor();
  }
  function trMask(id: string, patch: Partial<Omit<MaskRule, "id">>) {
    textColors.updateMask(id, patch);
    bumpDecor();
  }
  function trRemove(id: string) {
    textColors.removeMask(id);
    bumpDecor();
  }
  function trReset() {
    textColors.reset();
    bumpDecor();
  }
  // picker value for a built-in rule without an override: the current theme's
  // token (touch settings.s.theme so open pickers re-read on theme switch)
  function cmVar(name: "--cm-date" | "--cm-special"): string {
    void settings.s.theme;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
</script>

{#if ui.dialog === "confirm" && ui.confirmReq}
  <div class="overlay">
    <div class="dlg" role="alertdialog">
      <div class="dlg-title"><i class="ph-duotone ph-question"></i>{i18n.t("common.ok")}</div>
      <div class="dlg-body">{ui.confirmReq.message}</div>
      <div class="dlg-actions">
        <button class="btn" onclick={() => ui.confirmReq!.resolve(false)}>{i18n.t("common.no")}</button>
        <button class="btn primary" use:autofocus onclick={() => ui.confirmReq!.resolve(true)}>{i18n.t("common.yes")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "input" && ui.inputReq}
  <div class="overlay">
    <div class="dlg" role="dialog">
      <div class="dlg-title"><i class="ph-duotone ph-pencil-simple"></i>{ui.inputReq.title}</div>
      <form class="dlg-body" onsubmit={(e) => { e.preventDefault(); submitInput(); }}>
        <label class="lbl">{ui.inputReq.prompt}</label>
        <input bind:value={inputVal} use:focusSelect spellcheck="false" style="width:100%" onkeydown={onInputKey} oninput={() => { variantIdx = -1; }} />
        {#if ui.inputReq.variants?.length}
          <div class="variants">
            {#each ui.inputReq.variants as v, i}
              <button type="button" class="li" class:kbd={i === variantIdx} title={v} onclick={() => pickVariant(i)}>
                <i class="ph-duotone ph-folder-simple"></i>{v}
              </button>
            {/each}
          </div>
        {/if}
      </form>
      <div class="dlg-actions">
        <button class="btn" onclick={closeInput}>{i18n.t("common.cancel")}</button>
        <button class="btn primary" onclick={submitInput}>{i18n.t("common.ok")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "pack" && ui.packReq}
  <div class="overlay">
    <div class="dlg" role="dialog" onkeydown={onPackDlgKey}>
      <div class="dlg-title"><i class="ph-duotone ph-package"></i>{i18n.t("archive.packTitle")}</div>
      <form class="dlg-body" onsubmit={(e) => { e.preventDefault(); submitPack(); }}>
        <label class="lbl">{i18n.t("archive.packName")}</label>
        <input bind:value={packName} use:focusSelect spellcheck="false" style="width:100%" />
        <label class="lbl" style="margin-top:10px">{i18n.t("archive.packFormat")}</label>
        <div class="variants">
          {#each ui.packReq.formats as f, i}
            <button type="button" class="li" class:kbd={i === packFmtIdx} onclick={() => { packFmtIdx = i; packFormat = f.id; }}>
              <i class="ph-duotone ph-file-zip"></i>{f.ext}
            </button>
          {/each}
        </div>
        <div class="lbl" style="margin-top:10px; opacity:0.75" title={ui.packReq.destDir}>
          {i18n.t("ops.dst")}: {ui.packReq.destDir}
        </div>
      </form>
      <div class="dlg-actions">
        <button class="btn" onclick={closePack}>{i18n.t("common.cancel")}</button>
        <button class="btn primary" onclick={submitPack}>{i18n.t("common.ok")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "unpack" && ui.unpackReq}
  <div class="overlay">
    <div class="dlg" role="dialog">
      <div class="dlg-title"><i class="ph-duotone ph-package"></i>{i18n.t("archive.unpackTitle")}</div>
      <form class="dlg-body" onsubmit={(e) => { e.preventDefault(); submitUnpack(); }}>
        <label class="lbl">{i18n.t("ops.dst")}</label>
        <input bind:value={unpackDest} use:focusSelect spellcheck="false" style="width:100%" onkeydown={onUnpackKey} oninput={() => { unpackIdx = -1; }} />
        {#if ui.unpackReq.variants.length}
          <div class="variants">
            {#each ui.unpackReq.variants as v, i}
              <button type="button" class="li" class:kbd={i === unpackIdx} title={v} onclick={() => pickUnpackVariant(i)}>
                <i class="ph-duotone ph-folder-simple"></i>{v}
              </button>
            {/each}
          </div>
        {/if}
        <label class="lbl check" style="margin-top:10px">
          <input type="checkbox" bind:checked={unpackSubdir} />{i18n.t("archive.unpackSubdir")}
        </label>
      </form>
      <div class="dlg-actions">
        <button class="btn" onclick={closeUnpack}>{i18n.t("common.cancel")}</button>
        <button class="btn primary" onclick={submitUnpack}>{i18n.t("common.ok")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "attrs" && ui.attrsReq}
  <div class="overlay">
    <div class="dlg" role="dialog" onkeydown={onAttrsDlgKey}>
      <div class="dlg-title"><i class="ph-duotone ph-sliders-horizontal"></i>{i18n.t("attrs.title")}</div>
      <form class="dlg-body" id="attrs-form" onsubmit={(e) => { e.preventDefault(); submitAttrs(); }}>
        {#each ATTR_KEYS as k, i (k)}
          <label class="lbl check">
            <input
              type="checkbox"
              checked={attrBits[k] === "set"}
              indeterminate={attrBits[k] === "keep"}
              title={attrBits[k] === "keep" ? i18n.t("attrs.keep") : ""}
              use:autofocusFirst={i === 0}
              onclick={(e) => { e.preventDefault(); cycleAttr(i); }}
            />{i18n.t(`attrs.${k}`)}
          </label>
        {/each}
        <div class="lbl" style="margin-top:10px; opacity:0.75">
          {i18n.t("attrs.nItems", { n: ui.attrsReq.count })}
        </div>
      </form>
      <div class="dlg-actions">
        <button class="btn" onclick={closeAttrs}>{i18n.t("common.cancel")}</button>
        <button class="btn primary" onclick={submitAttrs}>{i18n.t("common.ok")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "progress" && ops.op}
  <div class="overlay" style="align-items:flex-end; padding-bottom: 90px; justify-content:flex-start; padding-inline-start: 16px;">
    <div class="dlg" style="min-width: 460px">
      <div class="dlg-title">
        <i class="ph-duotone ph-arrows-clockwise"></i>
        {ops.op.title}
        {#if ops.op.phase === "done"}
          <span class="badge" class:ok={!ops.op.cancelled && !ops.op.errors.length} class:err={ops.op.cancelled || ops.op.errors.length}>
            {ops.op.cancelled ? i18n.t("ops.cancelled") : ops.op.errors.length ? i18n.t("ops.errors", { n: ops.op.errors.length }) : i18n.t("ops.done")}
          </span>
        {/if}
      </div>
      <div class="dlg-body">
        {#if ops.op.phase === "scan"}
          <div class="scan">{i18n.t("ops.scanning")}</div>
        {:else}
          <div class="bar">
            <div class="fill" style="width:{pct(ops.op)}%"></div>
          </div>
          <div class="prow">
            <span class="mono">{pct(ops.op)}%</span>
            {#if ops.op.bytesTotal}
              <span class="mono">{formatSize(ops.op.bytesDone)} / {formatSize(ops.op.bytesTotal)}</span>
              {#if ops.op.speed}<span class="mono dim">{formatSize(ops.op.speed)}/s</span>{/if}
            {/if}
          </div>
          <div class="pfiles mono">
            {ops.op.filesDone} / {ops.op.filesTotal}
          </div>
          {#if ops.op.current}
            <div class="cur" title={ops.op.current}>{ops.op.current}</div>
          {/if}
        {/if}
        {#if ops.op.errors.length}
          <div class="errs">
            {#each ops.op.errors.slice(0, 6) as er}
              <div class="err"><i class="ph ph-warning-circle"></i> {er.path}: {er.error}</div>
            {/each}
          </div>
        {/if}
      </div>
      <div class="dlg-actions">
        {#if ops.op.phase !== "done"}
          <button class="btn" onclick={() => ops.pauseOrResume()}>
            {ops.op.paused ? i18n.t("ops.resume") : i18n.t("ops.pause")}
          </button>
          <button class="btn" onclick={() => ops.toBackground()}>{i18n.t("ops.background")}</button>
          <button class="btn danger" onclick={() => ops.cancel()}>{i18n.t("ops.cancel")}</button>
        {:else}
          <button class="btn primary" use:autofocus onclick={() => ops.finishOp()}>{i18n.t("common.close")}</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "conflict" && ops.conflict}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title warn"><i class="ph-duotone ph-warning"></i>{i18n.t("ops.conflict")}</div>
      <div class="dlg-body">
        <div class="conf-row"><span class="lbl">{i18n.t("ops.src")}:</span><span class="mono path">{ops.conflict.src}</span></div>
        <div class="conf-row"><span class="lbl">{i18n.t("ops.dst")}:</span><span class="mono path">{ops.conflict.dst}</span></div>
      </div>
      <div class="dlg-actions wrap">
        <button class="btn primary" use:autofocus onclick={() => ops.resolveConflictAction("overwrite")}>{i18n.t("ops.copy")} ↩</button>
        <button class="btn" onclick={() => ops.resolveConflictAction("overwrite_all")}>{i18n.t("common.all")}</button>
        <button class="btn" onclick={() => ops.resolveConflictAction("skip")}>{i18n.t("common.cancel")}</button>
        <button class="btn" onclick={() => ops.resolveConflictAction("skip_all")}>↷ {i18n.t("common.all")}</button>
        <button class="btn" onclick={() => ops.resolveConflictAction("rename")}>{i18n.t("ops.rename")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "drives"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title">
        <i class="ph-duotone ph-hard-drives"></i>
        {i18n.t("drives.title")} — {ui.drivesFor === "left" ? i18n.t("windows.panels") + " 1" : i18n.t("windows.panels") + " 2"}
      </div>
      <div class="dlg-body drives">
        {#each drives as d, i (d.mountPoint)}
          <button class="drive" class:kbd={i === listIdx} onclick={() => void pickDrive(d)}>
            <i class="ph-duotone {driveIcon(d.kind)}"></i>
            <span class="d-name" title={d.mountPoint}>{d.name}</span>
            {#if d.totalBytes}
              <span class="d-free mono">{formatSize(d.freeBytes)} {i18n.t("panel.free")} / {formatSize(d.totalBytes)}</span>
            {/if}
          </button>
        {/each}
      </div>
      <div class="dlg-actions">
        <button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "ftp"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title"><i class="ph-duotone ph-globe-hemisphere-west"></i>{i18n.t("ftp.title")}</div>
      <div class="dlg-body list">
        {#each ftpSites.sites as s, i (s.id)}
          <button class="li" class:kbd={listIdx === i} onclick={() => void ftpConnectSite(s, false)}>
            <i class="ph-duotone ph-globe-hemisphere-west"></i>
            <span class="ftp-name">{s.name || s.host}</span>
            <span class="ftp-addr mono">{s.user || "anonymous"}@{s.host}:{s.port || 21}</span>
          </button>
        {:else}
          <div class="none">{i18n.t("ftp.none")}</div>
        {/each}
      </div>
      <div class="dlg-actions wrap">
        <button class="btn" onclick={ftpQuick}><i class="ph ph-bolt"></i>{i18n.t("ftp.quick")}</button>
        <button class="btn" onclick={ftpAdd}><i class="ph ph-plus"></i>{i18n.t("ftp.add")}</button>
        <button class="btn" onclick={ftpEdit} disabled={!ftpSites.sites.length}>{i18n.t("ftp.edit")}</button>
        <button class="btn" onclick={ftpDelete} disabled={!ftpSites.sites.length}>{i18n.t("ftp.delete")}</button>
        <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "ftpSite"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title">
        <i class="ph-duotone ph-globe-hemisphere-west"></i>
        {ftpFormMode === "quick" ? i18n.t("ftp.quick") : ftpFormMode === "add" ? i18n.t("ftp.add") : i18n.t("ftp.edit")}
      </div>
      <form class="dlg-body ftp-form" id="ftp-site-form" onsubmit={(e) => { e.preventDefault(); submitFtpForm(); }}>
        {#if ftpFormMode !== "quick"}
          <label class="lbl" for="ftp-f-name">{i18n.t("ftp.name")}</label>
          <input id="ftp-f-name" bind:value={ftpForm.name} spellcheck="false" />
        {/if}
        <label class="lbl" for="ftp-f-host">{i18n.t("ftp.host")}</label>
        <input id="ftp-f-host" bind:value={ftpForm.host} use:autofocus placeholder="ftp.gnu.org" spellcheck="false" />
        <div class="ftp-row2">
          <div>
            <label class="lbl" for="ftp-f-port">{i18n.t("ftp.port")}</label>
            <input id="ftp-f-port" type="number" bind:value={ftpForm.port} min="1" max="65535" />
          </div>
          <div>
            <label class="lbl" for="ftp-f-user">{i18n.t("ftp.user")}</label>
            <input id="ftp-f-user" bind:value={ftpForm.user} spellcheck="false" />
          </div>
        </div>
        <label class="lbl" for="ftp-f-pass">{i18n.t("ftp.password")}</label>
        <input id="ftp-f-pass" type="password" bind:value={ftpForm.password} />
        <div class="fc-hint" style="margin-top:10px">{i18n.t("ftp.hint")}</div>
      </form>
      <div class="dlg-actions">
        <button class="btn" onclick={() => ui.openDialog("ftp")}>{i18n.t("common.cancel")}</button>
        <button class="btn primary" type="submit" form="ftp-site-form">
          {ftpFormMode === "quick" ? i18n.t("ftp.connect") : i18n.t("ftp.saveConnect")}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "search"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title"><i class="ph-duotone ph-magnifying-glass"></i>{i18n.t("search.title")}</div>
      <form class="dlg-body ftp-form" id="search-form" onsubmit={(e) => { e.preventDefault(); submitSearch(); }}>
        <label class="lbl" for="sr-f-root">{i18n.t("search.root")}</label>
        <input id="sr-f-root" bind:value={searchForm.root} spellcheck="false" style="width:100%" />
        <label class="lbl" for="sr-f-mask">{i18n.t("search.mask")}</label>
        <input id="sr-f-mask" bind:value={searchForm.mask} use:focusSelect placeholder="*" spellcheck="false" style="width:100%" />
        <label class="lbl check"><input type="checkbox" bind:checked={searchForm.useRegex} />{i18n.t("search.useRegex")}</label>
        <label class="lbl" for="sr-f-text">{i18n.t("search.text")}</label>
        <input id="sr-f-text" bind:value={searchForm.text} spellcheck="false" style="width:100%" />
        <label class="lbl check"><input type="checkbox" bind:checked={searchForm.textCase} />{i18n.t("search.textCase")}</label>
        <div class="ftp-row2">
          <div>
            <label class="lbl" for="sr-f-dfrom">{i18n.t("search.dateFrom")}</label>
            <input id="sr-f-dfrom" type="date" bind:value={searchForm.dateFrom} />
          </div>
          <div>
            <label class="lbl" for="sr-f-dto">{i18n.t("search.dateTo")}</label>
            <input id="sr-f-dto" type="date" bind:value={searchForm.dateTo} />
          </div>
        </div>
        <div class="ftp-row2">
          <div>
            <label class="lbl" for="sr-f-sfrom">{i18n.t("search.sizeFrom")}</label>
            <input id="sr-f-sfrom" placeholder="10k" bind:value={searchForm.sizeFrom} spellcheck="false" />
          </div>
          <div>
            <label class="lbl" for="sr-f-sto">{i18n.t("search.sizeTo")}</label>
            <input id="sr-f-sto" placeholder="1g" bind:value={searchForm.sizeTo} spellcheck="false" />
          </div>
        </div>
        <label class="lbl check"><input type="checkbox" bind:checked={searchForm.findDirs} />{i18n.t("search.findDirs")}</label>
      </form>
      <div class="dlg-actions">
        <button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.cancel")}</button>
        <button class="btn primary" type="submit" form="search-form">{i18n.t("search.find")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "windowList"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title"><i class="ph-duotone ph-squares-four"></i>F12</div>
      <div class="dlg-body list">
        <button
          class="li"
          class:kbd={listIdx === 0}
          class:on={ui.mode === 'panels' ? true : false}
          onclick={() => { ui.setMode("panels"); ui.closeDialog(); }}
        >
          <i class="ph-duotone ph-squares-four"></i>{i18n.t("windows.panels")}
        </button>
        {#each editor.docs as d, i (d.id)}
          <button
            class="li"
            class:kbd={listIdx === 1 + i}
            class:on={ui.mode === "editor" && editor.activeId === d.id}
            onclick={() => { editor.activate(d.id); ui.closeDialog(); }}
          >
            <i class="ph-duotone ph-note-pencil"></i>{d.name}{#if d.dirty} •{/if}
          </button>
        {/each}
        {#each editor.viewDocs as d, i (d.id)}
          <button
            class="li"
            class:kbd={listIdx === 1 + editor.docs.length + i}
            class:on={ui.mode === "viewer" && editor.activeViewId === d.id}
            onclick={() => { editor.activate(d.id); ui.closeDialog(); }}
          >
            <i class="ph-duotone ph-eye"></i>{d.name}
          </button>
        {/each}
        {#if !editor.docs.length && !editor.viewDocs.length}
          <div class="none">{i18n.t("windows.none")}</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "dirHistory"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title"><i class="ph-duotone ph-clock-counter-clockwise"></i>{i18n.t("history.dirs")}</div>
      <div class="dlg-body list">
        {#each panels.dirHistory as p, i (p)}
          <button
            class="li mono"
            class:kbd={listIdx === i}
            onclick={() => { void panels.active.chdir(p); ui.closeDialog(); }}
          >
            <i class="ph-duotone ph-folder-simple"></i>{p}
          </button>
        {:else}
          <div class="none">{i18n.t("common.none")}</div>
        {/each}
      </div>
      <div class="dlg-actions"><button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button></div>
    </div>
  </div>
{/if}

{#if ui.dialog === "cmdHistory"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title"><i class="ph-duotone ph-terminal-window"></i>{i18n.t("history.cmds")}</div>
      <div class="dlg-body list">
        {#each cmdline.history as c, i (c)}
          <button
            class="li mono"
            class:kbd={listIdx === i}
            onclick={() => { cmdline.setText(c); ui.closeDialog(); }}
          >
            <i class="ph-duotone ph-terminal-window"></i>{c}
          </button>
        {:else}
          <div class="none">{i18n.t("common.none")}</div>
        {/each}
      </div>
      <div class="dlg-actions"><button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button></div>
    </div>
  </div>
{/if}

{#if ui.dialog === "viewHist"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title"><i class="ph-duotone ph-eye"></i>{i18n.t("history.views")}</div>
      <div class="dlg-body list">
        {#each editor.viewHistory as p, i (p)}
          <button
            class="li"
            class:kbd={listIdx === i}
            onclick={() => { void editor.view(p); ui.closeDialog(); }}
          >
            <i class="ph-duotone ph-file-text"></i>
            <span class="vh-name">{basename(p)}</span>
            <span class="vh-dir mono">{parentOf(p)}</span>
          </button>
        {:else}
          <div class="none">{i18n.t("common.none")}</div>
        {/each}
      </div>
      <div class="dlg-actions"><button class="btn" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button></div>
    </div>
  </div>
{/if}

{#if ui.dialog === "userMenu"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title"><i class="ph-duotone ph-list-checks"></i>{i18n.t("fkeys.f2")}</div>
      <div class="dlg-body list">
        {#each userMenu.items as it, i (it.id)}
          <button
            class="li"
            class:kbd={listIdx === i}
            onclick={() => execUserMenuItem(it)}
          >
            <i class="ph-duotone ph-terminal-window"></i>
            <span class="um-title">{it.title}</span>
            <span class="um-cmd mono">{it.command}</span>
          </button>
        {:else}
          <div class="none">{i18n.t("umenu.empty")}</div>
        {/each}
      </div>
      <div class="dlg-actions wrap">
        <button class="btn" onclick={umAdd}><i class="ph ph-plus"></i>{i18n.t("umenu.add")}</button>
        <button class="btn" onclick={umEdit} disabled={!userMenu.items.length}>{i18n.t("umenu.edit")}</button>
        <button class="btn" onclick={() => void umDelete()} disabled={!userMenu.items.length}>{i18n.t("umenu.delete")}</button>
        <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "userMenuItem"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title">
        <i class="ph-duotone ph-list-checks"></i>
        {umFormMode === "add" ? i18n.t("umenu.add") : i18n.t("umenu.edit")}
      </div>
      <form class="dlg-body ftp-form" id="um-item-form" onsubmit={(e) => { e.preventDefault(); submitUmForm(); }}>
        <label class="lbl" for="um-f-title">{i18n.t("umenu.name")}</label>
        <input id="um-f-title" bind:value={umTitle} use:autofocus spellcheck="false" />
        <label class="lbl" for="um-f-cmd">{i18n.t("umenu.command")}</label>
        <input id="um-f-cmd" bind:value={umCommand} spellcheck="false" style="width:100%" />
        <div class="fc-hint" style="margin-top:10px">{i18n.t("umenu.hint")}</div>
      </form>
      <div class="dlg-actions">
        <button class="btn" onclick={() => ui.openDialog("userMenu")}>{i18n.t("common.cancel")}</button>
        <button class="btn primary" type="submit" form="um-item-form" disabled={!umCommand.trim()}>
          {i18n.t("umenu.save")}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "multiRename" && ui.multiRenameReq}
  <div class="overlay">
    <div class="dlg dlg-mr">
      <div class="dlg-title">
        <i class="ph-duotone ph-text-aa"></i>
        {i18n.t("mr.title")} · {i18n.t("mr.nItems", { n: ui.multiRenameReq.targets.length })}
      </div>
      <form class="dlg-body ftp-form" id="mr-form" onsubmit={(e) => { e.preventDefault(); submitMultiRename(); }}>
        <label class="lbl" for="mr-f-mask">{i18n.t("mr.mask")}</label>
        <input id="mr-f-mask" bind:value={mrForm.mask} use:focusSelect spellcheck="false" style="width:100%" />
        <div class="ftp-row2">
          <div>
            <label class="lbl" for="mr-f-find">{i18n.t("mr.find")}</label>
            <input id="mr-f-find" bind:value={mrForm.find} spellcheck="false" />
          </div>
          <div>
            <label class="lbl" for="mr-f-repl">{i18n.t("mr.replace")}</label>
            <input id="mr-f-repl" bind:value={mrForm.replace} spellcheck="false" />
          </div>
        </div>
        <label class="lbl check"><input type="checkbox" bind:checked={mrForm.caseSensitive} />{i18n.t("mr.case")}</label>
        <div class="ftp-row2">
          <div>
            <label class="lbl" for="mr-f-name">{i18n.t("mr.nameTmpl")}</label>
            <input id="mr-f-name" bind:value={mrForm.nameTmpl} spellcheck="false" />
          </div>
          <div>
            <label class="lbl" for="mr-f-ext">{i18n.t("mr.extTmpl")}</label>
            <input id="mr-f-ext" bind:value={mrForm.extTmpl} spellcheck="false" />
          </div>
        </div>
        <div class="ftp-row2">
          <div>
            <label class="lbl" for="mr-f-cs">{i18n.t("mr.countStart")}</label>
            <input id="mr-f-cs" type="number" bind:value={mrForm.countStart} />
          </div>
          <div>
            <label class="lbl" for="mr-f-ct">{i18n.t("mr.countStep")}</label>
            <input id="mr-f-ct" type="number" bind:value={mrForm.countStep} />
          </div>
          <div>
            <label class="lbl" for="mr-f-cd">{i18n.t("mr.countDigits")}</label>
            <input id="mr-f-cd" type="number" bind:value={mrForm.countDigits} min="1" max="10" />
          </div>
        </div>
        <div class="fc-hint">{i18n.t("mr.phHint")}</div>
        <div class="mr-preview">
          {#each mrRows.slice(0, MR_PREVIEW_MAX) as r}
            <div
              class="mr-row"
              class:dim={r.status === "unchanged"}
              class:bad={r.status === "invalid" || r.status === "dup" || mrConflicts.has(r.newName.toLowerCase())}
            >
              <span class="mono">{r.oldName}</span>
              <span class="mr-arrow">→</span>
              <span class="mono">{r.newName}</span>
              <span class="mr-note">
                {#if r.status === "invalid"}{i18n.t("mr.invalid")}
                {:else if r.status === "dup"}{i18n.t("mr.dup")}
                {:else if mrConflicts.has(r.newName.toLowerCase())}{i18n.t("mr.conflict")}
                {:else if r.status === "unchanged"}{i18n.t("mr.unchanged")}{/if}
              </span>
            </div>
          {/each}
          {#if mrRows.length > MR_PREVIEW_MAX}
            <div class="mr-more">{i18n.t("mr.more", { n: mrRows.length - MR_PREVIEW_MAX })}</div>
          {/if}
          {#if !mrRows.length}
            <div class="none">{i18n.t("mr.nothing")}</div>
          {/if}
        </div>
      </form>
      <div class="dlg-actions">
        <button class="btn" onclick={closeMultiRename}>{i18n.t("common.cancel")}</button>
        <button class="btn primary" type="submit" form="mr-form" disabled={mrBlocked}>
          {i18n.t("mr.apply", { n: mrOkCount })}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "plugins"}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title"><i class="ph-duotone ph-puzzle-piece"></i>{i18n.t("fkeys.f11")}</div>
      <div class="dlg-body list">
        {#if pluginSel === null}
          {#each EDITOR_PLUGINS as p, i (p.id)}
            <button
              class="li"
              class:kbd={listIdx === i}
              onclick={() => { pluginSel = p.id; listIdx = 0; }}
            >
              <i class="ph-duotone {p.icon}"></i>{i18n.t(p.titleKey)}
            </button>
          {/each}
        {:else}
          {#each pluginModes() as m, i (m.id)}
            <button
              class="li"
              class:kbd={listIdx === i}
              onclick={() => pluginSel && applyPluginMode(pluginSel, m.id)}
            >
              <i class="ph-duotone {pluginIcon()}"></i>{i18n.t(m.labelKey)}
            </button>
          {/each}
        {/if}
      </div>
      <div class="dlg-actions">
        {#if pluginSel !== null}
          <button class="btn" onclick={() => { pluginSel = null; listIdx = 0; }}>
            <i class="ph ph-arrow-left"></i>{i18n.t("plug.back")}
          </button>
        {/if}
        <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "menu"}
  <div class="overlay">
    <div class="dlg" style="min-width:340px">
      <div class="dlg-title"><i class="ph-duotone ph-list"></i>{i18n.t("fkeys.f9")}</div>
      <div class="dlg-body">
        <div class="grp">{i18n.t("menu.view")}</div>
        <div class="checks">
          <label class="check">
            <input
              type="checkbox"
              checked={settings.s.dirsFirst}
              onchange={(e) => setViewFlag({ dirsFirst: e.currentTarget.checked })}
            />
            <span>{i18n.t("menu.dirsFirst")}</span>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={settings.s.markedFirst}
              onchange={(e) => setViewFlag({ markedFirst: e.currentTarget.checked })}
            />
            <span>{i18n.t("menu.markedFirst")}</span>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={settings.s.showHidden}
              onchange={(e) => setViewFlag({ showHidden: e.currentTarget.checked })}
            />
            <span>{i18n.t("menu.showHidden")}</span>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={settings.s.showSystem}
              onchange={(e) => setViewFlag({ showSystem: e.currentTarget.checked })}
            />
            <span>{i18n.t("menu.showSystem")}</span>
          </label>
        </div>
        <button class="btn fc-open" onclick={() => ui.openDialog("fileColors")}>
          <i class="ph-duotone ph-palette"></i>{i18n.t("menu.fileColors")}
        </button>

        <div class="grp">{i18n.t("menu.fontSize")}</div>
        <div class="fs-row">
          <button class="btn fs-btn" title={i18n.t("menu.fontSize") + " −"} onclick={() => stepFont(-0.5)} disabled={settings.s.fontSize <= 10}>
            <i class="ph ph-minus"></i>
          </button>
          <span class="fs-val mono">{settings.s.fontSize.toFixed(1)} px</span>
          <button class="btn fs-btn" title={i18n.t("menu.fontSize") + " +"} onclick={() => stepFont(0.5)} disabled={settings.s.fontSize >= 24}>
            <i class="ph ph-plus"></i>
          </button>
        </div>

        <div class="grp">{i18n.t("menu.hlColors")}</div>
        <div class="hl-row">
          <label class="hl">
            <input
              type="color"
              value={settings.s.colors.selection ?? "#f97316"}
              title={i18n.t("menu.hlSelection")}
              oninput={(e) => settings.set({ colors: { ...settings.s.colors, selection: e.currentTarget.value } })}
            />
            <span>{i18n.t("menu.hlSelection")}</span>
          </label>
          <label class="hl">
            <input
              type="color"
              value={settings.s.colors.accent ?? "#8ee53f"}
              title={i18n.t("menu.hlAccent")}
              oninput={(e) => settings.set({ colors: { ...settings.s.colors, accent: e.currentTarget.value } })}
            />
            <span>{i18n.t("menu.hlAccent")}</span>
          </label>
          <button
            class="btn hl-reset"
            disabled={!settings.s.colors.selection && !settings.s.colors.accent}
            onclick={() => settings.set({ colors: { selection: null, accent: null } })}
          >
            {i18n.t("fc.reset")}
          </button>
        </div>

        <div class="grp">{i18n.t("menu.editor")}</div>
        <div class="checks">
          <label class="check">
            <input
              type="checkbox"
              checked={settings.s.editorDecor}
              onchange={(e) => setDecor(e.currentTarget.checked)}
            />
            <span>{i18n.t("menu.editorDecor")}</span>
          </label>
        </div>
        <button class="btn fc-open" onclick={() => ui.openDialog("textColors")}>
          <i class="ph-duotone ph-text-aa"></i>{i18n.t("menu.textRules")}
        </button>

        <div class="grp">{i18n.t("menu.themes")}</div>
        <div class="theme-grid">
          {#each THEMES as th (th.id)}
            <button
              class="btn thmb"
              class:on={settings.s.theme === th.id}
              onclick={() => settings.set({ theme: th.id as ThemeId })}
            >
              <span class="swatch" data-theme={th.id}></span>
              {i18n.t("theme." + th.id)}
            </button>
          {/each}
        </div>

        <div class="grp">{i18n.t("menu.language")}</div>
        <div class="lang-grid">
          {#each LOCALES as l (l.id)}
            <button class="btn lang" class:on={settings.s.locale === l.id} onclick={() => settings.set({ locale: l.id as Locale })}>
              {l.label}
            </button>
          {/each}
        </div>

        {#if appVer}
          <div class="about mono">
            {i18n.t("menu.about")} — v{appVer.version}
            <span class="dim">· {appVer.buildTime}</span>
          </div>
        {/if}
      </div>
      <div class="dlg-actions">
        <button class="btn" onclick={() => { void import("$lib/commands").then(({runCommand}) => runCommand("app.quit")); }}>
          <i class="ph ph-sign-out"></i>{i18n.t("menu.quit")}
        </button>
        <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "help"}
  <div class="overlay">
    <div class="dlg help-dlg">
      <div class="dlg-title"><i class="ph-duotone ph-question"></i>{i18n.t("fkeys.f1")}</div>
      <div class="dlg-body help-body">
        {#each HELP_SECTIONS as s}
          <div class="grp">{i18n.t(s.title)}</div>
          <div class="help-grid">
            {#each s.items as it}
              <div class="hrow">
                {#if it.chord}<kbd>{it.chord}</kbd>{:else}<span class="nokbd"></span>{/if}
                <span class="hdesc">{i18n.t(it.key)}</span>
              </div>
            {/each}
          </div>
        {/each}
      </div>
      <div class="dlg-actions">
        <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "fileColors"}
  <div class="overlay">
    <div class="dlg" style="min-width: 500px">
      <div class="dlg-title"><i class="ph-duotone ph-palette"></i>{i18n.t("menu.fileColors")}</div>
      <div class="dlg-body">
        <div class="fc-hint">{i18n.t("fc.hint")}</div>
        <div class="fc-rows">
          {#each fileColors.rules as r (r.id)}
            <div class="fc-row">
              <input
                type="color"
                value={r.color}
                title={r.color}
                oninput={(e) => fileColors.update(r.id, { color: e.currentTarget.value })}
              />
              <input
                class="fc-mask"
                type="text"
                value={r.mask}
                spellcheck="false"
                oninput={(e) => fileColors.update(r.id, { mask: e.currentTarget.value })}
              />
              <label class="fc-bold" title={i18n.t("fc.bold")}>
                <input
                  type="checkbox"
                  checked={!!r.bold}
                  onchange={(e) => fileColors.update(r.id, { bold: e.currentTarget.checked })}
                />
                <b>B</b>
              </label>
              <span
                class="fc-sample"
                style="color:{r.color};font-weight:{r.bold ? 800 : 400}"
                >{sampleOf(r.mask)}</span>
              <button class="fc-del" title={i18n.t("fc.remove")} onclick={() => fileColors.remove(r.id)}>
                <i class="ph ph-x"></i>
              </button>
            </div>
          {/each}
        </div>
      </div>
      <div class="dlg-actions wrap">
        <button class="btn" onclick={() => fileColors.add()}><i class="ph ph-plus"></i>{i18n.t("fc.add")}</button>
        <button class="btn" onclick={() => fileColors.reset()}>{i18n.t("fc.reset")}</button>
        <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "textColors"}
  <div class="overlay">
    <div class="dlg" style="min-width: 560px">
      <div class="dlg-title"><i class="ph-duotone ph-text-aa"></i>{i18n.t("menu.textRules")}</div>
      <div class="dlg-body">
        <div class="fc-hint">{i18n.t("tr.hint")}</div>
        <div class="fc-rows">
          <div class="fc-row">
            <input
              type="checkbox"
              checked={textColors.s.dates.on}
              onchange={(e) => trBuiltin("dates", { on: e.currentTarget.checked })}
            />
            <span class="tr-name">{i18n.t("tr.dates")}</span>
            <input
              type="color"
              value={textColors.s.dates.color ?? cmVar("--cm-date")}
              title={textColors.s.dates.color ?? i18n.t("tr.themeColor")}
              oninput={(e) => trBuiltin("dates", { color: e.currentTarget.value })}
            />
            <label class="fc-bold" title={i18n.t("fc.bold")}>
              <input
                type="checkbox"
                checked={!!textColors.s.dates.bold}
                onchange={(e) => trBuiltin("dates", { bold: e.currentTarget.checked })}
              />
              <b>B</b>
            </label>
            <button
              class="fc-del"
              title={i18n.t("tr.themeColor")}
              disabled={!textColors.s.dates.color}
              onclick={() => trBuiltin("dates", { color: null })}
            >
              <i class="ph ph-arrow-counter-clockwise"></i>
            </button>
          </div>
          <div class="fc-row">
            <input
              type="checkbox"
              checked={textColors.s.special.on}
              onchange={(e) => trBuiltin("special", { on: e.currentTarget.checked })}
            />
            <span class="tr-name">{i18n.t("tr.special")}</span>
            <input
              type="color"
              value={textColors.s.special.color ?? cmVar("--cm-special")}
              title={textColors.s.special.color ?? i18n.t("tr.themeColor")}
              oninput={(e) => trBuiltin("special", { color: e.currentTarget.value })}
            />
            <label class="fc-bold" title={i18n.t("fc.bold")}>
              <input
                type="checkbox"
                checked={!!textColors.s.special.bold}
                onchange={(e) => trBuiltin("special", { bold: e.currentTarget.checked })}
              />
              <b>B</b>
            </label>
            <button
              class="fc-del"
              title={i18n.t("tr.themeColor")}
              disabled={!textColors.s.special.color}
              onclick={() => trBuiltin("special", { color: null })}
            >
              <i class="ph ph-arrow-counter-clockwise"></i>
            </button>
          </div>
          {#each textColors.s.masks as r (r.id)}
            <div class="fc-row">
              <input
                type="color"
                value={r.color}
                title={r.color}
                oninput={(e) => trMask(r.id, { color: e.currentTarget.value })}
              />
              <input
                class="fc-mask"
                type="text"
                value={r.mask}
                spellcheck="false"
                placeholder={i18n.t("tr.maskPh")}
                oninput={(e) => trMask(r.id, { mask: e.currentTarget.value })}
              />
              <label class="fc-bold" title={i18n.t("fc.bold")}>
                <input
                  type="checkbox"
                  checked={!!r.bold}
                  onchange={(e) => trMask(r.id, { bold: e.currentTarget.checked })}
                />
                <b>B</b>
              </label>
              <span
                class="fc-sample"
                style="color:{r.color};font-weight:{r.bold ? 800 : 400}"
                >{sampleOf(r.mask) || "*"}</span>
              <button class="fc-del" title={i18n.t("fc.remove")} onclick={() => trRemove(r.id)}>
                <i class="ph ph-x"></i>
              </button>
            </div>
          {/each}
        </div>
      </div>
      <div class="dlg-actions wrap">
        <button class="btn" onclick={() => textColors.addMask()}><i class="ph ph-plus"></i>{i18n.t("fc.add")}</button>
        <button class="btn" onclick={() => trReset()}>{i18n.t("fc.reset")}</button>
        <button class="btn primary" onclick={() => ui.closeDialog()}>{i18n.t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}

{#if ui.dialog === "errors" && ui.errorText}
  <div class="overlay">
    <div class="dlg">
      <div class="dlg-title err-t"><i class="ph-duotone ph-warning-octagon"></i>{i18n.t("errors.access")}</div>
      <div class="dlg-body mono err-body">{ui.errorText}</div>
      <div class="dlg-actions">
        <button class="btn primary" use:autofocus onclick={() => { ui.errorText = null; ui.closeDialog(); }}>{i18n.t("common.close")}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .lbl { display: block; color: var(--fg-dim); margin-bottom: 6px; font-size: calc(12.5px * var(--fs-scale)); }

  .scan { color: var(--fg-dim); padding: 8px 0; }

  .bar {
    height: 12px;
    border-radius: 6px;
    background: var(--bg);
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 55%, var(--accent2)));
    transition: width 0.15s;
  }
  .prow { display: flex; gap: 14px; margin-top: 7px; font-size: calc(12px * var(--fs-scale)); color: var(--fg-dim); }
  .pfiles { font-size: calc(11.5px * var(--fs-scale)); color: var(--fg-muted); margin-top: 2px; }
  .cur {
    margin-top: 8px;
    font-size: calc(11.5px * var(--fs-scale));
    color: var(--fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: ltr;
    font-family: "JetBrains Mono", monospace;
  }
  .badge {
    margin-inline-start: auto;
    font-size: calc(11px * var(--fs-scale));
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--row-hover);
    color: var(--fg-dim);
  }
  .badge.ok { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .badge.err { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
  .errs { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
  .err { font-size: calc(11.5px * var(--fs-scale)); color: var(--danger); word-break: break-all; }

  .dlg-title.warn { color: var(--accent2); }
  .dlg-title.err-t { color: var(--danger); }
  .conf-row { display: flex; gap: 10px; margin-bottom: 8px; font-size: calc(12px * var(--fs-scale)); align-items: baseline; }
  .conf-row .lbl { margin: 0; min-width: 90px; color: var(--fg-dim); }
  .conf-row .path { word-break: break-all; direction: ltr; }
  .dlg-actions.wrap { flex-wrap: wrap; justify-content: center; }

  .drives { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px; }
  .drive {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 12px;
    border-radius: 9px;
    border: 1px solid var(--border);
    background: var(--bg);
    text-align: start;
  }
  .drive:hover { border-color: var(--accent); }
  .drive i { font-size: calc(22px * var(--fs-scale)); color: var(--accent); }
  .drive.kbd {
    border-color: var(--accent2);
    background: color-mix(in srgb, var(--accent2) 10%, var(--bg-panel));
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent2) 55%, transparent);
  }
  .d-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .d-free { font-size: calc(10.5px * var(--fs-scale)); color: var(--fg-muted); }

  /* FTP sites dialog + connect form */
  .ftp-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
  .ftp-addr { font-size: calc(10.5px * var(--fs-scale)); color: var(--fg-muted); }
  .ftp-form { min-width: 360px; }
  .ftp-form input {
    width: 100%;
    padding: 5px 10px;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: var(--bg-panel);
    color: var(--fg);
    font-size: calc(12.5px * var(--fs-scale));
    direction: ltr;
  }
  .ftp-row2 { display: grid; grid-template-columns: 1fr 2fr; gap: 10px; margin-bottom: 8px; }
  .ftp-row2 .lbl { margin-bottom: 4px; }

  .list { display: flex; flex-direction: column; gap: 2px; min-width: 380px; }
  .li {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 10px;
    border-radius: 7px;
    color: var(--fg-dim);
    text-align: start;
    font-size: calc(12.5px * var(--fs-scale));
  }
  .li:hover { background: var(--row-hover); color: var(--fg); }
  .li.on { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--fg); }
  .li i { font-size: calc(17px * var(--fs-scale)); color: var(--accent); }
  .li.kbd {
    background: color-mix(in srgb, var(--accent2) 10%, transparent);
    color: var(--fg);
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent2) 55%, transparent);
  }
  .none { color: var(--fg-muted); text-align: center; padding: 14px; }

  /* Alt+F11 view history rows: file name + its directory */
  .vh-name { color: var(--fg); flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vh-dir { font-size: calc(10.5px * var(--fs-scale)); color: var(--fg-muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: end; }

  /* F2 user-menu rows: title + the command it runs */
  .um-title { color: var(--fg); flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .um-cmd { font-size: calc(10.5px * var(--fs-scale)); color: var(--fg-muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: end; }

  /* Ctrl+M multi-rename dialog */
  .dlg-mr { min-width: 540px; max-width: 700px; }
  .mr-preview {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 10px;
    max-height: 230px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 8px;
  }
  .mr-row { display: flex; gap: 8px; align-items: baseline; font-size: calc(12px * var(--fs-scale)); color: var(--fg); }
  .mr-row .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1; min-width: 0; }
  .mr-arrow { color: var(--fg-muted); flex-shrink: 0; }
  .mr-note { color: var(--accent2); font-size: calc(10.5px * var(--fs-scale)); margin-inline-start: auto; flex-shrink: 0; }
  .mr-row.dim { opacity: 0.45; }
  .mr-row.bad { color: var(--danger); }
  .mr-row.bad .mr-note { color: var(--danger); }
  .mr-more { color: var(--fg-muted); font-size: calc(11px * var(--fs-scale)); padding: 3px 2px; }

  /* F5/F6 destination variants under the transfer dialog input */
  .variants { display: flex; flex-direction: column; gap: 2px; margin-top: 10px; max-height: 200px; overflow-y: auto; }
  .variants .li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }

  .grp { color: var(--fg-muted); font-size: calc(11.5px * var(--fs-scale)); text-transform: uppercase; letter-spacing: 0.6px; margin: 12px 0 8px; }
  .grp:first-child { margin-top: 0; }
  .theme-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .lang-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
  .thmb, .lang { justify-content: flex-start; padding: 7px 10px; font-size: calc(12.5px * var(--fs-scale)); }
  .thmb.on, .lang.on { border-color: var(--accent); color: var(--fg); }

  /* menu: view settings checkboxes */
  .checks { display: flex; flex-direction: column; gap: 7px; }
  .check { display: flex; align-items: center; gap: 9px; font-size: calc(12.5px * var(--fs-scale)); color: var(--fg-dim); cursor: pointer; }
  .check:hover { color: var(--fg); }
  .check input { width: 15px; height: 15px; accent-color: var(--accent); flex-shrink: 0; }
  .fc-open { width: 100%; justify-content: flex-start; margin-top: 8px; font-size: calc(12.5px * var(--fs-scale)); }
  .fc-open i { font-size: calc(16px * var(--fs-scale)); color: var(--accent2); }

  /* menu: font-size stepper */
  .fs-row { display: flex; align-items: center; gap: 10px; }
  .fs-btn { width: 34px; height: 30px; padding: 0; justify-content: center; }
  .fs-val { min-width: 64px; text-align: center; color: var(--fg); font-size: calc(12.5px * var(--fs-scale)); }

  /* menu: highlight color overrides — swatch + label rows, fc color input style */
  .hl-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .hl { display: flex; align-items: center; gap: 8px; font-size: calc(12.5px * var(--fs-scale)); color: var(--fg-dim); cursor: pointer; }
  .hl:hover { color: var(--fg); }
  .hl input[type="color"] {
    width: 36px; height: 26px; padding: 0; border: 1px solid var(--border);
    border-radius: var(--r-btn); background: var(--bg-elev); cursor: pointer;
  }
  .hl input[type="color"]::-webkit-color-swatch-wrapper { padding: 2px; }
  .hl input[type="color"]::-webkit-color-swatch { border: none; border-radius: 5px; }
  .hl-reset { padding: 5px 10px; font-size: calc(12px * var(--fs-scale)); }

  /* help dialog */
  .help-dlg { min-width: 660px; max-width: 940px; }
  .help-body { overflow-y: auto; }
  .help-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px 22px; }
  .hrow { display: flex; align-items: baseline; gap: 9px; font-size: calc(12px * var(--fs-scale)); color: var(--fg-dim); min-width: 0; }
  .hrow kbd {
    flex-shrink: 0;
    min-width: 92px;
    align-self: center;
    padding: 1px 7px;
    border-radius: 6px;
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    background: var(--bg-panel);
    color: var(--fg);
    font-family: "JetBrains Mono", monospace;
    font-size: calc(11px * var(--fs-scale));
    text-align: center;
    white-space: nowrap;
    direction: ltr;
  }
  .hrow .nokbd { display: none; }
  .hdesc { min-width: 0; }
  .hrow:has(.nokbd) .hdesc { color: var(--fg); }

  /* file colors dialog */
  .fc-hint { font-size: calc(11.5px * var(--fs-scale)); color: var(--fg-muted); margin-bottom: 10px; }
  .fc-rows { display: flex; flex-direction: column; gap: 6px; max-height: 46vh; overflow-y: auto; }
  .fc-row { display: flex; align-items: center; gap: 8px; }
  .fc-row input[type="color"] {
    width: 36px;
    height: 26px;
    padding: 1px 2px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg-panel);
    cursor: pointer;
    flex-shrink: 0;
  }
  .fc-mask {
    flex: 1;
    min-width: 0;
    padding: 4px 10px;
    font-family: "JetBrains Mono", monospace;
    font-size: calc(12px * var(--fs-scale));
    border-radius: 7px;
    direction: ltr;
  }
  .fc-sample {
    flex-shrink: 0;
    width: 110px;
    font-size: calc(12px * var(--fs-scale));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: ltr;
  }
  .fc-bold {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    color: var(--fg-dim);
  }
  .fc-bold input { width: 14px; height: 14px; accent-color: var(--accent); }
  .fc-bold b { font-size: calc(12.5px * var(--fs-scale)); }
  .fc-del { flex-shrink: 0; padding: 4px 8px; border-radius: 7px; color: var(--fg-muted); font-size: calc(13px * var(--fs-scale)); }
  .fc-del:hover { color: var(--danger); background: var(--row-hover); }
  .tr-name { flex: 1; min-width: 0; font-size: calc(12.5px * var(--fs-scale)); }

  .about {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    font-size: calc(11px * var(--fs-scale));
    color: var(--fg-dim);
  }
  .about .dim { color: var(--fg-muted); }
  .swatch {
    width: 16px; height: 16px;
    border-radius: 5px;
    border: 1px solid var(--border-strong);
    background: #141619;
  }
  .swatch[data-theme="alnaviLight"] { background: #f4f5f7; }
  .swatch[data-theme="midnight"] { background: #0b1220; }
  .swatch[data-theme="solarized"] { background: #fdf6e3; }
  .swatch[data-theme="contrast"] { background: #000; }

  .err-body { white-space: pre-wrap; word-break: break-all; font-size: calc(12px * var(--fs-scale)); }
</style>
