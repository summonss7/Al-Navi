// F11 plugin registry. A plugin is a named action list; opening the menu in
// a mode shows the plugins registered for it. First come the change case and
// the keyboard layout tools for the editor selection.

/** case transformation modes of the "change case" plugin */
export type CaseMode = "sentence" | "lower" | "upper" | "title";

export function transformCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case "lower":
      return text.toLowerCase();
    case "upper":
      return text.toUpperCase();
    case "sentence":
      // first letter of the text and the first letter after . ! ? … go upper,
      // everything else lower (\p{L} keeps it working for Cyrillic too)
      return text
        .toLowerCase()
        .replace(/(^|[.!?…]\s*)(\p{L})/gu, (m, p1: string, p2: string) => p1 + p2.toUpperCase());
    case "title":
      // every word starts with a capital, the rest of the word is lowercased
      return text.replace(
        /\p{L}[\p{L}\p{M}'’-]*/gu,
        (w) => w[0].toUpperCase() + w.slice(1).toLowerCase(),
      );
  }
}

export interface PluginMode {
  id: string;
  labelKey: string;
}

export interface PluginEntry {
  id: string;
  titleKey: string;
  icon: string;
  modes: PluginMode[];
}

/** layout conversion modes of the "layout" plugin */
export type LayoutMode = "auto" | "toCyr" | "toLat";

/** ЙЦУКЕН letters of the 26 Latin letter keys (lowercase pairs). */
const CYR_OF_LAT: Record<string, string> = {
  q: "й", w: "ц", e: "у", r: "к", t: "е", y: "н", u: "г", i: "ш", o: "щ", p: "з",
  a: "ф", s: "ы", d: "в", f: "а", g: "п", h: "р", j: "о", k: "л", l: "д",
  z: "я", x: "ч", c: "с", v: "м", b: "и", n: "т", m: "ь",
};

/** Latin keys of every Cyrillic letter. The seven letters that live on
 *  punctuation keys (ё х ъ ж э б ю) map to those EN key chars, so the
 *  direction is intentionally asymmetric: Latin→Cyrillic converts letters
 *  only (a typed "," stays a comma, it is not a "б"), while Cyrillic→Latin
 *  converts all 33 letters ("б" really did come from the "," key). */
const LAT_OF_CYR: Record<string, string> = Object.fromEntries(
  Object.entries(CYR_OF_LAT).map(([lat, cyr]) => [cyr, lat]),
);
Object.assign(LAT_OF_CYR, { ё: "`", х: "[", ъ: "]", ж: ";", э: "'", б: ",", ю: "." });

/** Convert text between the Latin and the ЙЦУКЕН layout — letters only,
 *  punctuation is never touched. "auto" picks the direction by the majority
 *  of letters in the text (a tie goes to Cyrillic: fixing "Ghbdtn"-style
 *  gibberish is the common case). */
export function convertLayout(text: string, mode: LayoutMode): string {
  if (mode === "toLat") {
    return text.replace(/[а-яё]/gi, (ch) => mapChar(ch, LAT_OF_CYR));
  }
  if (mode === "toCyr") {
    return text.replace(/[a-z]/gi, (ch) => mapChar(ch, CYR_OF_LAT));
  }
  const lat = (text.match(/[a-z]/gi) ?? []).length;
  const cyr = (text.match(/[а-яё]/gi) ?? []).length;
  return convertLayout(text, cyr > lat ? "toLat" : "toCyr");
}

function mapChar(ch: string, table: Record<string, string>): string {
  const mapped = table[ch.toLowerCase()];
  if (!mapped) return ch;
  return ch === ch.toUpperCase() ? mapped.toUpperCase() : mapped;
}

/** plugins available in the editor (F11) */
export const EDITOR_PLUGINS: PluginEntry[] = [
  {
    id: "case",
    titleKey: "plug.case",
    icon: "ph-text-aa",
    modes: [
      { id: "sentence", labelKey: "plug.case.sentence" },
      { id: "lower", labelKey: "plug.case.lower" },
      { id: "upper", labelKey: "plug.case.upper" },
      { id: "title", labelKey: "plug.case.title" },
    ],
  },
  {
    id: "layout",
    titleKey: "plug.layout",
    icon: "ph-keyboard",
    modes: [
      { id: "auto", labelKey: "plug.layout.auto" },
      { id: "toCyr", labelKey: "plug.layout.toCyr" },
      { id: "toLat", labelKey: "plug.layout.toLat" },
    ],
  },
];
