import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath, URL } from "node:url";

// WebView2 (Chromium) always takes the first @font-face format it supports —
// woff2 in every font we ship — so the woff/ttf/svg fallbacks that
// @phosphor-icons/web and @fontsource declare next to it are never requested.
// vite still copies every url() target into dist/assets and Tauri embeds the
// whole dist into the exe (~7 MB of dead Phosphor weight alone). Trimming each
// @font-face src list to its woff2 entry at the postcss stage — before vite
// collects url() assets — keeps those files out of dist entirely. Dev serves
// the same woff2-only CSS, which is all the browser ever loaded anyway.
const woff2OnlyPostcss = {
  postcssPlugin: "alnavi-font-woff2-only",
  Declaration(decl: { prop: string; value: string }) {
    if (decl.prop !== "src") return;
    const entries = decl.value.split(",");
    const woff2 = entries.filter((part) => part.includes("woff2"));
    if (woff2.length && woff2.length < entries.length)
      decl.value = woff2.map((part) => part.trim()).join(", ");
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  css: { postcss: { plugins: [woff2OnlyPostcss] } },
  clearScreen: false,
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
      $comp: fileURLToPath(new URL("./src/components", import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
