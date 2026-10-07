import { registerCommand } from "$lib/commands";
import {
  mkdir,
  setAttributes,
  renamePath,
  homePath,
  pathExists,
  loadJson,
  saveJson,
} from "$lib/api";
import { joinPath, sortArrow, parentOf, pathKey, basename } from "$lib/format";
import {
  remoteAuthority,
  ftpRootOf,
  isRemotePath,
  remoteList,
  remoteConnect,
  remoteMkdir,
  remoteRename,
} from "$lib/ftp";
import { isArchivePath, isArchiveFile, splitArchiveUrl, joinArchivePath, PACK_FORMATS } from "$lib/archive";
import { panels } from "$lib/stores/panels.svelte";
import { ui, type AttrState } from "$lib/stores/ui.svelte";
import { editor } from "$lib/stores/editor.svelte";
import { ops } from "$lib/stores/ops.svelte";
import { i18n } from "$lib/stores/i18n.svelte";
import { settings } from "$lib/stores/settings.svelte";
import { cmdline } from "$lib/stores/cmdline.svelte";
import { ftpSites } from "$lib/stores/ftpSites.svelte";
import { isSearchPath, searchStore } from "$lib/stores/search.svelte";
import type { FileEntry } from "$lib/types";

/** real path of a panel entry — search results carry their own full path,
 *  archive members get a proper archive:// url */
const entryPath = (p: { path: string }, e: FileEntry): string =>
  e.fullPath ?? (isArchivePath(p.path) ? joinArchivePath(p.path, e.name) : joinPath(p.path, e.name));

