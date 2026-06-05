/**
 * Content-script-only build. MV3 content scripts must be classic
 * (IIFE-bundled) scripts — Chrome doesn't run them as ES modules in
 * the isolated world. Vite's lib mode with `formats: ["iife"]` gives
 * us a self-contained content.js without `export {}` boilerplate.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: mode === "development",
    target: "esnext",
    minify: mode === "production",
    lib: {
      entry: resolve(__dirname, "src/content.ts"),
      name: "wibtContent",
      formats: ["iife"],
      fileName: () => "content.js",
    },
  },
}));
