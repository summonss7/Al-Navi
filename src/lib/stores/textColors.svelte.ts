import { loadJson, saveJson } from "$lib/api";

/** Editor text-highlight rules (F9 -> Text highlight rules). The two built-in
 *  regex rules are always listed first and cannot be deleted, mask rules are
 *  user-added. color null = theme token (--cm-date / --cm-special), like the
 *  Selection/Accent pickers. */
export interface BuiltinRule {
  on: boolean;
  color: string | null;
  bold: boolean;
}

/** mask: * and ? wildcards, several separated by , ; or space */
export interface MaskRule {
  id: string;
  mask: string;
  color: string;
  bold?: boolean;
}

export interface EditorColors {
  dates: BuiltinRule;
  special: BuiltinRule;
  masks: MaskRule[];
}

let ruleSeq = 0;
const nextId = () => `t${Date.now().toString(36)}${(ruleSeq++).toString(36)}`;

function defaults(): EditorColors {
  return {
    dates: { on: true, color: null, bold: true },
    special: { on: true, color: null, bold: false },
    masks: [],
  };
}

/** mask list -> one case-insensitive UNanchored global regex: every occurrence
 *  is highlighted. `.` never crosses a line break, so * stays within a line.
 *  (null = empty/invalid mask) */
export function compileTextMask(mask: string): RegExp | null {
  const parts = mask.split(/[,;\s]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const src = parts
    .map((p) =>
      p.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."),
    )
    .join("|");
  try {
    return new RegExp(`(?:${src})`, "gi");
  } catch {
    return null;
  }
}

class TextColorsStore {
  s = $state<EditorColors>(defaults());
  matchers = $derived(
    this.s.masks
      .map((r) => ({ re: compileTextMask(r.mask), color: r.color, bold: !!r.bold }))
      .filter((m): m is { re: RegExp; color: string; bold: boolean } => m.re !== null),
  );
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  async init() {
    let saved: Partial<EditorColors> | null = null;
    try {
      saved = await loadJson<Partial<EditorColors>>("editor-colors.json");
    } catch {
      // no backend (browser preview) or no saved file yet
    }
    const d = defaults();
    const s: EditorColors = saved
      ? {
          dates: { ...d.dates, ...saved.dates },
          special: { ...d.special, ...saved.special },
          masks: Array.isArray(saved.masks) ? saved.masks : [],
        }
      : d;
    this.apply(s, false);
  }

  private apply(s: EditorColors, persist = true) {
    this.s = s;
    if (!persist) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      saveJson("editor-colors.json", this.s).catch(() => {});
    }, 300);
  }

  setBuiltin(kind: "dates" | "special", patch: Partial<BuiltinRule>) {
    this.apply({ ...this.s, [kind]: { ...this.s[kind], ...patch } });
  }

  addMask() {
    this.apply({ ...this.s, masks: [...this.s.masks, { id: nextId(), mask: "", color: "#F97316" }] });
  }

  updateMask(id: string, patch: Partial<Omit<MaskRule, "id">>) {
    this.apply({ ...this.s, masks: this.s.masks.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  }

  removeMask(id: string) {
    this.apply({ ...this.s, masks: this.s.masks.filter((r) => r.id !== id) });
  }

  reset() {
    this.apply(defaults());
  }
}

export const textColors = new TextColorsStore();
