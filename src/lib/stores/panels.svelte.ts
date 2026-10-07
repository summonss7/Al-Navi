import { listDir, watchSet, onWatchChanged, onDirSize, computeDirSizes, loadJson, saveJson, homePath, openPath, archiveList } from "$lib/api";
import type { FileEntry, SortMode } from "$lib/types";
import { extOf, joinPath, parentOf, basename, isRootPath, maskToRegExp } from "$lib/format";
import { remoteAuthority, ftpRootOf, isRemotePath, remoteList, remoteConnect } from "$lib/ftp";
import { isArchivePath, isArchiveFile, archiveUrl, joinArchivePath, splitArchiveUrl } from "$lib/archive";
import { isSearchPath, searchStore } from "./search.svelte";
import { cyrillicOfLatin } from "$lib/keymap";
import { i18n } from "./i18n.svelte";
import { settings } from "./settings.svelte";
import { dirSizeCache } from "./dirSizes.svelte";
import { editor } from "./editor.svelte";
import { ftpSites } from "./ftpSites.svelte";

export interface TabState {
  id: number;
  path: string;
  cursor: number;
  history: string[];
  historyIndex: number;
}

const UP_NAME = "..";
/** the synthetic ".." row prepended to the view (real entries come from the backend without it) */
const UP_ENTRY: FileEntry = { name: UP_NAME, isDir: true, size: 0, mtime: 0, attrs: "", isSymlink: false, isHidden: false };
/** a child dir modified this recently is still being written — its size would
 *  be wrong anyway, so no walk is started (it would be invalidated at once) */
const DIR_JUST_MODIFIED_MS = 5000;
/** left-panel share of the panels row: bounds keep either panel usable,
 *  one Ctrl+arrow press slides the split by STEP (auto-repeat sweeps fast) */
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;
const SPLIT_STEP = 0.02;
const splitClamped = (v: number): number =>
  Number.isFinite(v) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v)) : 0.5;
let tabSeq = 1;

function newTab(path: string, history: string[] = [], historyIndex = -1): TabState {
  return { id: tabSeq++, path, cursor: 0, history: history.length ? history : [path], historyIndex: historyIndex >= 0 ? historyIndex : (history.length ? history.length - 1 : 0) };
}

export class PanelState {
  side: "left" | "right";
  /** displayed entries (after filter/sort, with ".." first) — raw shallow state: replaced wholesale, never proxied */
  view = $state.raw<FileEntry[]>([]);
  version = $state(0);
  selVersion = $state(0);
  // reactive: the footer's {#if panel.free} must re-render after load()
  free = $state(0);
  total = $state(0);
  loading = $state(false);
  error = $state<string | null>(null);
  tabs = $state<TabState[]>([]);
  activeTabId = $state(0);
  sortMode = $state<SortMode>("name");
  /** 1 = natural order per mode (name A→Z, newest first, largest first), -1 = reversed */
  sortDir = $state<1 | -1>(1);
  /** accumulated Alt+letter quick-jump prefix (latin physical keys), null = idle */
  quickJumpPrefix = $state<string | null>(null);
  private quickJumpAt = 0;
  private quickJumpTimer: ReturnType<typeof setTimeout> | null = null;
  /** computed folder sizes for children of the current dir: full path -> bytes */
  dirSizes = $state<Map<string, number>>(new Map());
  /** selected entry names — raw state replaced with a new Set on every change */
  selected = $state.raw<Set<string>>(new Set());
  /** visible rows in the panel viewport (kept in sync by VirtualList) */
  viewportRows = 25;

  private raw: FileEntry[] = [];
  private loadSeq = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** set before a chdir to place the cursor on this entry name after load */
  pendingFocusName: string | null = null;
  /** load() moved the tab to a different folder: the cursor starts over on
   *  ".." — the old position (or a coincidentally same-named entry) must not
   *  leak into the new listing */
  private freshDirCursor = false;

  constructor(side: "left" | "right", path: string) {
    this.side = side;
    const t = newTab(path);
    this.tabs = [t];
    this.activeTabId = t.id;
  }

  get tab(): TabState {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? this.tabs[0];
  }