export function registerAllCommands() {
  const A = () => panels.active;

  // ---------- panels ----------
  registerCommand("panel.switchActive", () => panels.switchActive());
  registerCommand("panel.drivesLeft", () => {
    ui.drivesFor = "left";
    ui.openDialog("drives");
  });
  registerCommand("panel.drivesRight", () => {
    ui.drivesFor = "right";
    ui.openDialog("drives");
  });
  registerCommand("panel.toggleLeft", () => panels.toggleSide("left"));
  registerCommand("panel.toggleRight", () => panels.toggleSide("right"));
  registerCommand("panel.toggleBoth", () => panels.toggleBoth());
  registerCommand("panel.showBoth", () => panels.showBoth());
  registerCommand("panel.swap", () => panels.swap());
  // Ctrl+Left/Right slide the split between the panels (FAR-style resize);
  // routed in App.svelte before the keymap so the cmdline keeps word jumps
  registerCommand("panel.splitLeft", () => panels.moveSplit(-1));
  registerCommand("panel.splitRight", () => panels.moveSplit(1));
  registerCommand("panel.enter", () => void A().enter());
  registerCommand("panel.intoDir", () => void A().intoDir());
  registerCommand("panel.up", () => void A().up());
  registerCommand("panel.root", () => void A().root());
  registerCommand("panel.refresh", () => A().refresh());
  registerCommand("panel.toggleHidden", () => {
    // global setting: both panels rebuild and it persists
    settings.set({ showHidden: !settings.s.showHidden });
    panels.refreshView();
  });
  registerCommand("panel.escape", () => {
    // Esc on a running search cancels it first (FAR find-list behavior)
    if (searchStore.cancel()) return;
    const p = A();
    if (p.quickJumpPrefix !== null) {
      p.clearQuickJump();
    } else {
      p.clearSelection();
    }
  });
  registerCommand("panel.selectCursor", () => A().toggleAt(A().cursor));
  registerCommand("panel.selectGroup", async () => {
    const mask = await ui.askInput(i18n.t("panel.quickSearch"), i18n.t("common.name"), "*");
    if (mask === null) return;
    A().selectByMask(mask || "*", true);
  });
  registerCommand("panel.deselectGroup", async () => {
    const mask = await ui.askInput(i18n.t("panel.quickSearch"), i18n.t("common.name"), "*");
    if (mask === null) return;
    A().selectByMask(mask || "*", false);
  });
  registerCommand("panel.invertSelection", () => A().invertSelection());
  registerCommand("panel.sortName", () => setSort("name"));
  registerCommand("panel.sortExt", () => setSort("ext"));
  registerCommand("panel.sortMtime", () => setSort("mtime"));
  registerCommand("panel.sortSize", () => setSort("size"));
  registerCommand("panel.sortUnsorted", () => setSort("unsorted"));
  registerCommand("panel.historyBack", () => void A().historyBack());
  registerCommand("panel.historyForward", () => void A().historyForward());
  registerCommand("panel.newTab", () => A().newTab());
  registerCommand("panel.closeTab", () => A().closeTab());
  registerCommand("panel.copyNames", () => {
    const names = A()
      .targetEntries.map((e) => e.name)
      .join("\r\n");
    if (names) void navigator.clipboard.writeText(names);
  });
  registerCommand("panel.copyPaths", () => {
    const p = A();
    const paths = p.targetPaths.join("\r\n");
    // cursor on ".." with nothing marked: the entry IS the panel's own
    // directory — copy its path (search panel: where the search started)
    const dirPath =
      !paths && p.current?.name === ".."
        ? (isSearchPath(p.path) ? searchStore.originPath ?? p.path : p.path)
        : "";
    if (paths || dirPath) void navigator.clipboard.writeText(paths || dirPath);
  });
  registerCommand("panel.enterExternal", () => void A().enterExternal());
  registerCommand("panel.dirHistory", () => ui.openDialog("dirHistory"));
  registerCommand("panel.quickJump", (latin) => {
    const l = String(latin ?? "");
    if (l) A().quickJump(l);
  });

  // ---------- viewer ----------
  registerCommand("viewer.open", () => {
    const p = A();
    for (const e of p.targetEntries) {
      void editor.view(entryPath(p, e));
    }
  });
  registerCommand("viewer.toEditor", () => editor.toEditorActive());
  registerCommand("viewer.toggleHex", () => editor.toggleHexActive());
  registerCommand("viewer.close", () => void editor.closeViewer());
  registerCommand("viewer.history", () => ui.openDialog("viewHist"));

  // ---------- editor ----------
  registerCommand("editor.open", () => {
    const p = A();
    const first = p.targetEntries[0];
    if (first) void editor.open(entryPath(p, first));
  });
  registerCommand("editor.newFile", () => {
    const p = A();
    const dir = isSearchPath(p.path) ? searchStore.originPath ?? p.path : p.path;
    void editor.newFile(dir);
  });
  registerCommand("editor.newScratch", () => editor.newScratch());

  // ---------- file operations ----------
  registerCommand("fs.copy", () => startTransfer("copy"));
  registerCommand("fs.copyCurrent", () => startTransfer("copy", true));
  registerCommand("fs.move", () => startTransfer("move"));
  registerCommand("fs.renameCurrent", async () => {
    const p = A();
    const cur = p.current;
    if (!cur || cur.name === "..") return;
    // works on the find list too: the row carries its real full path, the
    // dialog prefills and renames within the file's own directory
    const oldPath = entryPath(p, cur);
    if (isArchivePath(oldPath)) {
      // archive contents are read-only in the VFS (rename needs a repack)
      ui.showToast(i18n.t("archive.readonly"));
      return;
    }
    const oldName = basename(oldPath);
    const dir = parentOf(oldPath) ?? p.path;
    const nn = await ui.askInput(i18n.t("rename.title"), i18n.t("rename.prompt"), oldName);
    if (!nn || nn === oldName) return;
    const newPath = joinPath(dir, nn);
    try {
      if (isRemotePath(oldPath)) {
        // rename only works within one server — a hand-typed foreign
        // target is refused by the backend anyway, say it up front
        if (remoteAuthority(newPath) !== remoteAuthority(oldPath)) {
          ui.showError(i18n.t("ftp.renameSameServer"));
          return;
        }
        await remoteRename(oldPath, newPath);
      } else {
        await renamePath(oldPath, newPath);
      }
      p.refresh();
    } catch (e) {
      ui.showError(String(e));
    }
  });
  registerCommand("fs.mkdir", async () => {
    const p = A();
    if (isSearchPath(p.path)) {
      ui.showError(i18n.t("search.notHere"));
      return;
    }
    if (isArchivePath(p.path)) {
      ui.showToast(i18n.t("archive.readonly"));
      return;
    }
    const name = await ui.askInput(i18n.t("mkdir.title"), i18n.t("mkdir.prompt"), "");
    if (!name) return;
    try {
      if (isRemotePath(p.path)) await remoteMkdir(joinPath(p.path, name));
      else await mkdir(joinPath(p.path, name));
      p.refresh();
      const idx = p.view.findIndex((e) => e.name === name);
      if (idx >= 0) p.cursor = idx;
    } catch (e) {
      ui.showError(String(e));
    }
  });
  registerCommand("fs.attrs", async () => {
    const p = A();
    // search results point at real disk files, so they stay eligible;
    // remote rows and archive members are not paths set_attributes could touch
    const targets = p.targetEntries
      .map((e) => ({ path: entryPath(p, e), attrs: e.attrs }))
      .filter((t) => !isRemotePath(t.path) && !isArchivePath(t.path));
    if (!targets.length) {
      ui.showToast(i18n.t("archive.readonly"));
      return;
    }
    // prefill: every target carries the bit -> set, none -> clear, mixed -> keep
    const init = (ch: string): AttrState =>
      targets.every((t) => t.attrs.includes(ch)) ? "set"
        : targets.every((t) => !t.attrs.includes(ch)) ? "clear"
          : "keep";
    const r = await ui.askAttrs(targets.length, {
      readOnly: init("R"),
      hidden: init("H"),
      system: init("S"),
      archive: init("A"),
    });
    if (!r) return;
    const val = (s: AttrState): boolean | null => (s === "keep" ? null : s === "set");
    if (r.readOnly === "keep" && r.hidden === "keep" && r.system === "keep" && r.archive === "keep") return;
    try {
      await setAttributes(targets.map((t) => t.path), {
        readOnly: val(r.readOnly),
        hidden: val(r.hidden),
        system: val(r.system),
        archive: val(r.archive),
      });
      p.refresh();
    } catch (e) {
      ui.showError(String(e));
    }
  });
  registerCommand("fs.multiRename", () => {
    const p = A();
    // FAR behavior: the marked files, or the whole panel when nothing is
    // marked — the live preview shows every change before anything moves.
    // Search rows stay eligible (each renames in its own directory);
    // remote rows and archive members are not local renames.
    const entries = p.selectedEntries.length ? p.selectedEntries : p.view.filter((e) => e.name !== "..");
    const targets = entries
      .map((e) => entryPath(p, e))
      .filter((path) => !isRemotePath(path) && !isArchivePath(path))
      .map((path) => ({ path, name: basename(path) }));
    if (!targets.length) {
      ui.showToast(i18n.t("mr.localOnly"));
      return;
    }
    void ui.askMultiRename(targets);
  });
  registerCommand("fs.delete", () => startDelete(false, false));
  registerCommand("fs.deleteCurrent", () => startDelete(false, true));
  registerCommand("fs.deletePermanent", () => startDelete(true, false));

  // ---------- archives (M6): Alt+F5 pack, Alt+F6 unpack ----------
  registerCommand("fs.pack", async () => {
    const p = A();
    if (isSearchPath(p.path)) {
      ui.showError(i18n.t("search.notHere"));
      return;
    }
    if (isRemotePath(p.path) || isArchivePath(p.path)) {
      ui.showToast(i18n.t("archive.packLocalOnly"));
      return;
    }
    const entries = p.targetEntries;
    if (!entries.length) return;
    const destDir = isSearchPath(panels.inactive.path)
      ? searchStore.originPath ?? p.path
      : panels.inactive.path;
    if (isRemotePath(destDir) || isArchivePath(destDir)) {
      ui.showToast(i18n.t("archive.packLocalOnly"));
      return;
    }
    // single item -> its stem, several -> the current folder's name (FAR)
    const stem = entries.length === 1
      ? entries[0].name.replace(/\.[^.]+$/, "") || entries[0].name
      : basename(p.path) || "archive";
    const formats = PACK_FORMATS.map((f) => ({ id: f.id, ext: f.ext }));
    const r = await ui.askPack(stem, destDir, formats);
    if (!r) return;
    let name = r.name.trim();
    if (!name) return;
    // drop a typed extension of any pack format — the chosen one is appended
    for (const f of formats) {
      if (name.toLowerCase().endsWith(f.ext)) {
        name = name.slice(0, -f.ext.length);
        break;
      }
    }
    const ext = formats.find((f) => f.id === r.format)?.ext ?? ".zip";
    void ops.startPack(p.targetPaths, joinPath(destDir, name + ext), r.format);
  });

  registerCommand("fs.unpack", async () => {
    const p = A();
    const destBase = isSearchPath(panels.inactive.path)
      ? searchStore.originPath ?? p.path
      : panels.inactive.path;
    if (isRemotePath(destBase) || isArchivePath(destBase)) {
      ui.showToast(i18n.t("archive.extractLocalOnly"));
      return;
    }
    if (isArchivePath(p.path)) {
      // inside an archive: extract the selection to the other panel as-is
      const urls = p.targetPaths;
      if (!urls.length) return;
      void ops.startExtract(urls.map((url) => ({ url, dest: destBase })));
      return;
    }
    if (isSearchPath(p.path)) {
      ui.showError(i18n.t("search.notHere"));
      return;
    }
    // disk panel: unpack the selected archive files (or the one under cursor)
    const archives = p.targetEntries.filter((e) => !e.isDir && isArchiveFile(e.name));
    if (!archives.length) {
      ui.showToast(i18n.t("archive.noArchives"));
      return;
    }
    const variants = await transferVariants(p.path, destBase);
    const r = await ui.askUnpack(destBase, variants, true);
    if (!r) return;
    const items = archives.map((a) => {
      // into a subfolder named after the archive (stem drops the format ext)
      const stem = a.name.replace(/\.(tar\.gz|tgz|zip|tar|7z)$/i, "") || a.name;
      const dest = r.subdir ? joinPath(r.dest, stem) : r.dest;
      return { url: entryPath(p, a), dest };
    });
    void ops.startExtract(items);
  });

  // ---------- folder shortcuts (FAR Ctrl+0..9 / Ctrl+Shift+0..9) ----------
  for (let d = 0; d <= 9; d++) {
    registerCommand(`shortcuts.jump${d}`, async () => {
      const ok = await panels.jumpShortcut(String(d));
      if (!ok) ui.showToast(i18n.t("shortcuts.jumpEmpty", { k: String(d) }));
    });
    registerCommand(`shortcuts.assign${d}`, () => {
      panels.assignShortcut(String(d));
      ui.showToast(i18n.t("shortcuts.assigned", { k: String(d) }));
    });
  }

  // ---------- ui ----------
  // Ctrl+Tab walks a FAR-style window ring: editor docs, then viewer docs, then
  // the panels, and around again (file1 -> file2 -> panels -> file1). With a
  // single document it degenerates into the editor <-> panels toggle; with
  // nothing open it keeps the old meaning of cycling file-panel tabs.
  const stepWindowRing = (dir: 1 | -1) => {
    type RingWin = { mode: "editor" | "viewer"; id: number } | { mode: "panels" };
    const ring: RingWin[] = [
      ...editor.docs.map((d) => ({ mode: "editor" as const, id: d.id })),
      ...editor.viewDocs.map((d) => ({ mode: "viewer" as const, id: d.id })),
    ];
    if (ring.length === 0) {
      A().cycleTab(dir);
      return;
    }
    ring.push({ mode: "panels" });

    let i = ring.findIndex((w) => {
      if (w.mode !== ui.mode) return false;
      if (w.mode === "panels") return true;
      return w.id === (w.mode === "editor" ? editor.activeId : editor.activeViewId);
    });
    if (i < 0) i = ring.length - 1; // unknown position: step from panels

    const next = ring[(i + dir + ring.length) % ring.length];
    if (next.mode === "panels") ui.setMode("panels");
    else if (next.mode === "editor") {
      editor.activeId = next.id;
      ui.setMode("editor");
    } else {
      editor.activeViewId = next.id;
      ui.setMode("viewer");
    }
  };
  registerCommand("ui.nextTab", () => stepWindowRing(1));
  registerCommand("ui.prevTab", () => stepWindowRing(-1));
  registerCommand("ui.windowList", () => ui.openDialog("windowList"));
  registerCommand("ui.menu", () => ui.openDialog("menu"));
  registerCommand("ui.help", () => ui.openDialog("help"));
  registerCommand("ui.plugins", () => ui.openDialog("plugins"));
  // Ctrl+plus/minus zoom the interface font — the same stepper as the F9
  // dialog; the toast echoes the resulting size (no visible stepper here)
  registerCommand("ui.fontInc", () => {
    ui.showToast(`${i18n.t("menu.fontSize")}: ${settings.stepFontSize(0.5).toFixed(1)} px`);
  });
  registerCommand("ui.fontDec", () => {
    ui.showToast(`${i18n.t("menu.fontSize")}: ${settings.stepFontSize(-0.5).toFixed(1)} px`);
  });
  registerCommand("app.quit", async () => {
    if (await ui.askConfirm(i18n.t("menu.quitConfirm"))) {
      panels.saveSession();
      void editor.persistAll();
      // close() raises the close-requested event: its handler (App.svelte)
      // persists the positions again and destroys the window
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      void getCurrentWindow().close();
    }
  });
  registerCommand("dialog.close", () => {
    if (ui.confirmReq) ui.confirmReq.resolve(false);
    else if (ui.inputReq) ui.inputReq.resolve(null);
    else if (ui.packReq) ui.packReq.resolve(null);
    else if (ui.unpackReq) ui.unpackReq.resolve(null);
    else if (ui.attrsReq) ui.attrsReq.resolve(null);
    else if (ui.multiRenameReq) ui.multiRenameReq.resolve();
    else if (ops.conflict) ops.resolveConflictAction("skip");
    else ui.closeDialog();
  });

  // ---------- cmdline ----------
  registerCommand("cmdline.history", () => ui.openDialog("cmdHistory"));
  registerCommand("cmdline.prevHistory", () => {
    cmdline.stepHistory(-1);
  });
  // FAR-style Ctrl+Enter: append the name under the panel cursor to the
  // command line; each further press appends the next entry's name
  registerCommand("cmdline.insertCursorName", () => {
    const p = A();
    let e = p.current;
    if (!e || e.name === "..") {
      e = p.view.find((x) => x.name !== "..") ?? null;
    }
    if (!e) return;
    // quote names a shell would split (spaces, quotes, cmd metacharacters)
    const name = /[\s"&^]/.test(e.name) ? `"${e.name}"` : e.name;
    const base = cmdline.text;
    cmdline.setText((base && !/\s$/.test(base) ? base + " " : base) + name);
    cmdline.histIndex = -1;
    // advance the panel cursor so repeated presses build a list of names
    for (let i = p.cursor + 1; i < p.view.length; i++) {
      if (p.view[i].name !== "..") {
        p.cursor = i;
        break;
      }
    }
  });
  registerCommand("cmdline.pasteClipboard", async () => {
    try {
      const text = await navigator.clipboard.readText();
      cmdline.setText(text.split(/\r?\n/)[0] ?? "");
      cmdline.focusInput();
    } catch {
      /* clipboard unavailable */
    }
  });

  // ---------- editor specifics ----------
  registerCommand("editor.save", () => void editor.save());
  registerCommand("editor.saveAs", () => void editor.saveAs());
  registerCommand("editor.close", () => void editor.close());
  registerCommand("editor.search", async () => {
    const { openSearchPanelCmd } = await import("$lib/editor/cm");
    openSearchPanelCmd();
  });
  registerCommand("editor.deleteLine", async () => {
    const { deleteLineCmd } = await import("$lib/editor/cm");
    deleteLineCmd();
  });
  registerCommand("editor.convertLayout", async () => {
    const { convertLayoutCmd } = await import("$lib/editor/cm");
    const n = convertLayoutCmd("auto");
    if (!n) ui.showToast(i18n.t("plug.noSel"));
  });
  registerCommand("editor.gotoLine", async () => {
    const lineStr = await ui.askInput(i18n.t("editor.gotoLine"), i18n.t("editor.lineNo"), "1");
    if (!lineStr) return;
    const line = parseInt(lineStr, 10);
    if (Number.isFinite(line)) {
      const { gotoLineCmd } = await import("$lib/editor/cm");
      gotoLineCmd(line);
    }
  });

  // ---------- user menu (F2) ----------
  registerCommand("usermenu.open", () => ui.openDialog("userMenu"));

  // ---------- find files ----------
  registerCommand("search.openDialog", () => ui.openDialog("search"));

  // expose a couple of helpers used by dialogs
  registerCommand("dev.home", () => void homePath());
}

function setSort(mode: "name" | "ext" | "mtime" | "size" | "unsorted") {
  const p = panels.active;
  // same mode again = reverse (unsorted has no direction)
  if (p.sortMode === mode && mode !== "unsorted") {
    p.sortDir = p.sortDir === 1 ? -1 : 1;
  } else {
    p.sortMode = mode;
    p.sortDir = 1;
  }
  p.rebuild();
  const label =
    mode === "unsorted" ? "Unsorted" : mode === "name" ? "Name" : mode === "ext" ? "Ext" : mode === "mtime" ? "Mtime" : "Size";
  const arrow = mode === "unsorted" ? "" : " " + sortArrow(mode, p.sortDir);
  ui.showToast(i18n.t(`panel.sort${label}`) + arrow);
}

// ---- F5/F6 destination variants ----
// the transfer dialog offers preset targets cycled with ↑/↓: the opposite
// panel, "..", home, C:\temp and the drive root (each only if it exists),
// followed by recently used absolute targets, persisted like cmd-history.json
const XFER_HISTORY_MAX = 8;
let xferHistory: string[] | null = null; // null = not loaded yet

async function transferVariants(activePath: string, inactivePath: string): Promise<string[]> {
  const home = await homePath().catch(() => null);
  const driveRoot = /^[A-Za-z]:/.exec(activePath)?.[0] + "\\" || null;
  const candidates = [
    inactivePath,
    parentOf(activePath), // ".."
    home,
    "C:\\temp",
    driveRoot,
  ].filter((v): v is string => !!v && pathKey(v) !== pathKey(activePath));
  // a remote variant is the live folder of the other panel — no local check
  const exists = await Promise.all(
    candidates.map((c) => (isRemotePath(c) ? Promise.resolve(true) : pathExists(c).catch(() => false))),
  );
  const seen = new Set<string>();
  const variants: string[] = [];
  candidates.forEach((c, i) => {
    if (!exists[i]) return;
    const k = pathKey(c);
    if (seen.has(k)) return;
    seen.add(k);
    variants.push(c);
  });
  if (!xferHistory) xferHistory = (await loadJson<string[]>("xfer-history.json").catch(() => null)) ?? [];
  for (const h of xferHistory) {
    const k = pathKey(h);
    if (!seen.has(k)) {
      seen.add(k);
      variants.push(h);
    }
  }
  return variants;
}

// only absolute targets are meaningful history — a bare name is a rename
function rememberTransferTarget(input: string) {
  if (!/^[A-Za-z]:[\\/]/.test(input) && !input.startsWith("\\\\") && !input.startsWith("/") && !input.startsWith("ftp://") && !input.startsWith("sftp://"))
    return;
  const key = pathKey(input);
  const rest = (xferHistory ?? []).filter((h) => pathKey(h) !== key);
  xferHistory = [input, ...rest].slice(0, XFER_HISTORY_MAX);
  saveJson("xfer-history.json", xferHistory).catch(() => {});
}

// the transfer backend opens its own connection from the credentials of the
// live session — make sure one exists for a typed remote target (reconnect
// from a saved site, like the panel listing does after a restart)
async function ensureFtpTarget(target: string): Promise<boolean> {
  if (!isRemotePath(target)) return true;
  const root = remoteAuthority(target);
  if (await remoteList(root).then(() => true, () => false)) return true;
  const site = ftpSites.sites.find((s) => ftpRootOf(s) === root);
  if (!site) return false;
  try {
    await remoteConnect(site);
    return true;
  } catch {
    return false;
  }
}

async function startTransfer(kind: "copy" | "move", currentOnly = false) {
  const p = panels.active;
  // a search-results panel on the passive side is not a writable target —
  // fall back to where that search started
  const destBase = isSearchPath(panels.inactive.path)
    ? searchStore.originPath ?? panels.active.path
    : panels.inactive.path;
  const entries = currentOnly
    ? p.current && p.current.name !== ".."
      ? [p.current]
      : []
    : p.targetEntries;
  if (!entries.length) return;
  const paths = entries.map((e) => entryPath(p, e));

  // an archive panel on either side changes what F5/F6 mean: out of an
  // archive = extraction, into an archive = packing into that archive
  if (isArchivePath(p.path)) {
    if (isArchivePath(destBase) || isRemotePath(destBase)) {
      ui.showToast(i18n.t("archive.extractLocalOnly"));
      return;
    }
    const variants = await transferVariants(p.path, destBase);
    const answer = await ui.askInput(i18n.t("archive.extractTo"), i18n.t("ops.dst"), destBase, undefined, variants);
    if (!answer) return;
    // relative input resolves against the archive file's own directory
    const cwd = parentOf(splitArchiveUrl(p.path).file) ?? destBase;
    const target = resolveTransferTarget(answer.trim(), cwd);
    if (!target || isArchivePath(target) || isRemotePath(target)) return;
    void ops.startExtract(paths.map((url) => ({ url, dest: target })));
    return;
  }
  if (isArchivePath(destBase)) {
    const title = kind === "copy" ? i18n.t("archive.addTo") : i18n.t("archive.moveInto");
    const answer = await ui.askInput(title, i18n.t("ops.dst"), destBase);
    if (!answer) return;
    const target = answer.trim();
    if (isArchivePath(target)) {
      // F6 removes the sources after the archive rewrite succeeds
      void ops.startArchiveAdd(paths, target, kind === "move");
      return;
    }
    // a hand-typed local target is a plain transfer
    const resolved = resolveTransferTarget(target, p.path);
    if (!resolved) return;
    if (!(await ensureFtpTarget(resolved))) {
      ui.showError(i18n.t("ftp.notConnected"));
      return;
    }
    rememberTransferTarget(target);
    if (kind === "copy") void ops.startCopy(paths, resolved);
    else void ops.startMove(paths, resolved);
    return;
  }

  // search rows display the full path as their name — the prefill needs the
  // bare file name
  const firstRealName = entries.length ? basename(entryPath(p, entries[0])) : "";
  // single file: prefill the target name as well (FAR-style), so editing it
  // turns F5/F6 into copy/move-with-rename; pressing Enter unchanged keeps
  // the old "to the other panel" result
  const dest = entries.length === 1 && !entries[0].isDir
    ? joinPath(destBase, firstRealName)
    : destBase;
  const title = kind === "copy" ? i18n.t("ops.copyTo", { n: entries.length }) : i18n.t("ops.moveTo", { n: entries.length });
  // single item (file or dir): Shift+Enter in the dialog replaces the field
  // with this name — a bare name renames/copies-as-new-name in the current
  // folder; multi-selection has no single name, so the key stays inert there
  const resetTo = entries.length === 1 ? firstRealName : undefined;
  const variants = await transferVariants(p.path, destBase);
  const answer = await ui.askInput(title, i18n.t("ops.dst"), dest, resetTo, variants);
  if (!answer) return;
  // a bare name typed on the find list renames in the file's own directory
  const resolveCwd = isSearchPath(p.path) ? parentOf(paths[0]) ?? destBase : p.path;
  const target = resolveTransferTarget(answer.trim(), resolveCwd);
  if (!target) return;
  // unchanged Shift+Enter target = the item itself: a no-op for files, and
  // for dirs an existing-dir target would mean "into itself" (recursion)
  if (resetTo && stripTrailingSep(target) === stripTrailingSep(paths[0])) return;
  // an FTP target needs a live session the backend can borrow the
  // credentials from — reconnect from a saved site if it went stale
  if (!(await ensureFtpTarget(target))) {
    ui.showError(i18n.t("ftp.notConnected"));
    return;
  }
  rememberTransferTarget(answer.trim());
  if (kind === "copy") void ops.startCopy(paths, target);
  else void ops.startMove(paths, target);
}

function stripTrailingSep(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

// The transfer target may be a directory ("into it") or, for a single item,
// a path ending with the new name (FAR-style). Relative input resolves
// against the active panel dir — a bare name renames in the current folder.
// A trailing separator must survive the join: the backend reads it as
// "into this directory" rather than "rename to this name".
function resolveTransferTarget(input: string, cwd: string): string | null {
  if (!input) return null;
  if (/^[A-Za-z]:[\\/]/.test(input) || input.startsWith("\\\\") || input.startsWith("/") || input.startsWith("ftp://") || input.startsWith("sftp://"))
    return input;
  const endsWithSep = /[\\/]$/.test(input);
  const base = input.replace(/[\\/]+$/, "");
  if (!base) return null;
  const joined = joinPath(cwd, base);
  return endsWithSep ? joined + (joined.includes("\\") ? "\\" : "/") : joined;
}

async function startDelete(permanent: boolean, currentOnly = false) {
  const p = panels.active;
  // archive contents are read-only in the VFS (deleting needs a repack)
  if (isArchivePath(p.path)) {
    ui.showToast(i18n.t("archive.readonly"));
    return;
  }
  // there is no trash on a server — remote deletes are always permanent
  const perm = permanent || isRemotePath(p.path);
  const entries = currentOnly
    ? p.current && p.current.name !== ".."
      ? [p.current]
      : []
    : p.targetEntries;
  if (!entries.length) return;
  const paths = entries.map((e) => entryPath(p, e));
  const msg = `${perm ? i18n.t("ops.deletePermanent") : i18n.t("ops.toTrash")}: ${i18n.t("ops.deleteConfirm", { n: entries.length })}`;
  if (settings.s.confirmDelete && !(await ui.askConfirm(msg))) return;
  void ops.startDelete(paths, perm);
}
