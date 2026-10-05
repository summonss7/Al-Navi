import { loadJson, saveJson } from "$lib/api";
import { i18n, type Locale } from "./i18n.svelte";

export type ThemeId =
  | "alnaviDark"
  | "alnaviLight"
  | "midnight"
  | "solarized"
  | "contrast"
  | "auto";

/** User overrides for the two brand highlight tokens; null = theme default.
 *  --accent2 (orange) drives selection/cursor glow, --accent (lime) identity. */
export interface HighlightColors {
  selection: string | null;
  accent: string | null;
}

export interface Settings {
  theme: ThemeId;
  locale: Locale;
  showHidden: boolean;
  showSystem: boolean;
  dirsFirst: boolean;
  markedFirst: boolean;
  editorTabSize: number;
  editorWordWrap: boolean;
  confirmDelete: boolean;
  fallbackEncoding: string;
  fontSize: number;
  colors: HighlightColors;
  editorDecor: boolean;
}

/** Base body font the whole UI pixel design is tuned to; --fs-scale = fontSize / this. */
export const BASE_FONT_PX = 13.5;

const DEFAULTS: Settings = {
  theme: "alnaviLight",
  locale: "en",
  showHidden: false,
  showSystem: true,
  dirsFirst: true,
  markedFirst: false,
  editorTabSize: 4,
  editorWordWrap: false,
  confirmDelete: true,
  fallbackEncoding: "windows-1251",
  fontSize: BASE_FONT_PX,
  colors: { selection: null, accent: null },
  editorDecor: true,
};

export const THEMES: { id: ThemeId; dark: boolean }[] = [
  { id: "alnaviDark", dark: true },
  { id: "alnaviLight", dark: false },
  { id: "midnight", dark: true },
  { id: "solarized", dark: false },
  { id: "contrast", dark: true },
];

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance — used to pick readable text on a user accent. */
function relLuminance(rgb: [number, number, number]): number {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}

function readableOn(hex: string): string {
  const rgb = hexToRgb(hex);
  return rgb && relLuminance(rgb) > 0.4 ? "#142408" : "#ffffff";
}

/** Darkened accent usable as text on light backgrounds (like lime -> --accent-ink). */
function darken(hex: string, k: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const c = rgb.map((v) => Math.round(v * k));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

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
    this.s.colors = { ...DEFAULTS.colors, ...(this.s.colors ?? {}) };
    i18n.setLocale(this.s.locale);
    this.applyTheme();
    this.applyFontSize();
    this.applyColors();
    this.loaded = true;
  }

  set(patch: Partial<Settings>) {
    this.s = { ...this.s, ...patch };
    if (patch.locale) i18n.setLocale(patch.locale);
    if (patch.theme) this.applyTheme();
    if (patch.fontSize) this.applyFontSize();
    if (patch.colors) this.applyColors();
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
    // accent ink depends on theme lightness — recompute overrides
    this.applyColors();
  }

  applyFontSize() {
    document.documentElement.style.setProperty(
      "--fs-scale",
      String(this.s.fontSize / BASE_FONT_PX),
    );
  }

  /** Zoom the whole UI font by d px — the one stepper shared by the F9 dialog
   *  and the Ctrl+± hotkeys; 0.5 steps, clamped to 10..24, rounded to kill FP noise */
  stepFontSize(d: number): number {
    const v = Math.min(24, Math.max(10, Math.round((this.s.fontSize + d) * 2) / 2));
    this.set({ fontSize: v });
    return v;
  }

  /** Recolors the highlight family inline on <html> (beats any theme block).
   *  selection -> --sel + --accent2 (row selection, cursor, marker, active
   *  panel, f-key hover, editor selection); accent -> --accent (+ derived
   *  readable --accent-fg / --accent-ink), the lime identity color. */
  applyColors() {
    const st = document.documentElement.style;
    const { selection, accent } = this.s.colors;
    if (selection) {
      st.setProperty("--sel", selection);
      st.setProperty("--accent2", selection);
    } else {
      st.removeProperty("--sel");
      st.removeProperty("--accent2");
    }
    if (accent) {
      st.setProperty("--accent", accent);
      st.setProperty("--accent-fg", readableOn(accent));
      st.setProperty("--accent-ink", this.darkThemeActive() ? accent : darken(accent, 0.66));
    } else {
      st.removeProperty("--accent");
      st.removeProperty("--accent-fg");
      st.removeProperty("--accent-ink");
    }
  }

  private darkThemeActive(): boolean {
    const t = document.documentElement.dataset.theme ?? "alnaviDark";
    return THEMES.find((x) => x.id === t)?.dark ?? true;
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
