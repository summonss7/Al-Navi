import { loadJson, saveJson } from "$lib/api";
import { COLOR_GROUPS } from "$lib/fileIcons";

export interface ColorRule {
  id: string;
  /** file-name masks: * and ? wildcards, several separated by , ; or space */
  mask: string;
  color: string;
}

let ruleSeq = 0;
const nextId = () => `r${Date.now().toString(36)}${(ruleSeq++).toString(36)}`;

function defaultRules(): ColorRule[] {
  return COLOR_GROUPS.map((g) => ({
    id: nextId(),
    mask: g.exts.map((e) => "*." + e).join(", "),
    color: g.color,
  }));
}

/** mask list -> one case-insensitive full-match regex (null = empty/invalid) */
function compileMask(mask: string): RegExp | null {
  const parts = mask.split(/[,;\s]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const src = parts
    .map((p) =>
      p.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."),
    )
    .join("|");
  try {
    return new RegExp(`^(?:${src})$`, "i");
  } catch {
    return null;
  }
}

class FileColorsStore {
  rules = $state<ColorRule[]>([]);
  private matchers = $derived(
    this.rules
      .map((r) => ({ re: compileMask(r.mask), color: r.color }))
      .filter((m): m is { re: RegExp; color: string } => m.re !== null),
  );
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  async init() {
    let saved: ColorRule[] | null = null;
    try {
      saved = await loadJson<ColorRule[]>("file-colors.json");
    } catch {
      // no backend (browser preview) or no saved file yet
    }
    this.apply(saved && saved.length ? saved : defaultRules(), false);
  }

  private apply(rules: ColorRule[], persist = true) {
    this.rules = rules;
    if (!persist) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      saveJson("file-colors.json", this.rules).catch(() => {});
    }, 300);
  }

  update(id: string, patch: Partial<Omit<ColorRule, "id">>) {
    this.apply(this.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  add() {
    this.apply([...this.rules, { id: nextId(), mask: "*.", color: "#F97316" }]);
  }

  remove(id: string) {
    this.apply(this.rules.filter((r) => r.id !== id));
  }

  reset() {
    this.apply(defaultRules());
  }

  /** color of the first rule whose mask matches the name (null = default fg);
   *  callers skip directories — only file names are highlighted */
  colorFor(name: string): string | null {
    for (const m of this.matchers) {
      if (m.re.test(name)) return m.color;
    }
    return null;
  }
}

export const fileColors = new FileColorsStore();
