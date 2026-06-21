/// <reference types="vite/client" />

/**
 * Build-time environment variables injected by Vite (see `ui.ts`).
 * `VITE_HIROBA_SERVER` / `VITE_HIROBA_AUTH_SERVER` let a distribution build
 * bake in the production signaling / auth URLs; both are optional (loopback
 * fallback in dev).
 */
interface ImportMetaEnv {
  readonly VITE_HIROBA_SERVER?: string;
  readonly VITE_HIROBA_AUTH_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
