import { loadJson, saveJson } from "$lib/api";
import { i18n, type Locale } from "./i18n.svelte";

export type ThemeId =
  | "alnaviDark"
  | "alnaviLight"
  | "midnight"
  | "solarized"
  | "contrast"
  | "auto";

export interface Settings {
  theme: ThemeId;
  locale: Locale;
  showHidden: boolean;
  sortName: "name";
  editorTabSize: number;
  editorWordWrap: boolean;
  confirmDelete: boolean;
  fallbackEncoding: string;
}

const DEFAULTS: Settings = {
  theme: "alnaviLight",
  locale: "en",
  showHidden: false,
  sortName: "name",
  editorTabSize: 4,
  editorWordWrap: false,
  confirmDelete: true,
  fallbackEncoding: "windows-1251",
};

export const THEMES: { id: ThemeId; dark: boolean }[] = [
  { id: "alnaviDark", dark: true },
  { id: "alnaviLight", dark: false },
  { id: "midnight", dark: true },
  { id: "solarized", dark: false },
  { id: "contrast", dark: true },
];

class SettingsStore {
  s = $state<Settings>({ ...DEFAULTS });
  loaded = $state(false);
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  async init() {
    let saved: Partial<Settings> | null = null;
    try {
      saved = await loadJson<Partial<Settings>>("settings.json");
    } catch {
      // no Tauri backend (browser preview) — keep defaults
    }
    this.s = { ...DEFAULTS, ...(saved ?? {}) };
    i18n.setLocale(this.s.locale);
    this.applyTheme();
    this.loaded = true;
  }

  set(patch: Partial<Settings>) {
    this.s = { ...this.s, ...patch };
    if (patch.locale) i18n.setLocale(patch.locale);
    if (patch.theme) this.applyTheme();
    this.persist();
  }

  applyTheme() {
    let t = this.s.theme;
    if (t === "auto") {
      t = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "alnaviDark"
        : "alnaviLight";
    }
    document.documentElement.dataset.theme = t;
    // themes with a solid full-row cursor recolor row icons; the light theme
    // uses an orange outline selection that keeps per-file icon colors
    document.documentElement.dataset.cursor = t === "alnaviLight" ? "outline" : "solid";
  }

  private persist() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      saveJson("settings.json", this.s).catch(console.error);
    }, 300);
  }
}

export const settings = new SettingsStore();

export const effectiveTheme = (): string => document.documentElement.dataset.theme ?? "alnaviDark";
