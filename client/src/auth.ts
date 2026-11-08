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
 * credential.
 *
 * The browser build has neither a loopback receiver nor a keychain. Where its
 * auth server offers web sign-in (`web` in GET /providers), OAuth runs as a
 * page navigation through the server (`/web/login`) and comes back as a
 * handoff code, and the refresh token never reaches script at all: it is an
 * HttpOnly cookie on the auth server, traded for JWTs through `/web/*`
 * ({@link webSessionFetch}). Its sessions carry no `refreshToken`.
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
  /** `null` in the browser build, whose refresh token is the auth server's
   *  HttpOnly cookie. */
  refreshToken: string | null;
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

/** A login either yields a full session, or (for a first-time user who
 *  belongs to no org yet) a short-lived provisional token that `POST /orgs`
 *  upgrades once the user names their organization. */
export type OAuthResult =
  | { kind: "session"; session: AuthSession }
  | { kind: "pending_org"; provisionalToken: string };

/** What every session-minting endpoint answers with (`/token`,
 *  `/email/verify`, `/handoff`); the login ones may answer the org-setup
 *  handoff instead. */
interface SessionPayload {
  token?: string;
  refresh_token?: string;
  pending?: string;
  provisional_token?: string;
}

/** Turn a session payload into an {@link AuthSession}, refusing anything
 *  short of a decodable JWT plus — under Tauri — its refresh token. */
function sessionFromPayload(data: SessionPayload): AuthSession {
  const claims = data.token ? decodeClaims(data.token) : null;
  if (!data.token || !claims || (isTauri() && !data.refresh_token)) {
    throw new Error("auth backend returned a malformed token");
  }
  return { token: data.token, claims, refreshToken: isTauri() ? data.refresh_token ?? null : null };
}

/**
 * A call that reads or sets the browser build's session cookie (`/web/*`).
 * One at a time across this origin's tabs: each rotates the single-use
 * refresh token behind the cookie, and a second call sent alongside would
 * carry the token the first one spent.
 */
