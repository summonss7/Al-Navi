import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath, URL } from "node:url";

// Unit tests of the pure frontend logic ($lib). The svelte plugin is needed
// for the runes modules (*.svelte.ts stores) that the color-mask tests load;
// there is no DOM here — environment "node" keeps the suite fast and honest.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
      $comp: fileURLToPath(new URL("./src/components", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
