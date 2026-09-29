// F11 plugin registry. A plugin is a named action list; opening the menu in
// a mode shows the plugins registered for it. The first plugin is the change
// case tool for the editor selection.

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
];
