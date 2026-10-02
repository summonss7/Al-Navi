import { loadJson, saveJson } from "$lib/api";
import { panels } from "./panels.svelte";

/** one F2 user-menu command, stored in user-menu.json */
export interface UserMenuItem {
  id: number;
  title: string;
  command: string;
}

/** FAR-style user menu (F2): editable list of command-line commands.
 *  Placeholders are substituted against the panel cursor before running:
 *  `!!` full file name, `!` name without extension, `!\` panel directory. */
class UserMenuStore {
  items = $state<UserMenuItem[]>([]);
  private loaded = false;
  private nextId = 1;

  async init() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.items = (await loadJson<UserMenuItem[]>("user-menu.json")) ?? [];
      this.nextId = this.items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
    } catch {
      // no backend (browser preview) or no saved file yet
    }
  }

  private persist() {
    saveJson("user-menu.json", this.items).catch(() => {});
  }

  /** insert or update by id; returns the stored item */
  upsert(item: { id?: number; title: string; command: string }): UserMenuItem {
    const clean: UserMenuItem =
      item.id !== undefined && this.items.some((i) => i.id === item.id)
        ? { id: item.id, title: item.title, command: item.command }
        : { id: this.nextId++, title: item.title, command: item.command };
    const i = this.items.findIndex((x) => x.id === clean.id);
    this.items = i >= 0 ? this.items.map((x) => (x.id === clean.id ? clean : x)) : [...this.items, clean];
    this.persist();
    return clean;
  }

  remove(id: number) {
    this.items = this.items.filter((i) => i.id !== id);
    this.persist();
  }
}

export const userMenu = new UserMenuStore();

/** substitute FAR-style placeholders against the file under the panel cursor:
 *  `!!` full name, `!` name without extension, `!\` active panel directory
 *  (with a trailing separator). Single pass, so a name containing `!` itself
 *  never gets re-expanded. */
export function expandUserPlaceholders(command: string): string {
  const cur = panels.active.current;
  const name = cur && cur.name !== ".." ? cur.name : "";
  const dot = name.lastIndexOf(".");
  const stem = name && dot > 0 ? name.slice(0, dot) : name;
  const dir = panels.active.path;
  const sep = dir.includes("\\") ? "\\" : "/";
  const dirWithSep = dir ? dir.replace(/[\\/]+$/, "") + sep : "";
  return command.replace(/!!|!\\|!/g, (m) => (m === "!!" ? name : m === "!\\" ? dirWithSep : stem));
}
