/**
 * auth.ts — client side of the interactive login (AUTH_PLAN §2/§2.1/§6).
 *
 * Two ways in, both ending at the same Hiroba JWT:
 *
 *   - **OAuth** (Google / GitHub): the heavy lifting — PKCE, loopback listener,
 *     system browser, code→JWT exchange — happens in the Tauri shell
 *     (`src-tauri/src/oauth.rs`); this module is the thin webview-side wrapper.
 *   - **E-mail code**: two plain fetches ({@link emailStart}, {@link emailVerify}).
 *     No browser round-trip and no shell involvement, so the user never leaves
 *     the app.
 *
 * Plus session-token persistence: under Tauri the JWT lives in the **OS
 * keychain** via the `secret_*` commands — localStorage never holds a
 * credential. In a plain browser (vite dev / web build) there is neither a
 * loopback receiver nor a keychain, so the login block is hidden entirely and
 * the manual token field in the join form remains the fallback there.
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
  refreshToken: string;
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
    refresh_token?: string;
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
  if (!result.token || !result.refresh_token || !claims) {
    throw new Error("auth backend returned a malformed token");
  }
  return {
    kind: "session",
    session: { token: result.token, claims, refreshToken: result.refresh_token },
  };
}

// ---------------------------------------------------------------------------
// E-mail one-time-code login
// ---------------------------------------------------------------------------

/** Thrown when the backend refuses another code for a while (HTTP 429). */
export class CodeThrottledError extends Error {
  constructor(readonly retryAfterSecs: number) {
    super(`another code may be requested in ${retryAfterSecs}s`);
    this.name = "CodeThrottledError";
  }
}

/** Thrown when the backend rejects the code itself (HTTP 401) — as opposed to
 *  the request never arriving, which must not be reported as a bad code. */
export class CodeRejectedError extends Error {
  constructor() {
    super("code invalid or expired");
    this.name = "CodeRejectedError";
  }
}

/** Thrown when the *invite* is what the backend refused (HTTP 409). The code
 *  itself was fine — and, because the backend checks the invite first, still
 *  unspent — so sending the user hunting for a new code would be wrong. */
export class InviteRejectedError extends Error {
  constructor() {
    super("invite invalid, used, or expired");
    this.name = "InviteRejectedError";
  }
}

/** Digits in a login code — mirrors the backend's CODE_DIGITS. */
export const CODE_LENGTH = 6;

/** Fallback wait when a 429 arrives without a usable Retry-After header. */
const DEFAULT_RETRY_AFTER_SECS = 60;

function authEndpoint(authBase: string, path: string): string {
  return `${authBase.replace(/\/+$/, "")}${path}`;
}

/**
 * Ask the backend to mail a login code. Resolves with the code itself only in
 * a dev backend (`HIROBA_AUTH_DEV=1`), which skips delivery — production
 * responses carry nothing but an acknowledgement.
 */
export async function emailStart(
  authBase: string,
  email: string,
  locale: string,
): Promise<{ devCode?: string }> {
  const resp = await fetch(authEndpoint(authBase, "/email/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, locale }),
  });
  if (resp.status === 429) {
    const header = Number(resp.headers.get("Retry-After"));
    throw new CodeThrottledError(
      Number.isFinite(header) && header > 0 ? Math.ceil(header) : DEFAULT_RETRY_AFTER_SECS,
    );
  }
  if (!resp.ok) throw new Error(await resp.text());
  const data: { dev_code?: string } = await resp.json();
  return { devCode: data.dev_code };
}

/**
 * Trade a mailed code for a session. Mirrors {@link oauthLogin}'s result: a
 * first-time user without an invite gets the org-setup handoff instead.
 */
export async function emailVerify(
  authBase: string,
  email: string,
  code: string,
  invite?: string,
): Promise<OAuthResult> {
  const resp = await fetch(authEndpoint(authBase, "/email/verify"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code, invite: invite || null }),
  });
  if (resp.status === 401) throw new CodeRejectedError();
  if (resp.status === 409) throw new InviteRejectedError();
  if (!resp.ok) throw new Error(await resp.text());
  const data: {
    token?: string;
    refresh_token?: string;
    pending?: string;
    provisional_token?: string;
  } = await resp.json();
  if (data.pending === "org_setup") {
    if (!data.provisional_token) {
      throw new Error("auth backend returned a malformed pending response");
    }
    return { kind: "pending_org", provisionalToken: data.provisional_token };
  }
  const claims = data.token ? decodeClaims(data.token) : null;
  if (!data.token || !data.refresh_token || !claims) {
    throw new Error("auth backend returned a malformed token");
  }
  return {
    kind: "session",
    session: { token: data.token, claims, refreshToken: data.refresh_token },
  };
}

/** Keep only the digits a code is made of, so pasted text ("code: 012 345")
 *  still lands in the field. */