async function webSessionFetch(
  authBase: string,
  path: string,
  body: unknown,
  bearer?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return await navigator.locks.request("hiroba-web-session", () =>
    fetch(authEndpoint(authBase, path), {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/** Browser build: leave for the provider through the auth server. The page
 *  comes back with `#handoff=` or `#setup=` (deeplink.ts). */
export function startWebLogin(authBase: string, provider: Provider): void {
  window.location.assign(authEndpoint(authBase, `/web/login/${provider}`));
}

/** Session or org-setup handoff, as the login endpoints answer. */
function loginResult(data: SessionPayload): OAuthResult {
  if (data.pending === "org_setup") {
    if (!data.provisional_token) {
      throw new Error("auth backend returned a malformed pending response");
    }
    return { kind: "pending_org", provisionalToken: data.provisional_token };
  }
  return { kind: "session", session: sessionFromPayload(data) };
}

/**
 * Run the full OAuth dance via the Tauri shell. Resolves once the user has
 * finished the browser consent and the backend has minted a Hiroba JWT —
 * or handed back the org-setup handoff.
 */
export async function oauthLogin(authBase: string, provider: Provider): Promise<OAuthResult> {
  return loginResult(await invoke<SessionPayload>("oauth_login", { authBase, provider }));
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
const GUEST_LOGIN_TIMEOUT_MS = 12_000;

export class CodeRejectedError extends Error {
  constructor() {
    super("code invalid or expired");
    this.name = "CodeRejectedError";
  }
}

/** Thrown when the backend refused the invite behind a guest entry (HTTP
 *  409): revoked or expired, as opposed to a request that never landed. */
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
 * first-time user who belongs to no org gets the org-setup handoff instead.
 * The browser build's answer is a handoff code, which it collects into its
 * session cookie.
 */
export async function emailVerify(
  authBase: string,
  email: string,
  code: string,
): Promise<OAuthResult> {
  const resp = await fetch(authEndpoint(authBase, isTauri() ? "/email/verify" : "/web/email/verify"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (resp.status === 401) throw new CodeRejectedError();
  if (!resp.ok) throw new Error(await resp.text());
  const data: SessionPayload & { handoff?: string } = await resp.json();
  if (data.handoff) return { kind: "session", session: await redeemHandoff(authBase, data.handoff) };
  return loginResult(data);
}

// ---------------------------------------------------------------------------
// Web sign-in handoff (hiroba://auth/<code>)
// ---------------------------------------------------------------------------

/** Thrown when the backend refused the handoff code (HTTP 401): unknown,
 *  already redeemed, or expired. The membership behind it still exists, so
 *  the fix is an ordinary sign-in, not a new link. */
export class HandoffRejectedError extends Error {
  constructor() {
    super("handoff code invalid, used, or expired");
    this.name = "HandoffRejectedError";
  }
}

/**
 * Redeem the single-use code a web sign-in parked (`POST /handoff`): the
 * invite page's "open in Hiroba" link, or — in the browser build, through
 * `/web/handoff` into its session cookie — its "continue in the browser" and
 * the build's own sign-in. Trades it for the session the app would have
 * minted itself.
 */
export async function redeemHandoff(authBase: string, code: string): Promise<AuthSession> {
  const resp = isTauri()
    ? await fetch(authEndpoint(authBase, "/handoff"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      })
    : await webSessionFetch(authBase, "/web/handoff", { code });
  if (resp.status === 401) throw new HandoffRejectedError();
  if (!resp.ok) throw new Error(await resp.text());
  return sessionFromPayload(await resp.json());
}

const LS_GUEST_ID = "hiroba_guest_id";

/**
 * This browser's guest identity: a random id minted once and kept. A guest
 * session lasts an hour and is re-minted on every connect; the id is what
 * makes those the same guest, so a note they pinned is still theirs.
 */
export function loadGuestId(): string {
  let id = localStorage.getItem(LS_GUEST_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(LS_GUEST_ID, id);
  }
  return id;
}

/**
 * Browser guest entry: an invite link, a display name and this browser's
 * guest id ({@link loadGuestId}) buy a session for the invite's org
 * (`POST /guest`) — no account, no refresh token. Any unexpired invite works,
 * consumed or not; a 409 means it expired or the admin revoked it.
 */
export async function guestLogin(
  authBase: string,
  invite: string,
  name: string,
  guestId: string,
  signal?: AbortSignal,
): Promise<AuthSession> {
  // Bounded like the ICE and WebSocket steps that follow it: a request left
  // hanging here would hold a reconnect in "connecting" for good.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GUEST_LOGIN_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  let resp: Response;
  try {
    resp = await fetch(authEndpoint(authBase, "/guest"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invite, name, guestId }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abort);
  }
  if (resp.status === 409) throw new InviteRejectedError();
  if (!resp.ok) throw new Error(await resp.text());
  const data: { token?: string } = await resp.json();
  const claims = data.token ? decodeClaims(data.token) : null;
  if (!data.token || !claims) throw new Error("auth backend returned a malformed token");
  return { token: data.token, claims, refreshToken: "" };
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
 * Normalize an invite as the browser client receives it (`?invite=`): either a
 * bare invite code or a shared link of the form `https://<auth-server>/invite/<token>`.
 */
export function extractInviteCode(raw: string): string {
  const m = /\/invite\/([A-Za-z0-9_-]+)\/?$/.exec(raw.trim());
  return m ? m[1] : raw.trim();
}

/** The shareable form of an invite token: the auth server's landing page,
 *  where the invitee signs in and joins. */
export function inviteLinkUrl(authBase: string, token: string): string {
  return `${authBase}/invite/${token}`;
}

/**
 * Parse a `hiroba://auth/<code>` deep link (the "open in Hiroba" button the
 * invite page shows once the invitee has signed in there). Returns the
 * handoff code, or null for any other URL. The charset/length bound mirrors
 * the auth server's code guard.
 */
export function parseAuthDeepLink(url: string): string | null {
  const m = /^hiroba:\/\/auth\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.trim());
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Org membership (multi-org sessions switch by re-issuing the refresh token)
// ---------------------------------------------------------------------------

/** One org the signed-in user belongs to (mirrors GET /orgs). */
export interface OrgSummary {
  slug: string;
  name: string;
  role: string;
}

/** The session's memberships, most recently used first. */
export async function listOrgs(authBase: string, token: string): Promise<OrgSummary[]> {
  const resp = await fetch(authEndpoint(authBase, "/orgs"), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`org list refused with HTTP ${resp.status}`);
  const data: { orgs?: OrgSummary[] } = await resp.json();
  if (!Array.isArray(data.orgs)) throw new Error("org list response malformed");
  return data.orgs;
}

/**
 * Re-anchor the session in another org the user belongs to. The refresh token
 * is the thing that actually moves — the backend rotates it under the new org
 * and mints a matching JWT. Throws on any failure, and only a success consumes
 * the old refresh token, so the caller's current session stays valid.
 */
export async function switchOrg(
  authBase: string,
  session: AuthSession,
  orgSlug: string,
): Promise<AuthSession> {
  const resp = session.refreshToken
    ? await fetch(authEndpoint(authBase, "/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refreshToken, org: orgSlug }),
      })
    : await webSessionFetch(authBase, "/web/session", { org: orgSlug });
  if (!resp.ok) throw new Error(`org switch refused with HTTP ${resp.status}`);
  return sessionFromPayload(await resp.json());
}

/** Thrown when `POST /orgs` refuses (the status says why: 401 is a token
 *  that has run out). */
export class OrgCreateRefusedError extends Error {
  constructor(readonly status: number) {
    super(`org creation refused with HTTP ${status}`);
    this.name = "OrgCreateRefusedError";
  }
}

/** Found an org with `token` (a pending sign-in's provisional token, or a
 *  member's session) and get the session in it. */
export async function createOrg(
  authBase: string,
  token: string,
  body: Record<string, string>,
): Promise<AuthSession> {
  const resp = isTauri()
    ? await fetch(authEndpoint(authBase, "/orgs"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
    : await webSessionFetch(authBase, "/web/orgs", body, token);
  if (!resp.ok) throw new OrgCreateRefusedError(resp.status);
  return sessionFromPayload(await resp.json());
}

// ---------------------------------------------------------------------------
// Session persistence (keychain under Tauri)
// ---------------------------------------------------------------------------

const KEYCHAIN_KEY = "session-token";
const REFRESH_KEYCHAIN_KEY = "refresh-token";
let loadingSession: Promise<RestoreResult> | null = null;

/**
 * Keychain mutations run one at a time, in call order. Signing out while a save
 * is in flight otherwise races it, and the loser decides what the next launch
 * finds: a sign-out the user asked for explicitly must be the write that lasts.
 */
let keychainQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  // Both arms, so one failed op doesn't wedge the queue behind it.
  const run = keychainQueue.then(op, op);
  keychainQueue = run.catch(() => undefined);
  return run;
}

/**
 * Bumped, synchronously, by every sign-out and by every session adopted from
 * elsewhere (a sign-in, a web handoff, an org switch). A renewal in flight at
 * that moment is answering for a session the user has since discarded or
 * replaced: writing its rotated tokens back would un-sign-them-out, or put
 * the previous org back in the keychain so the next launch opens there — so
 * a restore that spans either must come back empty-handed instead.
 */
let sessionEpoch = 0;

/** A session obtained some other way now stands: a restore still in flight
 *  must neither be adopted nor persisted. Synchronous, like a sign-out. */
export function supersedeRestore(): void {
  sessionEpoch += 1;
}

/**
 * Why a restore couldn't hand back a *usable* session. Both mean "try again
 * later", not "sign in again":
 *
 *   - `keychain` — the OS store refused us (denied ACL, locked keychain), or
 *     refused to take a renewed session. What is stored may be perfectly good;
 *     we simply couldn't read/write it.
 *   - `network` — a stored session is present but its 12h JWT has expired, and
 *     the auth server wasn't reachable to renew it. The caller still gets the
 *     stale session: the user *is* signed in, just not right now. (The browser
 *     build stores nothing it could hand back, so it gets `null` with this.)
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
  loadingSession = (isTauri() ? restoreSession : restoreWebSession)(authUrl).finally(() => {
    loadingSession = null;
  });
  return loadingSession;
}

async function restoreSession(authUrl: string): Promise<RestoreResult> {
  const epoch = sessionEpoch;
  /** True once a sign-out has overtaken this restore. */
  const abandoned = () => epoch !== sessionEpoch;

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
  if (abandoned() || !token || !refreshToken) return { session: null };
  const claims = decodeClaims(token);
  if (!claims) {
    await clearSession(authUrl);
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
    await clearSession(authUrl);
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
  // Signed out while the renewal was in flight: these tokens belong to a
  // session that no longer exists. Storing them would resurrect it on the next
  // launch, and handing them back would put the signed-in chip on screen again.
  if (abandoned()) return { session: null };
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

/** The browser build's restore: its session cookie, traded for a fresh JWT
 *  (and rotated) on every launch. 401 is signed out; anything else that keeps
 *  the answer away is a bad moment for the network, as for the app. */
async function restoreWebSession(authUrl: string): Promise<RestoreResult> {
  const epoch = sessionEpoch;
  let session: AuthSession;
  try {
    const resp = await webSessionFetch(authUrl, "/web/session", {});
    if (resp.status === 401) return { session: null };
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    session = sessionFromPayload(await resp.json());
  } catch (err) {
    console.warn("hiroba: could not renew the browser session", err);
    return { session: null, problem: "network" };
  }
  // Signed out (or signed in some other way) meanwhile: not ours to adopt.
  return epoch === sessionEpoch ? { session } : { session: null };
}

/** `skipped` = the browser build, whose session is the auth server's cookie. */
export type SaveOutcome = "saved" | "skipped" | "failed";

/** Persist a session to the OS keychain. Never throws: a device that can't
 *  store credentials should cost the user their *next* launch, not this
 *  sign-in. */
export async function saveSession(session: AuthSession): Promise<SaveOutcome> {
  if (!isTauri()) return "skipped";
  try {
    await enqueue(() =>
      Promise.all([
        invoke("secret_save", { key: KEYCHAIN_KEY, value: session.token }),
        invoke("secret_save", { key: REFRESH_KEYCHAIN_KEY, value: session.refreshToken }),
      ]),
    );
    return "saved";
  } catch (err) {
    console.warn("hiroba: could not save the session to the keychain", err);
    return "failed";
  }
}

/** Forget the stored session. Queued behind any save already running, so an
 *  explicit sign-out is never the write that loses the race. The browser
 *  build's sign-out happens on the auth server, which revokes the cookie's
 *  refresh token and drops the cookie. */
export async function clearSession(authBase: string): Promise<void> {
  // Before the first await: an in-flight renewal has to see this immediately,
  // or it will happily write its answer in after the delete.
  supersedeRestore();
  if (!isTauri()) {
    const resp = await webSessionFetch(authBase, "/web/signout", {});
    if (!resp.ok) throw new Error(`sign-out refused with HTTP ${resp.status}`);
    return;
  }
  try {
    await enqueue(() =>
      Promise.all([
        invoke("secret_delete", { key: KEYCHAIN_KEY }),
        invoke("secret_delete", { key: REFRESH_KEYCHAIN_KEY }),
      ]),
    );
  } catch {
    /* nothing to clear */
  }
}