  get path(): string {
    return this.tab.path;
  }

  get cursor(): number {
    return this.tab.cursor;
  }

  set cursor(i: number) {
    const t = this.tab;
    t.cursor = Math.max(0, Math.min(i, Math.max(0, this.view.length - 1)));
  }

  get current(): FileEntry | null {
    return this.view[this.cursor] ?? null;
  }

  // ---------- data ----------

  async load(path: string, opts: { push?: boolean; forceSizes?: boolean } = {}) {
    // search results are served from the search store, not the backend
    if (isSearchPath(path)) {
      this.loading = false;
      this.error = null;
      this.raw = searchStore.entries();
      this.free = 0;
      this.total = 0;
      const t = this.tab;
      if (t.path !== path) {
        t.path = path;
        t.cursor = 0;
        if (opts.push !== false) {
          t.history = [...t.history.slice(0, t.historyIndex + 1), path];
          t.historyIndex = t.history.length - 1;
        }
        panels.scheduleSessionSave();
      }
      this.rebuild();
      return;
    }
    const seq = ++this.loadSeq;
    this.loading = true;
    this.error = null;
    try {
      let res: Awaited<ReturnType<typeof listDir>>;
      if (isArchivePath(path)) {
        // archive VFS: listing served by the backend from the archive file
        res = await archiveList(path);
      } else if (isRemotePath(path)) {
        res = await remoteList(path).catch(async (e: unknown) => {
          // stale session after an app restart: reconnect from a saved site
          // with the same address, then retry the listing
          const auth = remoteAuthority(path);
          const site = ftpSites.sites.find((s) => ftpRootOf(s) === auth);
          if (!site) throw e;
          await remoteConnect(site);
          return remoteList(path);
        });
      } else {
        res = await listDir(path);
      }
      if (seq !== this.loadSeq) return; // stale
      this.raw = res.entries;
      this.free = res.freeBytes;
      this.total = res.totalBytes;
      const t = this.tab;
      if (t.path !== res.path) {
        t.path = res.path;
        // entering a different folder: cursor starts over on ".."
        t.cursor = 0;
        this.freshDirCursor = true;
        if (opts.push !== false) {
          t.history = [...t.history.slice(0, t.historyIndex + 1), res.path];
          t.historyIndex = t.history.length - 1;
        }
        panels.scheduleSessionSave();
      }
      this.rebuild();
      this.requestDirSizes(opts.forceSizes === true);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.error = String(e);
      this.raw = [];
      this.rebuild();
    } finally {
      if (seq === this.loadSeq) this.loading = false;
    }
  }

  rebuild() {
    if (isSearchPath(this.tab.path)) {
      // search results keep found-order: no hidden/system filter, no sorting
      this.view = [UP_ENTRY, ...this.raw];
      this.restoreCursor();
      this.version++;
      return;
    }
    // a fresh dir must not inherit the cursor by name/position from the old one
    const prevName = this.freshDirCursor ? null : this.current?.name;
    this.freshDirCursor = false;
    const showHidden = settings.s.showHidden;
    const showSystem = settings.s.showSystem;
    let list = this.raw.filter((e) => {
      if (e.name === UP_NAME) return true;
      if (!showHidden && e.isHidden) return false;
      if (!showSystem && e.attrs.includes("S")) return false;
      return true;
    });

    const dir = this.sortDir;
    const collator = new Intl.Collator(i18n.locale, { numeric: true, sensitivity: "base" });
    switch (this.sortMode) {
      case "name":
        list.sort((a, b) => dir * collator.compare(a.name, b.name));
        break;
      case "ext":
        list.sort((a, b) => {
          const d = collator.compare(extOf(a.name), extOf(b.name));
          return dir * (d !== 0 ? d : collator.compare(a.name, b.name));
        });
        break;
      case "mtime":
        list.sort((a, b) => dir * (b.mtime - a.mtime));
        break;
      case "size":
        list.sort((a, b) => dir * (b.size - a.size));
        break;
      case "unsorted":
        break;
    }
    if (settings.s.dirsFirst) {
      // stable partition: directories keep their sorted order on top
      const dirs = list.filter((e) => e.isDir);
      if (dirs.length && dirs.length < list.length) {
        list = [...dirs, ...list.filter((e) => !e.isDir)];
      }
    }
    if (settings.s.markedFirst && this.selected.size) {
      // stable partition: marked entries float to the top, keeping sort order within both halves
      const marked = list.filter((e) => this.selected.has(e.name));
      if (marked.length && marked.length < list.length) {
        list = [...marked, ...list.filter((e) => !this.selected.has(e.name))];
      }
    }
    // no ".." in a drive root — an empty slot above the first entry marks the root
    const up = isRootPath(this.path) ? [] : [UP_ENTRY];
    this.view = [...up, ...list];
    this.restoreCursor(prevName ?? undefined);
    this.version++;
  }

