/// <reference types="vite/client" />

/**
 * Build-time environment variables injected by Vite (see `ui.ts`).
 * `VITE_HIROBA_SERVER` / `VITE_HIROBA_AUTH_SERVER` bake the production
 * signaling / auth URLs into a distribution build. Both are REQUIRED for
 * `vite build` (enforced in vite.config.ts); only `vite dev` may omit them
 * (loopback fallback).
 */
interface ImportMetaEnv {
  readonly VITE_HIROBA_SERVER?: string;
  readonly VITE_HIROBA_AUTH_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
