import { loadJson, saveJson } from "$lib/api";
import { COLOR_GROUPS } from "$lib/fileIcons";

export interface ColorRule {
  id: string;
  /** file-name masks: * and ? wildcards, several separated by , ; or space */
  mask: string;
  color: string;
  /** render the name bold (e.g. the project wishlist promt.txt) */
  bold?: boolean;
}

export interface NameStyle {
  color: string;
  bold: boolean;
}

let ruleSeq = 0;
const nextId = () => `r${Date.now().toString(36)}${(ruleSeq++).toString(36)}`;

/** the wishlist file is a brand default: red bold, ahead of every group rule */
function promtRule(): ColorRule {
  return { id: nextId(), mask: "promt.txt", color: "#EF4444", bold: true };
}

function maskParts(mask: string): string[] {
  return mask
    .split(/[,;\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
}

function defaultRules(): ColorRule[] {
  return [
    promtRule(),
    ...COLOR_GROUPS.map((g) => ({
      id: nextId(),
      mask: g.exts.map((e) => "*." + e).join(", "),
      color: g.color,
    })),
  ];
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
      .map((r) => ({ re: compileMask(r.mask), color: r.color, bold: !!r.bold }))
      .filter((m): m is { re: RegExp; color: string; bold: boolean } => m.re !== null),
  );
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  async init() {
    let saved: ColorRule[] | null = null;
    try {
      saved = await loadJson<ColorRule[]>("file-colors.json");
    } catch {
      // no backend (browser preview) or no saved file yet
    }
    let rules = saved && saved.length ? saved : defaultRules();
    // seed the wishlist highlight: if no rule names promt.txt explicitly, put
    // the brand default first — a bare *.txt rule must not count as covering
    // it (first match wins, and the doc group paints *.txt blue)
    const hasPromt = rules.some((r) => maskParts(r.mask).includes("promt.txt"));
    if (!hasPromt) {
      rules = [promtRule(), ...rules];
    }
    this.apply(rules, false);
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

  /** style of the first rule whose mask matches the name (null = default fg);
   *  callers skip directories — only file names are highlighted */
  styleFor(name: string): NameStyle | null {
    for (const m of this.matchers) {
      if (m.re.test(name)) return { color: m.color, bold: m.bold };
    }
    return null;
  }
}

export const fileColors = new FileColorsStore();
