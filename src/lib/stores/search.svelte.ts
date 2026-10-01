import type { UnlistenFn } from "@tauri-apps/api/event";
import type { FileEntry, SearchDoneEvent, SearchHit, SearchHitsEvent, SearchParams } from "$lib/types";
import { loadJson, saveJson, searchCancel, searchStart, onSearchDone, onSearchHit } from "$lib/api";
import { panels } from "./panels.svelte";
import { ui } from "./ui.svelte";
import { i18n } from "./i18n.svelte";

/** pseudo-path of the search-results virtual panel (one active search) */
export const SEARCH_PATH = "search://";
export const isSearchPath = (p: string) => p === SEARCH_PATH || p.startsWith("search://");

function hitToEntry(h: SearchHit): FileEntry {
  // the display name is the full path (like FAR's find list); fullPath keeps
  // the real path for commands
  return {
    name: h.path,
    isDir: h.isDir,
    size: h.size,
    mtime: h.mtime,
    attrs: h.attrs,
    isSymlink: h.isSymlink,
    isHidden: h.isHidden,
    fullPath: h.path,
  };
}

class SearchStore {
  params = $state<SearchParams | null>(null);
  /** last executed search — prefills the dialog */
  lastParams = $state<SearchParams | null>(null);
  hits = $state.raw<SearchHit[]>([]);
  running = $state(false);
  scanned = $state(0);
  done = $state(false);
  cancelled = $state(false);
  errors = $state<string[]>([]);
  elapsedMs = $state(0);
  /** where the search started — ".." returns there */
  originPath = $state<string | null>(null);
  /** -1 while the invoke is in flight: events can beat the returned id */
  private currentId = -1;
  /** last resolved backend id; ids strictly increase, so while awaiting ours
   *  an event with a bigger id belongs to the new search and a smaller/equal
   *  one to the search it superseded */
  private lastId = 0;
  private unlisteners: UnlistenFn[] = [];

  async init() {
    this.unlisteners.push(await onSearchHit((e) => this.onHits(e)));
    this.unlisteners.push(await onSearchDone((e) => this.onDone(e)));
    this.lastParams = await loadJson<SearchParams>("search-history.json").catch(() => null);
  }

  dispose() {
    for (const u of this.unlisteners) u();
    this.unlisteners = [];
  }

  /** panel source: current hits as panel entries */
  entries(): FileEntry[] {
    return this.hits.map(hitToEntry);
  }

  private ours(id: number): boolean {
    return this.currentId !== -1 ? id === this.currentId : id > this.lastId;
  }

  private onHits(e: SearchHitsEvent) {
    if (!this.running || !this.ours(e.id)) return;
    this.scanned = e.scanned;
    if (!e.hits.length) return;
    this.hits = [...this.hits, ...e.hits];
    const entries = e.hits.map(hitToEntry);
    // stream into whichever panel currently shows the results
    panels.left.appendSearchHits(entries);
    panels.right.appendSearchHits(entries);
  }

  private onDone(e: SearchDoneEvent) {
    if (!this.ours(e.id)) return;
    this.lastId = Math.max(this.lastId, e.id);
    this.currentId = -1;
    this.running = false;
    this.done = true;
    this.cancelled = e.cancelled;
    this.errors = e.errors;
    this.scanned = e.scanned;
    this.elapsedMs = e.elapsedMs;
    if (this.cancelled) {
      ui.showToast(i18n.t("search.cancelledToast", { n: this.hits.length }));
    } else if (this.errors.length) {
      ui.showToast(i18n.t("search.doneErrors", { n: this.hits.length, e: this.errors.length }));
    }
  }

  async start(params: SearchParams) {
    this.params = params;
    this.hits = [];
    this.scanned = 0;
    this.done = false;
    this.cancelled = false;
    this.errors = [];
    this.elapsedMs = 0;
    this.originPath = params.root;
    this.running = true;
    this.currentId = -1;
    // show the (still empty) results panel right away, FAR-style; hits stream
    // in as search:hit events arrive
    await panels.active.load(SEARCH_PATH);
    try {
      this.currentId = await searchStart(params);
      this.lastId = Math.max(this.lastId, this.currentId);
    } catch (err) {
      this.running = false;
      this.done = true;
      ui.showError(String(err));
      return;
    }
    this.lastParams = params;
    saveJson("search-history.json", params).catch(() => {});
  }

  /** Esc on the results panel; true when a cancel was actually requested */
  cancel(): boolean {
    if (!this.running) return false;
    if (this.currentId !== -1) void searchCancel(this.currentId).catch(() => {});
    return true;
  }
}

export const searchStore = new SearchStore();
