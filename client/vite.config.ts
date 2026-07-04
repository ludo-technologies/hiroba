import { defineConfig, loadEnv } from "vite";

// Vite config tuned for Tauri: fixed dev port, no auto-open, build to ../dist.
export default defineConfig(({ command, mode }) => {
  // Distribution builds must bake in real server URLs — the bundle deliberately
  // has no loopback fallback (a build that quietly falls back to 127.0.0.1
  // works on a dev machine and breaks for every downloader; see ui.ts).
  // Empty string counts as missing. `vite dev` is exempt.
  if (command === "build") {
    const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
    for (const key of ["VITE_HIROBA_SERVER", "VITE_HIROBA_AUTH_SERVER"]) {
      if (!env[key]) {
        throw new Error(
          `${key} is required for a distribution build so the app points at real servers, e.g.\n` +
            `  VITE_HIROBA_SERVER="wss://hiroba.example/ws" \\\n` +
            `  VITE_HIROBA_AUTH_SERVER="https://auth.hiroba.example" \\\n` +
            `  npm run tauri build\n` +
            `See docs/SELF_HOSTING.md ("Pointing distribution builds at your servers").`,
        );
      }
    }
  }

  return {
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
  };
});