  /** place the cursor on pendingFocusName (set by search jump-to-location),
   *  falling back to the previous entry name, else keep it clamped */
  private restoreCursor(prevName?: string) {
    const focus = this.pendingFocusName ?? prevName;
    this.pendingFocusName = null;
    let idx = focus ? this.view.findIndex((e) => e.name === focus) : -1;
    if (idx < 0) idx = Math.min(this.cursor, Math.max(0, this.view.length - 1));
    this.tab.cursor = Math.max(0, idx);
  }

  /** streaming search results: append without re-filtering/re-sorting */
  appendSearchHits(entries: FileEntry[]) {
    if (!isSearchPath(this.tab.path) || !entries.length) return;
    this.raw = [...this.raw, ...entries];
    this.view = [...this.view, ...entries];
    this.version++;
  }

  refresh(forceSizes = false) {
    void this.load(this.path, { push: false, forceSizes });
  }

  scheduleReload() {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      // sizes are revalidated by mtime in requestDirSizes — a forced recompute
      // of every child here re-walked whole trees on each watcher event, even
      // while a transfer into the watched dir was still running
      this.refresh();
    }, 250);
  }

  /**
   * Show cached folder sizes instantly, then recompute stale ones in background.
   * A child dir whose own mtime is newer than its cached entry (direct content
   * changed) is recomputed too — unless it was modified moments ago, which
   * means it is still being written. Results arrive via `dirsize` events and
   * land in applyDirSize().
   */
  private requestDirSizes(force: boolean) {
    // remote roots and archives: no cheap recursive sizes — skip (dirs show no size)
    if (isRemotePath(this.path) || isArchivePath(this.path)) {
      this.dirSizes = new Map();
      return;
    }
    const now = Date.now();
    const next = new Map<string, number>();
    const stale: string[] = [];
    for (const e of this.raw) {
      if (!e.isDir) continue;
      const p = joinPath(this.path, e.name);
      const cached = dirSizeCache.peek(p);
      if (cached !== undefined) next.set(p, cached);
      const at = dirSizeCache.peekAt(p);
      const changedSinceCache = at !== undefined && e.mtime > at;
      const beingWritten = now - e.mtime < DIR_JUST_MODIFIED_MS;
      if (force || dirSizeCache.isStale(p) || (changedSinceCache && !beingWritten)) {
        stale.push(p);
      }
    }
    this.dirSizes = next;
    if (stale.length) computeDirSizes(stale).catch(() => {});
  }

  /** apply a background-computed size if it belongs to a child of the current dir */
  applyDirSize(path: string, size: number) {
    const parent = parentOf(path);
    if (!parent || parent.toLowerCase() !== this.path.toLowerCase()) return;
    const next = new Map(this.dirSizes);
    next.set(path, size);
    this.dirSizes = next;
  }

  dirSizeOf(name: string): number | undefined {
    return this.dirSizes.get(joinPath(this.path, name));
  }

  // ---------- navigation ----------

  async chdir(path: string) {
    this.clearSelection();
    this.clearQuickJump();
    await this.load(path);
    panels.notifyWatch();
  }

  async enter() {
    const cur = this.current;
    if (!cur) return;
    if (cur.name === UP_NAME) {
      await this.up();
      return;
    }
    if (isSearchPath(this.path)) {
      const fp = cur.fullPath ?? cur.name;
      if (cur.isDir) {
        await this.chdir(fp);
      } else {
        // FAR find-list Enter: jump to the file's location, cursor on the file
        const parent = parentOf(fp);
        if (parent) {
          this.pendingFocusName = basename(fp);
          await this.chdir(parent);
        }
      }
      return;
    }
    if (cur.isDir) {
      const child = isArchivePath(this.path) ? joinArchivePath(this.path, cur.name) : joinPath(this.path, cur.name);
      await this.chdir(child);
    } else if (isRemotePath(this.path) || isArchivePath(this.path)) {
      // remote/archive files can't go to the OS shell — open the built-in
      // viewer (a nested .zip inside an archive is not enterable, it views)
      const fp = isArchivePath(this.path) ? joinArchivePath(this.path, cur.name) : joinPath(this.path, cur.name);
      void editor.view(fp);
    } else if (isArchiveFile(cur.name)) {
      // archives open as folders (Shift+Enter still hands them to the shell)
      await this.chdir(archiveUrl(joinPath(this.path, cur.name), ""));
    } else {
      // open with the OS handler
      await panels.openExternally(joinPath(this.path, cur.name));
    }
  }

  async up() {
    if (isSearchPath(this.path)) {
      // leave the find list back to where the search started
      await this.chdir(searchStore.originPath ?? (await homePath().catch(() => "/")));
      return;
    }
    const p = parentOf(this.path);
    if (p) {
      // FAR: leaving a folder puts the cursor back on the folder's own row
      this.pendingFocusName = basename(this.path);
      await this.chdir(p);
    }
  }

  /** Shift+Enter: always hand the entry to the OS shell — folders (and "..")
   *  open in Explorer, files run/open in their own window */
  async enterExternal() {
    if (isRemotePath(this.path) || isArchivePath(this.path)) return; // no local shell for virtual paths
    const cur = this.current;
    if (!cur) return;
    if (isSearchPath(this.path)) {
      // result rows carry real local paths — hand them to the OS shell
      if (cur.name === UP_NAME) {
        const origin = searchStore.originPath;
        if (origin) await panels.openExternally(origin);
        return;
      }
      await panels.openExternally(cur.fullPath ?? cur.name);
      return;
    }
    if (cur.name === UP_NAME) {
      const p = parentOf(this.path);
      if (p) await panels.openExternally(p);
      return;
    }
    await panels.openExternally(joinPath(this.path, cur.name));
  }

  async root() {
    // drive root on Windows ("/" of the drive) or filesystem root
    const path = this.path;
    if (isSearchPath(path)) {
      await this.up();
      return;
    }
    if (isRemotePath(path)) {
      await this.chdir(remoteAuthority(path));
      return;
    }
    if (isArchivePath(path)) {
      // Ctrl+\ inside an archive: jump to the archive's own root
      await this.chdir(archiveUrl(splitArchiveUrl(path).file, ""));
      return;
    }
    const m = /^([A-Za-z]:)(?:[\\/].*)?$/.exec(path);
    if (m) await this.chdir(m[1] + "\\");
    else if (path.startsWith("/")) await this.chdir("/");
    else await this.chdir(parentOf(path) ?? path);
  }

  async intoDir() {
    const cur = this.current;
    if (!cur || cur.name === UP_NAME) return;
    if (!cur.isDir && isArchiveFile(cur.name) && !isArchivePath(this.path)) {
      // Ctrl+PgDn enters archives as folders, like Enter
      await this.chdir(archiveUrl(joinPath(this.path, cur.name), ""));
      return;
    }
    if (cur.isDir) {
      const child = isArchivePath(this.path) ? joinArchivePath(this.path, cur.name) : joinPath(this.path, cur.name);
      await this.chdir(isSearchPath(this.path) ? cur.fullPath ?? cur.name : child);
    }
  }

  async historyBack() {
    const t = this.tab;
    if (t.historyIndex > 0) {
      t.historyIndex--;
      await this.load(t.history[t.historyIndex], { push: false });
      panels.notifyWatch();
    }
  }

  async historyForward() {
    const t = this.tab;
    if (t.historyIndex < t.history.length - 1) {
      t.historyIndex++;
      await this.load(t.history[t.historyIndex], { push: false });
      panels.notifyWatch();
    }
  }

  // ---------- cursor ----------

  moveCursor(delta: number) {
    this.cursor = this.cursor + delta;
  }

  pageMove(delta: number, page: number) {
    this.cursor = this.cursor + delta * page;
  }

  moveByName(prefix: string): boolean {
    // jump to the next entry with this prefix (case-insensitive, wraps around)
    const p = prefix.toLowerCase();
    const n = this.view.length;
    if (!n) return false;
    const start = this.cursor >= n - 1 ? -1 : this.cursor;
    for (let k = 1; k <= n; k++) {
      const i = (start + k + n) % n;
      if (this.view[i].name.toLowerCase().startsWith(p)) {
        this.cursor = i;
        return true;
      }
    }
    return false;
  }

  /** Alt+letter quick jump with prefix accumulation: rapid presses extend the
   *  prefix ("с", "л" -> "сл"), a pause starts a new search. Latin names win,
   *  otherwise the same physical keys are retried as their ЙЦУКЕН letters. */
  quickJump(latin: string, ttl = 900): void {
    const now = Date.now();
    if (this.quickJumpPrefix === null || now - this.quickJumpAt > ttl) this.quickJumpPrefix = "";
    this.quickJumpAt = now;
    this.quickJumpPrefix += latin.toUpperCase();

    const cyr = [...this.quickJumpPrefix].map((c) => cyrillicOfLatin(c) ?? "\0").join("");
    if (!this.moveByName(this.quickJumpPrefix) && !cyr.includes("\0")) {
      this.moveByName(cyr);
    }

    if (this.quickJumpTimer) clearTimeout(this.quickJumpTimer);
    this.quickJumpTimer = setTimeout(() => this.clearQuickJump(), ttl);
  }

  clearQuickJump() {
    if (this.quickJumpTimer) {
      clearTimeout(this.quickJumpTimer);
      this.quickJumpTimer = null;
    }
    this.quickJumpPrefix = null;
  }

  // ---------- selection ----------

  isSelected(name: string): boolean {
    return this.selected.has(name);
  }

  toggleAt(i: number, advance = true) {
    const e = this.view[i];
    if (!e || e.name === UP_NAME) {
      if (advance) this.cursor = i + 1;
      return;
    }
    const next = new Set(this.selected);
    if (next.has(e.name)) next.delete(e.name);
    else next.add(e.name);
    this.selected = next;
    this.selVersion++;
    if (settings.s.markedFirst) {
      // the row floats to the top (or back into place) — remember the next
      // unmarked row in the old order so serial Ins keeps walking down like FAR
      let follow: string | undefined;
      if (advance) {
        for (let k = i + 1; k < this.view.length; k++) {
          const en = this.view[k];
          if (en.name !== UP_NAME && !next.has(en.name)) { follow = en.name; break; }
        }
      }
      this.rebuild();
      if (follow) {
        const idx = this.view.findIndex((v) => v.name === follow);
        if (idx >= 0) this.cursor = idx;
      }
      return;
    }
    if (advance) this.cursor = i + 1;
  }

  selectByMask(mask: string, on: boolean) {
    // FAR-style wildcard mask: comma-separated, * and ? allowed
    const re = maskToRegExp(mask);
    const next = new Set(this.selected);
    for (const e of this.view) {
      if (e.name === UP_NAME) continue;
      const m = re.test(e.name);
      if (m && on) next.add(e.name);
      else if (m && !on) next.delete(e.name);
    }
    this.selected = next;
    this.selVersion++;
    if (settings.s.markedFirst) this.rebuild();
  }

  invertSelection() {
    const next = new Set<string>();
    for (const e of this.view) {
      if (e.name === UP_NAME) continue;
      if (!this.selected.has(e.name)) next.add(e.name);
    }
    this.selected = next;
    this.selVersion++;
    if (settings.s.markedFirst) this.rebuild();
  }

  clearSelection() {
    if (this.selected.size) {
      this.selected = new Set();
      this.selVersion++;
      if (settings.s.markedFirst) this.rebuild();
    }
  }

  /** UI-side selection change (shift-click range): bump and re-float marked rows */
  selectionChanged() {
    this.selVersion++;
    if (settings.s.markedFirst) this.rebuild();
  }

  get selectedEntries(): FileEntry[] {
    return this.view.filter((e) => e.name !== UP_NAME && this.selected.has(e.name));
  }

  /** FAR semantics: selected items, or the single item under cursor */
  get targetEntries(): FileEntry[] {
    const sel = this.selectedEntries;
    if (sel.length > 0) return sel;
    const cur = this.current;
    return cur && cur.name !== UP_NAME ? [cur] : [];
  }

  get targetPaths(): string[] {
    return this.targetEntries.map((e) =>
      e.fullPath ?? (isArchivePath(this.path) ? joinArchivePath(this.path, e.name) : joinPath(this.path, e.name)),
    );
  }

  get stats(): { files: number; dirs: number; selFiles: number; selDirs: number; selBytes: number } {
    let files = 0, dirs = 0, selFiles = 0, selDirs = 0, selBytes = 0;
    for (const e of this.view) {
      if (e.name === UP_NAME) continue;
      if (e.isDir) dirs++;
      else files++;
      if (this.selected.has(e.name)) {
        if (e.isDir) selDirs++;
        else {
          selFiles++;
          selBytes += e.size;
        }
      }
    }
    return { files, dirs, selFiles, selDirs, selBytes };
  }

  // ---------- tabs ----------

  newTab(path = this.path) {
    const t = newTab(path);
    this.tabs = [...this.tabs, t];
    this.activeTabId = t.id;
    void this.load(path).then(() => panels.notifyWatch());
  }

  closeTab(id = this.activeTabId) {
    if (this.tabs.length <= 1) return;
    const idx = this.tabs.findIndex((t) => t.id === id);
    this.tabs = this.tabs.filter((t) => t.id !== id);
    if (this.activeTabId === id) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activeTabId = next.id;
      void this.load(next.path, { push: false }).then(() => panels.notifyWatch());
    }
  }

  activateTab(id: number) {
    const t = this.tabs.find((t) => t.id === id);
    if (t) {
      this.activeTabId = id;
      void this.load(t.path, { push: false }).then(() => panels.notifyWatch());
    }
  }

  cycleTab(dir: 1 | -1) {
    const n = this.tabs.length;
    if (n <= 1) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeTabId);
    const next = this.tabs[(idx + dir + n) % n];
    this.activateTab(next.id);
  }
}