export function sanitizeCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
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
const REFRESH_KEYCHAIN_KEY = "refresh-token";
let loadingSession: Promise<RestoreResult> | null = null;

/**
 * Why a restore couldn't hand back a *usable* session. Both mean "try again
 * later", not "sign in again":
 *
 *   - `keychain` — the OS store refused us (denied ACL, locked keychain), or
 *     refused to take a renewed session. What is stored may be perfectly good;
 *     we simply couldn't read/write it.
 *   - `network` — a stored session is present but its 12h JWT has expired, and
 *     the auth server wasn't reachable to renew it. The caller still gets the
 *     stale session: the user *is* signed in, just not right now.
 *
 * A genuinely signed-out user carries no problem at all — only then is the
 * sign-in form the honest thing to show.
 */
export type RestoreProblem = "keychain" | "network";

export interface RestoreResult {
  /** The stored session, renewed if it needed renewing. Null only when there
   *  is nothing to restore (or the keychain wouldn't say). May be stale —
   *  check {@link isLive} — when `problem` is `network`. */
  session: AuthSession | null;
  /** Advisory: `session` is still whatever we could salvage. */
  problem?: RestoreProblem;
}

/** Restore a saved session, refreshing its short-lived JWT when necessary. */
export function loadSession(authUrl: string): Promise<RestoreResult> {
  if (loadingSession) return loadingSession;
  loadingSession = restoreSession(authUrl).finally(() => {
    loadingSession = null;
  });
  return loadingSession;
}

async function restoreSession(authUrl: string): Promise<RestoreResult> {
  if (!isTauri()) return { session: null };

  let token: string | null;
  let refreshToken: string | null;
  try {
    [token, refreshToken] = await Promise.all([
      invoke<string | null>("secret_load", { key: KEYCHAIN_KEY }),
      invoke<string | null>("secret_load", { key: REFRESH_KEYCHAIN_KEY }),
    ]);
  } catch (err) {
    console.warn("hiroba: could not read the session from the keychain", err);
    return { session: null, problem: "keychain" };
  }
  if (!token || !refreshToken) return { session: null };
  const claims = decodeClaims(token);
  if (!claims) {
    await clearSession();
    return { session: null };
  }
  const stored: AuthSession = { token, claims, refreshToken };
  if (isLive(claims)) return { session: stored };

  // Past here the JWT needs renewing. Only an outright 401 means the session is
  // gone; every other outcome is a bad moment for the network or the server,
  // and dropping the user for one would cost them a sign-in they don't owe.
  let resp: Response;
  try {
    resp = await fetch(`${authUrl.replace(/\/$/, "")}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (err) {
    console.warn("hiroba: auth server unreachable while renewing the session", err);
    return { session: stored, problem: "network" };
  }
  if (resp.status === 401) {
    await clearSession();
    return { session: null };
  }
  if (!resp.ok) {
    console.warn(`hiroba: session renewal refused with HTTP ${resp.status}`);
    return { session: stored, problem: "network" };
  }
  let data: { token?: string; refresh_token?: string };
  try {
    data = await resp.json();
  } catch {
    return { session: stored, problem: "network" };
  }
  const refreshedClaims = data.token ? decodeClaims(data.token) : null;
  if (!data.token || !data.refresh_token || !refreshedClaims) {
    return { session: stored, problem: "network" };
  }
  const session: AuthSession = {
    token: data.token,
    claims: refreshedClaims,
    refreshToken: data.refresh_token,
  };
  // The refresh token we just spent is single-use, so a save that fails leaves
  // nothing restorable for the next launch — the caller should say so rather
  // than let the user discover it tomorrow.
  const saved = await saveSession(session);
  return saved === "failed" ? { session, problem: "keychain" } : { session };
}

/** `skipped` = a plain-browser build, which persists nothing by design. */
export type SaveOutcome = "saved" | "skipped" | "failed";

/** Persist a session to the OS keychain. Never throws: a device that can't
 *  store credentials should cost the user their *next* launch, not this
 *  sign-in. */
export async function saveSession(session: AuthSession): Promise<SaveOutcome> {
  if (!isTauri()) return "skipped";
  try {
    await Promise.all([
      invoke("secret_save", { key: KEYCHAIN_KEY, value: session.token }),
      invoke("secret_save", { key: REFRESH_KEYCHAIN_KEY, value: session.refreshToken }),
    ]);
    return "saved";
  } catch (err) {
    console.warn("hiroba: could not save the session to the keychain", err);
    return "failed";
  }
}

export async function clearSession(): Promise<void> {
  if (!isTauri()) return;
  try {
    await Promise.all([
      invoke("secret_delete", { key: KEYCHAIN_KEY }),
      invoke("secret_delete", { key: REFRESH_KEYCHAIN_KEY }),
    ]);
  } catch {
    /* nothing to clear */
  }
}
