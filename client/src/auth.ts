/**
 * auth.ts — client side of the interactive OAuth login (AUTH_PLAN §2/§6).
 *
 * The heavy lifting (PKCE, loopback listener, system browser, code→JWT
 * exchange) happens in the Tauri shell (`src-tauri/src/oauth.rs`); this module
 * is the thin webview-side wrapper plus session-token persistence:
 *
 *   - Under Tauri, the Hiroba JWT lives in the **OS keychain** via the
 *     `secret_*` commands — localStorage never holds a credential.
 *   - In a plain browser (vite dev / web build) there is no loopback receiver,
 *     so interactive login is unavailable; the manual token field in the join
 *     form remains the fallback there.
 */

// ---------------------------------------------------------------------------
// Tauri bridge (withGlobalTauri exposes window.__TAURI__)
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
    };
  }
}

/** True when running inside the Tauri shell (login + keychain available). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI__;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = window.__TAURI__;
  if (!tauri) return Promise.reject(new Error("not running under Tauri"));
  return tauri.core.invoke<T>(cmd, args);
}

// ---------------------------------------------------------------------------
// Session shape
// ---------------------------------------------------------------------------

/** Claims of a Hiroba session JWT (mirror of the backend's SessionClaims). */
export interface SessionClaims {
  sub: string;
  org: string;
  org_name: string;
  name: string;
  role: string;
  iat: number;
  exp: number;
}

export interface AuthSession {
  token: string;
  claims: SessionClaims;
}

/** Decode a JWT payload without verifying — the server verifies; we only need
 *  display fields and `exp` for "is this still worth sending". */
export function decodeClaims(token: string): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64);
    // atob yields latin1; JWT payloads are UTF-8 — re-decode properly.
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    return claims as SessionClaims;
  } catch {
    return null;
  }
}

/** True while the token has at least a minute of life left. */
export function isLive(claims: SessionClaims): boolean {
  return claims.exp * 1000 > Date.now() + 60_000;
}

// ---------------------------------------------------------------------------
// Interactive login
// ---------------------------------------------------------------------------

export type Provider = "google" | "github" | "dev";

/** A login either yields a full session, or (for a first-time user with no
 *  invite) a short-lived provisional token that `POST /orgs` upgrades once
 *  the user names their organization. */
export type OAuthResult =
  | { kind: "session"; session: AuthSession }
  | { kind: "pending_org"; provisionalToken: string };

/**
 * Run the full OAuth dance via the Tauri shell. Resolves once the user has
 * finished the browser consent and the backend has minted a Hiroba JWT —
 * or handed back the org-setup handoff.
 */
export async function oauthLogin(
  authBase: string,
  provider: Provider,
  invite?: string,
): Promise<OAuthResult> {
  const result = await invoke<{
    token?: string;
    claims?: SessionClaims;
    pending?: string;
    provisional_token?: string;
  }>("oauth_login", {
    authBase,
    provider,
    invite: invite || null,
  });
  if (result.pending === "org_setup") {
    if (!result.provisional_token) {
      throw new Error("auth backend returned a malformed pending response");
    }
    return { kind: "pending_org", provisionalToken: result.provisional_token };
  }
  const claims = result.token ? decodeClaims(result.token) : null;
  if (!result.token || !claims) {
    throw new Error("auth backend returned a malformed token");
  }
  return { kind: "session", session: { token: result.token, claims } };
}

/**
 * Open an external URL in the OS browser. Under Tauri the webview can't navigate
 * away from the app, so we hand off to the shell's `open_external` command
 * (system browser); in a plain browser a new tab is the equivalent. Used for the
 * Stripe Customer Portal (billing), which must run on Stripe's own page.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    await invoke("open_external", { url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Normalize the invite field: accept either a bare invite code or a shared
 * link of the form `https://<auth-server>/invite/<token>`.
 */
export function extractInviteCode(raw: string): string {
  const m = /\/invite\/([A-Za-z0-9_-]+)\/?$/.exec(raw.trim());
  return m ? m[1] : raw.trim();
}

/**
 * Parse a `hiroba://invite/<token>` deep link (the "open in app" button on
 * the invite landing page). Returns the token, or null for any other URL.
 * The charset/length bound mirrors the auth server's token guard.
 */
export function parseInviteDeepLink(url: string): string | null {
  const m = /^hiroba:\/\/invite\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.trim());
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Session persistence (keychain under Tauri)
// ---------------------------------------------------------------------------

const KEYCHAIN_KEY = "session-token";

/** Restore a previously saved session; drops it if expired or unreadable. */
export async function loadSession(): Promise<AuthSession | null> {
  if (!isTauri()) return null;
  try {
    const token = await invoke<string | null>("secret_load", { key: KEYCHAIN_KEY });
    if (!token) return null;
    const claims = decodeClaims(token);
    if (!claims || !isLive(claims)) {
      await clearSession();
      return null;
    }
    return { token, claims };
  } catch {
    return null;
  }
}

export async function saveSession(session: AuthSession): Promise<void> {
  if (!isTauri()) return;
  await invoke("secret_save", { key: KEYCHAIN_KEY, value: session.token });
}

export async function clearSession(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("secret_delete", { key: KEYCHAIN_KEY });
  } catch {
    /* nothing to clear */
  }
}