class PanelsStore {
  left = new PanelState("left", "");
  right = new PanelState("right", "");
  activeSide = $state<"left" | "right">("left");
  showLeft = $state(true);
  showRight = $state(true);
  /** left panel's share of the panels row when both are visible; Ctrl+Left/
   *  Ctrl+Right slide it (FAR-style panel resize), persisted in session.json */
  splitRatio = $state(0.5);
  shortcuts = $state<Record<string, string>>({});
  dirHistory = $state<string[]>([]);

  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private sessTimer: ReturnType<typeof setTimeout> | null = null;

  get active(): PanelState {
    return this.activeSide === "left" ? this.left : this.right;
  }

  get inactive(): PanelState {
    return this.activeSide === "left" ? this.right : this.left;
  }

  async init() {
    const session = await loadJson<{ leftPath?: string; rightPath?: string; shortcuts?: Record<string, string>; splitRatio?: number }>("session.json");
    let home: string;
    try {
      home = await homePath();
    } catch {
      home = "/";
    }
    const leftPath = session?.leftPath || home;
    const rightPath = session?.rightPath || home;
    this.shortcuts = session?.shortcuts ?? {};
    this.splitRatio = splitClamped(session?.splitRatio ?? 0.5);
    const hist = await loadJson<string[]>("dir-history.json");
    this.dirHistory = hist ?? [];
    await dirSizeCache.init();
    await Promise.all([this.left.load(leftPath), this.right.load(rightPath)]);
    this.notifyWatch();
    onWatchChanged((path) => {
      const norm = path.replace(/[\\/]+$/, "").toLowerCase();
      for (const p of [this.left, this.right]) {
        const pp = p.path.replace(/[\\/]+$/, "").toLowerCase();
        if (norm.startsWith(pp)) p.scheduleReload();
      }
    }).catch(console.error);
    onDirSize(({ path, size }) => {
      dirSizeCache.put(path, size);
      this.left.applyDirSize(path, size);
      this.right.applyDirSize(path, size);
    }).catch(console.error);
  }

