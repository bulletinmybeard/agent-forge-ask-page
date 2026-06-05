/**
 * Main Vite build: background service worker (ESM) + popup + sidepanel.
 * The content script needs IIFE format and is built separately by
 * `vite.content.config.ts` so MV3 can run it as a classic script.
 *
 * `root: "src"` keeps HTML outputs at the dist root (not `dist/src/...`).
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  root: "src",
  build: {
    outDir: "../dist",
    // Don't wipe what the content-script build wrote (and vice versa).
    emptyOutDir: false,
    sourcemap: mode === "development",
    target: "esnext",
    minify: mode === "production",
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        popup: resolve(__dirname, "src/popup.html"),
        sidepanel: resolve(__dirname, "src/sidepanel.html"),
        options: resolve(__dirname, "src/options.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  plugins: [
    {
      name: "wibt-copy-manifest",
      writeBundle() {
        mkdirSync(resolve(__dirname, "dist"), { recursive: true });
        copyFileSync(
          resolve(__dirname, "src/manifest.json"),
          resolve(__dirname, "dist/manifest.json"),
        );
      },
    },
  ],
}));
