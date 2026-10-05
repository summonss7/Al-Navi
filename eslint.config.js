import js from "@eslint/js";
import tseslint from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  // Куда не заходим: сборки, чужой архив разовых скриптов, Rust-часть
  { ignores: ["dist/", "builds/", "backups/", "scripts/archive/", "src-tauri/"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs["flat/recommended"],
  prettier,
  ...svelte.configs["flat/prettier"],

  // Svelte-компоненты: скрипты на TS внутри + браузерные глобалы
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { parser: tseslint.parser },
    },
  },

  // Фронтовый TS тоже живёт в браузере (Tauri WebView)
  {
    files: ["src/**/*.{ts,js}"],
    languageOptions: { globals: { ...globals.browser } },
  },

  // Скрипты автоматизации и конфиги — Node
  {
    files: ["scripts/**/*.mjs", "*.config.ts", "tests/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    rules: {
      // Пустые catch — идиома fire-and-forget в e2e-скриптах (invoke без ожидания)
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Прагматика для существующей кодовой базы: любое --warn не ломает `npm run lint`,
      // ошибки уровня error чиним по факту
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Кэши-индексы в панелях/архивах — обычные Map/Set намеренно: они не участвуют
      // в реактивности, перевод на SvelteMap/SvelteSet меняет семантику обновлений
      // (поведенческий рефакторинг, не гигиена стиля)
      "svelte/prefer-svelte-reactivity": "off",
      // Ключи each-блоков меняют гранулярность DOM-обновлений списков панелей —
      // требует анализа стабильности ключа на каждом списке, отложено; предупреждения видны
      "svelte/require-each-key": "warn",
    },
  },
);