  async openExternally(path: string) {
    openPath(path).catch((e) => console.error(e));
  }

  /** re-apply view settings (hidden/system/dirs-first) to both panels */
  refreshView() {
    this.left.rebuild();
    this.right.rebuild();
  }

  switchActive() {
    this.activeSide = this.activeSide === "left" ? "right" : "left";
  }

  swap() {
    const l = this.left, r = this.right;
    const lPath = l.path, rPath = r.path;
    void l.load(rPath, { push: false });
    void r.load(lPath, { push: false });
    this.notifyWatch();
  }

  hideBoth() {
    this.showLeft = false;
    this.showRight = false;
  }

  showBoth() {
    this.showLeft = true;
    this.showRight = true;
  }

  /** FAR's Ctrl+O: one key both hides the panels and brings them back */
  toggleBoth() {
    if (!this.showLeft && !this.showRight) this.showBoth();
    else this.hideBoth();
  }

  toggleSide(side: "left" | "right") {
    if (side === "left") {
      this.showLeft = !this.showLeft;
      if (!this.showRight && !this.showLeft) this.showRight = true;
    } else {
      this.showRight = !this.showRight;
      if (!this.showLeft && !this.showRight) this.showLeft = true;
    }
  }

  /** Ctrl+Left/Right: slide the vertical split between the panels (FAR-style
   *  resize — handy for long file names). Meaningful only with both panels
   *  visible; persisted with the debounced session save. */
  moveSplit(dir: 1 | -1) {
    if (!this.showLeft || !this.showRight) return;
    const next = splitClamped(this.splitRatio + dir * SPLIT_STEP);
    if (next === this.splitRatio) return;
    this.splitRatio = next;
    this.scheduleSessionSave();
  }

