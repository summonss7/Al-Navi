import { dictionaries, LOCALES, type Locale } from "$lib/i18n/dictionaries";

export type { Locale };
export { LOCALES };

class I18n {
  locale = $state<Locale>("en");

  get dir(): "ltr" | "rtl" {
    return LOCALES.find((l) => l.id === this.locale)?.dir ?? "ltr";
  }

  setLocale(l: Locale) {
    this.locale = l;
    document.documentElement.lang = l;
    document.documentElement.dir = this.dir;
  }

  /** translate with {placeholder} interpolation */
  t(key: string, params?: Record<string, string | number>): string {
    let s =
      dictionaries[this.locale]?.[key] ?? dictionaries.en[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        s = s.replaceAll(`{${k}}`, String(v));
      }
    }
    return s;
  }
}

export const i18n = new I18n();
