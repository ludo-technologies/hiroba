import { defineConfig } from "vite";

// Vite config tuned for Tauri: fixed dev port, no auto-open, build to ../dist.
export default defineConfig({
  root: ".",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    emptyOutDir: true,
  },
});
