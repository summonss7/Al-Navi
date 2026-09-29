import { loadJson, saveJson } from "$lib/api";

/**
 * Persistent index of folder sizes ("≈" values, like FAR's calculated sizes).
 * Entries older than TTL are recomputed in the background on next visit;
 * watcher-triggered reloads force a recompute of the current dir's children.
 */

const TTL_MS = 10 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 2000;

interface Entry {
  size: number;
  at: number;
}

function norm(path: string): string {
  // Windows is case-insensitive; drive roots may carry a trailing separator
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

class DirSizeCache {
  private map = new Map<string, Entry>();
  private loaded = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  async init() {
    if (this.loaded) return;
    this.loaded = true;
    const data = await loadJson<Record<string, Entry>>("dir-sizes.json").catch(() => null);
    if (data) {
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v.size === "number") this.map.set(norm(k), v);
      }
    }
  }

  /** cached size regardless of freshness (shown instantly while recompute runs) */
  peek(path: string): number | undefined {
    return this.map.get(norm(path))?.size;
  }

  isStale(path: string): boolean {
    const e = this.map.get(norm(path));
    return !e || Date.now() - e.at > TTL_MS;
  }

  put(path: string, size: number) {
    this.map.set(norm(path), { size, at: Date.now() });
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      saveJson("dir-sizes.json", Object.fromEntries(this.map)).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  }
}

export const dirSizeCache = new DirSizeCache();