  notifyWatch() {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      // the OS watcher is local-only — FTP, search-result and archive paths
      // are refreshed via Ctrl+R
      const paths = [this.left.path, this.right.path].filter(
        (p) => p && !isRemotePath(p) && !isSearchPath(p) && !isArchivePath(p),
      );
      if (paths.length) watchSet(paths).catch(() => {});
    }, 400);
  }

  pushDirHistory(path: string) {
    this.dirHistory = [path, ...this.dirHistory.filter((p) => p !== path)].slice(0, 100);
    saveJson("dir-history.json", this.dirHistory).catch(() => {});
  }

  assignShortcut(digit: string) {
    const path = this.active.path;
    this.shortcuts = { ...this.shortcuts, [digit]: path };
    saveJson("session.json", this.sessionData()).catch(() => {});
  }

  async jumpShortcut(digit: string) {
    const path = this.shortcuts[digit];
    if (path) {
      await this.active.chdir(path);
      this.pushDirHistory(path);
    }
    return !!path;
  }

  /** debounced session save on navigation — a crash then loses no panel paths
   *  (session.json is otherwise only written at graceful exit) */
  scheduleSessionSave() {
    if (this.sessTimer) clearTimeout(this.sessTimer);
    this.sessTimer = setTimeout(() => {
      this.sessTimer = null;
      this.saveSession();
    }, 1000);
  }

  sessionData() {
    // a search-results panel restores as the directory the search started in;
    // an archive panel restores as the archive file's own directory on disk
    const real = (p: string) => {
      if (isSearchPath(p)) return searchStore.originPath || "";
      if (isArchivePath(p)) return parentOf(splitArchiveUrl(p).file) ?? p;
      return p;
    };
    return {
      leftPath: real(this.left.path),
      rightPath: real(this.right.path),
      shortcuts: this.shortcuts,
      splitRatio: this.splitRatio,
    };
  }

  saveSession() {
    saveJson("session.json", this.sessionData()).catch(() => {});
  }
}

export const panels = new PanelsStore();
