import { listDir, watchSet, onWatchChanged, loadJson, saveJson, homePath, openPath } from "$lib/api";
import type { FileEntry, SortMode } from "$lib/types";
import { extOf, joinPath, parentOf } from "$lib/format";
import { i18n } from "./i18n.svelte";
import { settings } from "./settings.svelte";

export interface TabState {
  id: number;
  path: string;
  cursor: number;
  history: string[];
  historyIndex: number;
}

const UP_NAME = "..";
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
  free = 0;
  total = 0;
  loading = $state(false);
  error = $state<string | null>(null);
  tabs = $state<TabState[]>([]);
  activeTabId = $state(0);
  sortMode = $state<SortMode>("name");
  showHidden = $state(false);
  quickFilter = $state<string | null>(null);
  /** selected entry names — raw state replaced with a new Set on every change */
  selected = $state.raw<Set<string>>(new Set());
  /** visible rows in the panel viewport (kept in sync by VirtualList) */
  viewportRows = 25;

  private raw: FileEntry[] = [];
  private loadSeq = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(side: "left" | "right", path: string) {
    this.side = side;
    const t = newTab(path);
    this.tabs = [t];
    this.activeTabId = t.id;
    this.showHidden = settings.s.showHidden;
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

  async load(path: string, opts: { push?: boolean } = {}) {
    const seq = ++this.loadSeq;
    this.loading = true;
    this.error = null;
    try {
      const res = await listDir(path);
      if (seq !== this.loadSeq) return; // stale
      this.raw = res.entries;
      this.free = res.freeBytes;
      this.total = res.totalBytes;
      const t = this.tab;
      if (t.path !== res.path) {
        t.path = res.path;
        if (opts.push !== false) {
          t.history = [...t.history.slice(0, t.historyIndex + 1), res.path];
          t.historyIndex = t.history.length - 1;
        }
      }
      this.rebuild();
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
    const prevName = this.current?.name;
    const q = this.quickFilter?.toLowerCase() ?? null;
    let list = this.raw.filter((e) => {
      if (!this.showHidden && e.isHidden && e.name !== UP_NAME) return false;
      if (q && e.name !== UP_NAME && !e.name.toLowerCase().includes(q)) return false;
      return true;
    });

    const collator = new Intl.Collator(i18n.locale, { numeric: true, sensitivity: "base" });
    switch (this.sortMode) {
      case "name":
        list.sort((a, b) => collator.compare(a.name, b.name));
        break;
      case "ext":
        list.sort((a, b) => {
          const d = collator.compare(extOf(a.name), extOf(b.name));
          return d !== 0 ? d : collator.compare(a.name, b.name);
        });
        break;
      case "mtime":
        list.sort((a, b) => b.mtime - a.mtime);
        break;
      case "size":
        list.sort((a, b) => b.size - a.size);
        break;
      case "unsorted":
        break;
    }
    this.view = [{ name: UP_NAME, isDir: true, size: 0, mtime: 0, attrs: "", isSymlink: false, isHidden: false }, ...list];
    // restore cursor position by name
    let idx = prevName ? this.view.findIndex((e) => e.name === prevName) : -1;
    if (idx < 0) {
      // keep cursor clamped
      idx = Math.min(this.cursor, this.view.length - 1);
    }
    this.tab.cursor = Math.max(0, idx);
    this.version++;  }

  refresh() {
    void this.load(this.path, { push: false });
  }

  scheduleReload() {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.refresh();
    }, 250);
  }

  // ---------- navigation ----------

  async chdir(path: string) {
    this.clearSelection();
    this.quickFilter = null;
    await this.load(path);
    panels.notifyWatch();
  }

  async enter() {
    const cur = this.current;
    if (!cur) return;
    if (cur.name === UP_NAME) {
      await this.up();
    } else if (cur.isDir) {
      await this.chdir(joinPath(this.path, cur.name));
    } else {
      // open with the OS handler
      await panels.openExternally(joinPath(this.path, cur.name));
    }
  }

  async up() {
    const p = parentOf(this.path);
    if (p) await this.chdir(p);
  }

  async root() {
    // drive root on Windows ("/" of the drive) or filesystem root
    const path = this.path;
    const m = /^([A-Za-z]:)(?:[\\/].*)?$/.exec(path);
    if (m) await this.chdir(m[1] + "\\");
    else if (path.startsWith("/")) await this.chdir("/");
    else await this.chdir(parentOf(path) ?? path);
  }

  async intoDir() {
    const cur = this.current;
    if (cur?.isDir && cur.name !== UP_NAME) await this.chdir(joinPath(this.path, cur.name));
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
    // quick-find: jump to first entry with this prefix (case-insensitive)
    const p = prefix.toLowerCase();
    const start = this.view[this.cursor]?.name === UP_NAME ? 1 : this.cursor;
    for (let i = start; i < this.view.length; i++) {
      if (this.view[i].name.toLowerCase().startsWith(p)) {
        this.cursor = i;
        return true;
      }
    }
    return false;
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
  }

  invertSelection() {
    const next = new Set<string>();
    for (const e of this.view) {
      if (e.name === UP_NAME) continue;
      if (!this.selected.has(e.name)) next.add(e.name);
    }
    this.selected = next;
    this.selVersion++;
  }

  clearSelection() {
    if (this.selected.size) {
      this.selected = new Set();
      this.selVersion++;
    }
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
    return this.targetEntries.map((e) => joinPath(this.path, e.name));
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

function maskToRegExp(mask: string): RegExp {
  const parts = mask
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) parts.push("*");
  const src = parts
    .map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."))
    .join("|");
  return new RegExp(`^(${src})$`, "i");
}

class PanelsStore {
  left = new PanelState("left", "");
  right = new PanelState("right", "");
  activeSide = $state<"left" | "right">("left");
  showLeft = $state(true);
  showRight = $state(true);
  shortcuts = $state<Record<string, string>>({});
  dirHistory = $state<string[]>([]);

  private watchTimer: ReturnType<typeof setTimeout> | null = null;

  get active(): PanelState {
    return this.activeSide === "left" ? this.left : this.right;
  }

  get inactive(): PanelState {
    return this.activeSide === "left" ? this.right : this.left;
  }

  async init() {
    const session = await loadJson<{ leftPath?: string; rightPath?: string; shortcuts?: Record<string, string> }>("session.json");
    let home = "";
    try {
      home = await homePath();
    } catch {
      home = "/";
    }
    const leftPath = session?.leftPath || home;
    const rightPath = session?.rightPath || home;
    this.shortcuts = session?.shortcuts ?? {};
    const hist = await loadJson<string[]>("dir-history.json");
    this.dirHistory = hist ?? [];
    await Promise.all([this.left.load(leftPath), this.right.load(rightPath)]);
    this.notifyWatch();
    onWatchChanged((path) => {
      const norm = path.replace(/[\\/]+$/, "").toLowerCase();
      for (const p of [this.left, this.right]) {
        const pp = p.path.replace(/[\\/]+$/, "").toLowerCase();
        if (norm.startsWith(pp)) p.scheduleReload();
      }
    }).catch(console.error);
  }

  async openExternally(path: string) {
    openPath(path).catch((e) => console.error(e));
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

  toggleSide(side: "left" | "right") {
    if (side === "left") {
      this.showLeft = !this.showLeft;
      if (!this.showRight && !this.showLeft) this.showRight = true;
    } else {
      this.showRight = !this.showRight;
      if (!this.showLeft && !this.showRight) this.showLeft = true;
    }
  }

  notifyWatch() {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      const paths = [this.left.path, this.right.path].filter(Boolean);
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

  sessionData() {
    return {
      leftPath: this.left.path,
      rightPath: this.right.path,
      shortcuts: this.shortcuts,
    };
  }

  saveSession() {
    saveJson("session.json", this.sessionData()).catch(() => {});
  }
}

export const panels = new PanelsStore();
