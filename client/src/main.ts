/**
 * main.ts — Application entry point for the Hiroba client (v2).
 *
 * This module owns global app state and acts as the integration layer:
 *  - Bootstraps the UI (join form → space + sidebar + tabs).
 *  - Opens the WebSocket via net.ts and handles all server messages, across
 *    BOTH scopes: the org roster (sidebar) and the current space (canvas).
 *  - Routes messages to render.ts, audio.ts, and input.ts.
 *  - Switches spaces (tabs), pages members (cross-space 1:1), and reflects
 *    presence/status in the sidebar.
 *  - Drives ONE demand-driven rAF loop that ticks input, updates audio gains
 *    and levels, and renders — then sleeps when the space is still and silent
 *    so idle CPU stays ≈ 0% (NFR-01). An idle timer also flips the user to
 *    `away` so others see it and the loop can rest.
 *  - Recovers from unexpected disconnects with bounded auto-reconnect.
 *
 * Invariant: while in the "space" state, `session` is non-null.
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { HirobaNet } from "./net.js";
import { Renderer, type FrameLevels } from "./render.js";
import { InputHandler, isTypingTarget } from "./input.js";
import { AudioEngine } from "./audio.js";
import {
  UIManager,
  type InviteEntry,
  type JoinFormValues,
  type MemberEntry,
  type RosterEntry,
} from "./ui.js";
import { shouldDraw, shouldKeepAwake } from "./loop.js";
import { startUpdateChecks } from "./updater.js";
import { startDeepLinkListener } from "./deeplink.js";
import { resolveIceServers } from "./config.js";
import { locale, spaceLabel, t } from "./i18n.js";
import {
  clearSession,
  CodeRejectedError,
  CodeThrottledError,
  decodeClaims,
  emailStart,
  emailVerify,
  InviteRejectedError,
  isLive,
  isTauri,
  listOrgs,
  loadSession,
  oauthLogin,
  openExternal,
  saveSession,
  switchOrg,
  type AuthSession,
  type OAuthResult,
  type OrgSummary,
  type RestoreResult,
} from "./auth.js";
import type {
  Peer,
  RosterMember,
  SpaceDescriptor,
  Status,
  WelcomeMsg,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Active session state (null when on the join / reconnect screen)
// ---------------------------------------------------------------------------

interface Session {
  net: HirobaNet;
  input: InputHandler;
  audio: AudioEngine;

  /** Our own identity (id is server-assigned, name/color/avatar from the join form). */
  self: { id: string; name: string; color: string; avatar?: string };

  /** Current space we're present in (the 2D canvas scope). */
  spaceId: string;
  space: SpaceDescriptor;
  /** Full space catalog (drives the tabs). */
  spaces: SpaceDescriptor[];

  /** Org roster, excluding self (drives the sidebar). */
  roster: Map<string, RosterMember>;
  /** Members reported disconnected — kept greyed in the roster. */
  offline: Set<string>;

  /** Latest known positions for peers in the *current space*. */
  peerPositions: Map<string, { x: number; y: number }>;

  /** Established page links: peer id → display name (for the call banner). */
  pages: Map<string, string>;
  /** Outgoing rings awaiting accept: peer id → display name. */
  ringingOut: Map<string, string>;
  /** Incoming offers awaiting accept/decline: peer id → display name. */
  ringingIn: Map<string, string>;
  /** Remote video (screen share or camera) streams keyed by peer id. Mode is
   *  null for the brief window before the peer's "video-mode" label arrives. */
  remoteVideos: Map<string, { stream: MediaStream; mode: "screen" | "camera" | null }>;
  /** Which video stream currently holds the main panel (derived by
   *  {@link syncVideoViews}; the other active stream goes to the self-view). */
  visibleScreen: { kind: "local" } | { kind: "remote"; peerId: string } | null;
  /** True when the user dismissed the remote video panel (minimize). */
  screenDismissed: boolean;
  /** True when the user clicked the self-view to show their own video large
   *  even though a remote stream exists (remote is the default). */
  localPromoted: boolean;

  /** User-controllable status flags (effective status is server-computed). */
  away: boolean;
  dnd: boolean;

  /** True if we auto-unmuted for a page so we can restore mute when it ends. */
  pageAutoUnmuted: boolean;
}

let session: Session | null = null;

// Audio device preference, persisted across sessions (mirrors ui.ts's LS_*
// convention; this module owns AudioEngine, so it owns these two keys).
const LS_MIC_DEVICE = "hiroba_mic_device";
const LS_SPEAKER_DEVICE = "hiroba_speaker_device";
/** Set once the movement hint has done its job. It teaches WASD/click-to-walk,
 *  which nobody needs to be told twice — a hint that returns on every join
 *  stops reading as onboarding and starts reading as clutter. */
const LS_MOVE_HINT_SEEN = "hiroba_move_hint_seen";

// Reconnect bookkeeping.
const MAX_RECONNECT = 6;
/** Retry cadence while the OS reports no network (these attempts are free —
 *  see {@link scheduleReconnect}). The "online" event is the fast path; this is
 *  the floor under it. */
const OFFLINE_RETRY_MS = 5000;
/** Free (offline) attempts still get a ceiling: Windows can report `onLine`
 *  false with the network up (VPNs, virtual adapters), and without a cap that
 *  misreport turns an unreachable server into reconnecting forever. Wall-clock
 *  from the drop (attempt counts would stretch with per-phase timeouts), long
 *  enough for any awake network outage worth riding out. */
const OFFLINE_WINDOW_MS = 3 * 60_000;
/** A retry timer firing this far past its delay means the machine was
 *  suspended, not waiting — the offline window restarts on resume. */
const SUSPEND_GAP_MS = 30_000;
let lastJoin: JoinFormValues | null = null;
let userLeaving = false; // suppresses reconnect when the user left on purpose
let reconnectAttempts = 0;
/** When the current reconnect sequence stops being worth offline retries.
 *  Anchored once per drop ({@link onSessionDropped}); deliberately NOT
 *  extended by online/offline flapping. */
let offlineDeadline = 0;
let reconnectTimer = 0;
/** Where auto-reconnect stands. `waiting` means a retry is on the clock and a
 *  returning network should cut that wait short; `connecting` means an attempt
 *  is already in flight and must be left to finish. */
let reconnectState: "idle" | "waiting" | "connecting" = "idle";
/** The drop we're recovering from killed a live call. Both sides just go quiet
 *  (the peer is told no differently than a hang-up), so the least we can do is
 *  say so on the way back in. */
let droppedInCall = false;

// Heartbeat: the client pings, the server echoes `pong`. A half-open socket
// (sleep resume, network switch — routine on Windows) fires no close event
// until TCP gives up, minutes later or never; missed pongs turn that into a
// prompt drop + reconnect. The dead check is armed by the `heartbeat`
// capability flag in `welcome` — servers that predate `pong` (they ignore
// unknown messages) never get a healthy connection killed. A pong also arms
// it, covering servers built in the window where `pong` existed but the
// welcome flag didn't.
const HEARTBEAT_MS = 15_000;
/** Unanswered pings tolerated before the connection is declared dead. */
const HEARTBEAT_MISSED_LIMIT = 2;
let heartbeatTimer = 0;
let heartbeatMissed = 0;
let heartbeatCapable = false;

// Loop bookkeeping.
let rafId = 0;
let rafScheduled = false;
let dirty = false;
let wasAnimating = false;

// Audio-settings panel: a small dedicated rAF loop drives the level meter
// while it's open, independent of the main demand-driven loop above (which
// may be asleep — e.g. testing the mic alone in an empty space).
let audioSettingsRaf = 0;

// Ambient-prompt state.
let moveHintActive = false;
let nudgeShown = false;
let connectAbort: AbortController | null = null;

// Idle → away (NFR-01: dim + go quiet after inactivity).
// Keep IDLE_MINUTES in sync with the "5 minutes" copy in i18n activeTitle/awayTitle.
const IDLE_MINUTES = 5;
const IDLE_MS = IDLE_MINUTES * 60 * 1000;
let idleTimer = 0;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const canvas = document.getElementById("space") as HTMLCanvasElement;
if (!canvas) throw new Error("Missing <canvas id='space'>");

const renderer = new Renderer(canvas);
renderer.setWakeCallback(wake);

const ui = new UIManager(
  {
    onJoin: handleJoin,
    onCancelConnect: handleCancelConnect,
    onLogin: handleLogin,
    onEmailStart: handleEmailStart,
    onEmailVerify: handleEmailVerify,
    onLogout: handleLogout,
    onSwitchOrg: (orgSlug) => void handleSwitchOrg(orgSlug),
    onCreateOrg: handleCreateOrg,
    onCancelOrgSetup: handleCancelOrgSetup,
    onOpenInvitePanel: handleOpenInvitePanel,
    onIssueInvite: handleIssueInvite,
    onRevokeInvite: handleRevokeInvite,
    onOpenMembersPanel: handleOpenMembersPanel,
    onRemoveMember: handleRemoveMember,
    onOpenBilling: handleOpenBilling,
    onMicToggle: handleMicToggle,
    onOpenAudioSettings: handleOpenAudioSettings,
    onCloseAudioSettings: handleCloseAudioSettings,
    onMicDeviceChange: handleMicDeviceChange,
    onSpeakerDeviceChange: handleSpeakerDeviceChange,
    onLeave: handleLeave,
    onCancelReconnect: handleCancelReconnect,
    onEnterSpace: handleEnterSpace,
    onCreateSpace: handleCreateSpace,
    onPage: handlePage,
    onPageAccept: handlePageAccept,
    onHangUp: handleHangUp,
    onScreenShareToggle: handleScreenShareToggle,
    onCameraToggle: handleCameraToggle,
    onCloseScreenShare: handleCloseScreenShare,
    onReopenScreenShare: handleReopenScreenShare,
    onSelfViewClick: handleSelfViewClick,
    onSetStatus: handleSetStatus,
    onLocaleChange: handleLocaleChange,
  },
  { tauri: isTauri() },
);

const frameLevels: FrameLevels = {
  selfLevel: 0,
  levelOf: (id) => (session ? session.audio.getLevel(id) : 0),
};

ui.showJoin();

// Desktop auto-update: periodic check → banner → install + relaunch.
// No-op in plain-browser sessions.
startUpdateChecks(ui);

// Invite deep links (hiroba://invite/<token>): prefill the join form so the
// invited user only has to pick a sign-in provider. No-op outside Tauri.
startDeepLinkListener((code) => ui.applyInvite(code));

// Push-to-toggle mute shortcut (M) — standard in voice tools. Ignores typing
// contexts and modifier chords so it never hijacks text input or app shortcuts.
window.addEventListener("keydown", (e) => {
  if (!session) return;
  if (e.code !== "KeyM" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;
  void handleMicToggle();
});

// Click-to-walk / click-to-sit: a click on a seat walks to that stool and
// settles into the seated pose; a click on open floor sets a free walk target.
// Dragging with the button held steers free walk (seats are only snap-picked
// on pointerdown so dragging across furniture doesn't re-target every stool).
// Keyboard input still wins — input.ts drops the target on the first key.
function pointToWalk(e: PointerEvent): void {
  if (!session || !e.isPrimary) return;
  const world = renderer.screenToWorld(e.clientX, e.clientY);
  if (!world) return;
  session.input.setMoveTarget(world.x, world.y);
}

// Where a seat click went down, in client px. A normal click wobbles a pixel
// or two before pointerup; without this anchor that wobble would re-target
// off the seat centre and the walk would no longer settle into the seat.
let seatClickAnchor: { x: number; y: number } | null = null;
const SEAT_DRAG_SLOP_PX = 8;

/** Whether a roster member can be paged (same rules as the sidebar button). */
function canPagePeer(id: string): boolean {
  if (!session) return false;
  if (id === session.self.id) return false;
  if (session.offline.has(id)) return false;
  if (session.pages.has(id)) return false;
  if (session.ringingOut.has(id) || session.ringingIn.has(id)) return false;
  return session.roster.has(id);
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (!session || !e.isPrimary) return;

  // Peers first: clicking someone sitting on a stool should page them, not re-sit.
  const peerId = renderer.peerAtScreen(e.clientX, e.clientY);
  if (peerId && canPagePeer(peerId)) {
    handlePage(peerId);
    renderer.setPageHover(null);
    renderer.setSeatHover(null);
    canvas.classList.remove("can-page", "can-sit");
    return;
  }

  const seat = renderer.seatAtScreen(e.clientX, e.clientY);
  if (seat) {
    session.input.setMoveTarget(seat.x, seat.y);
    seatClickAnchor = { x: e.clientX, y: e.clientY };
    return;
  }

  seatClickAnchor = null;
  pointToWalk(e);
});

canvas.addEventListener("pointermove", (e) => {
  if (e.buttons === 1) {
    // Free-steer while dragging; don't snap to every seat under the path.
    // A seat click keeps its snap until the pointer clearly drags away.
    if (seatClickAnchor) {
      const moved = Math.hypot(e.clientX - seatClickAnchor.x, e.clientY - seatClickAnchor.y);
      if (moved < SEAT_DRAG_SLOP_PX) return;
      seatClickAnchor = null;
    }
    pointToWalk(e);
    return;
  }
  if (!session) return;
  const peerId = renderer.peerAtScreen(e.clientX, e.clientY);
  const pageable = !!(peerId && canPagePeer(peerId));
  renderer.setPageHover(pageable ? peerId : null);
  canvas.classList.toggle("can-page", pageable);

  if (pageable) {
    renderer.setSeatHover(null);
    canvas.classList.remove("can-sit");
    return;
  }

  const seat = renderer.seatAtScreen(e.clientX, e.clientY);
  renderer.setSeatHover(seat);
  canvas.classList.toggle("can-sit", !!seat);
});

canvas.addEventListener("pointerup", () => {
  seatClickAnchor = null;
});

canvas.addEventListener("pointerleave", () => {
  seatClickAnchor = null;
  renderer.setPageHover(null);
  renderer.setSeatHover(null);
  canvas.classList.remove("can-page", "can-sit");
});

// Closing the window is an intentional leave: tell the server so peers see us
// go immediately instead of waiting out the server's disconnect timeout.
window.addEventListener("pagehide", () => {
  if (!session) return;
  userLeaving = true;
  session.net.send({ t: "bye" });
  teardownSession();
});

// ---------------------------------------------------------------------------
// OAuth session (FR-13 / AUTH_PLAN §2)
// ---------------------------------------------------------------------------

/** The signed-in session, restored from the OS keychain at boot. Its JWT is
 *  what `hello.token` / `GET /ice` carry; a manual token in the Advanced
 *  section (self-host edge cases) still takes precedence if typed. */
let authSession: AuthSession | null = null;

/** Backoff for a restore the auth server was merely unreachable for. A launch
 *  with no network must not end up looking like a signed-out one, so the stored
 *  session stays on screen while the renewal is retried in the background. The
 *  last delay repeats for as long as the app is open. */
const RESTORE_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
let restoreAttempt = 0;
let restoreTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Adopt whatever the keychain still holds. Only a session the auth server has
 * actually disowned (or one that was never there) puts the sign-in form back on
 * screen — a keychain we can't read or a server we can't reach says so instead,
 * because "sign in again" is the one instruction that doesn't fix either.
 */
async function restoreAuthSession(): Promise<void> {
  // A live session in hand beats anything on disk — and a retry that fired
  // after an interactive sign-in must not undo it.
  if (authSession && isLive(authSession.claims)) return cancelRestoreRetry();
  // loadSession is written not to throw; should it ever manage to, the sign-in
  // form still has to come back — a stuck placeholder leaves no way in at all.
  const { session, problem } = await loadSession(ui.getAuthUrl()).catch(
    (): RestoreResult => ({ session: null }),
  );
  // Anything the user did while that was in flight outranks its answer: a fresh
  // sign-in must not be overwritten by a restore that started before it. (A
  // sign-out is handled a layer down — loadSession comes back empty for one.)
  if (authSession && isLive(authSession.claims)) return cancelRestoreRetry();
  authSession = session;
  reflectAuthSession();
  if (problem === "keychain") ui.showError(session ? t.errSessionNotSaved : t.errKeychain);
  if (session && !isLive(session.claims)) scheduleRestoreRetry();
  else cancelRestoreRetry();
}

function scheduleRestoreRetry(): void {
  if (restoreTimer) return;
  const delay =
    RESTORE_RETRY_DELAYS_MS[Math.min(restoreAttempt, RESTORE_RETRY_DELAYS_MS.length - 1)];
  restoreAttempt += 1;
  restoreTimer = setTimeout(() => {
    restoreTimer = null;
    void restoreAuthSession();
  }, delay);
}

function cancelRestoreRetry(): void {
  if (restoreTimer) clearTimeout(restoreTimer);
  restoreTimer = null;
  restoreAttempt = 0;
}

void restoreAuthSession();

// Coming back online is the one signal worth more than the backoff clock.
window.addEventListener("online", () => {
  if (authSession && isLive(authSession.claims)) return;
  cancelRestoreRetry();
  void restoreAuthSession();
});

/** Provisional token held while the org-setup step is on screen (a first
 *  sign-in without an invite; `POST /orgs` upgrades it to a full session). */
let pendingProvisionalToken: string | null = null;

function reflectAuthSession(): void {
  if (authSession) {
    const c = authSession.claims;
    ui.setAuthSession({ name: c.name, org: c.org_name || c.org, role: c.role });
    ui.setAdminVisible(c.role === "admin");
    ui.prefillName(c.name);
  } else {
    ui.setAuthSession(null);
    ui.setAdminVisible(false);
  }
  // Learn about a billing lock before a join attempt bounces off it (the
  // lock screen carries the fix — the admin's subscribe CTA).
  void syncBillingLock();
  void syncOrgList();
}

// ---------------------------------------------------------------------------
// Org switching (multi-org accounts; the chip dropdown and the billing-lock
// escape hatch both land here)
// ---------------------------------------------------------------------------

/** Memberships behind the chip's org switcher (empty until GET /orgs answers). */
let orgList: OrgSummary[] = [];

/** Fetch the session's memberships and hand them to the UI. Any failure —
 *  offline, expired JWT, a pre-multi-org backend — just means no switcher,
 *  which is the plain single-org chip, never an error. */
async function syncOrgList(): Promise<void> {
  const session = authSession;
  if (!session) {
    orgList = [];
    ui.setOrgList([], "");
    return;
  }
  let orgs: OrgSummary[];
  try {
    orgs = await listOrgs(ui.getAuthUrl(), session.token);
  } catch {
    orgs = [];
  }
  // The session may have moved (sign-out, switch) while the list was in
  // flight; whatever caused that runs its own sync against the new claims.
  if (authSession !== session) return;
  orgList = orgs;
  ui.setOrgList(orgs, session.claims.org);
}

/** The in-flight org switch, if any. One at a time: the refresh token is
 *  single-use, so a second rotation alongside the first would 401. Joining
 *  waits on this too (see `effectiveToken`) — between the dropdown showing
 *  org B and the switch settling, the held token still says org A. Never
 *  rejects (failures are handled inside). */
let orgSwitchPending: Promise<void> | null = null;

/** Re-anchor the session in another org. On failure nothing moved — the old
 *  refresh token is only consumed by a successful switch — so keep the current
 *  session and say so. */
async function handleSwitchOrg(orgSlug: string): Promise<void> {
  const session = authSession;
  if (orgSwitchPending || !session || orgSlug === session.claims.org) return;
  const run = (async () => {
    try {
      const switched = await switchOrg(ui.getAuthUrl(), session.refreshToken, orgSlug);
      // A sign-out (or any other session change) while the switch was in
      // flight owns the state now — adopting the answer would resurrect
      // exactly what the user just discarded.
      if (authSession !== session) return;
      cancelRestoreRetry();
      authSession = switched;
      reflectAuthSession();
      if ((await saveSession(switched)) === "failed") ui.showError(t.errSessionNotSaved);
    } catch {
      if (authSession !== session) return;
      ui.showToast(t.errOrgSwitch, "error");
      // Snap the dropdown back to the org we actually still hold.
      ui.setOrgList(orgList, session.claims.org);
    }
  })();
  orgSwitchPending = run;
  ui.setOrgSwitchBusy(true);
  try {
    await run;
  } finally {
    orgSwitchPending = null;
    ui.setOrgSwitchBusy(false);
  }
}

async function handleLogin(
  provider: "google" | "github",
  authUrl: string,
  invite: string,
): Promise<void> {
  ui.setLoginBusy(true);
  try {
    await adoptLogin(await oauthLogin(authUrl, provider, invite || undefined), invite);
  } catch (err) {
    ui.showError(err instanceof Error ? err.message : t.errSignIn);
  } finally {
    ui.setLoginBusy(false);
  }
}

/** Mail a one-time code and move the form to the code step. */
async function handleEmailStart(email: string, authUrl: string): Promise<void> {
  ui.setEmailBusy(true);
  try {
    const { devCode } = await emailStart(authUrl, email, locale);
    ui.showCodeStep(email);
    // A dev auth backend (HIROBA_AUTH_DEV=1) mails nothing and hands the code
    // back instead, so a local sign-in needs no mailbox.
    if (devCode) console.info(`[dev] login code for ${email}: ${devCode}`);
  } catch (err) {
    ui.showError(
      err instanceof CodeThrottledError ? t.errCodeThrottled(err.retryAfterSecs) : t.errSendCode,
    );
  } finally {
    ui.setEmailBusy(false);
  }
}

/** Trade the typed code for a session — from here it is the OAuth path. */
async function handleEmailVerify(code: string, authUrl: string, invite: string): Promise<void> {
  const email = ui.getCodeEmail();
  if (!email) return;
  ui.setCodeBusy(true);
  try {
    await adoptLogin(await emailVerify(authUrl, email, code, invite || undefined), invite);
    ui.showEmailStep();
  } catch (err) {
    // The backend never says *why* a code failed (wrong, expired, or spent),
    // and neither do we. But a refused invite and a request that never landed
    // are different problems, and calling either one a wrong code would send
    // the user hunting for a new one they don't need.
    if (err instanceof CodeRejectedError) ui.showError(t.errCode);
    else if (err instanceof InviteRejectedError) ui.showError(t.errInvite);
    else ui.showError(t.errConnect);
  } finally {
    ui.setCodeBusy(false);
  }
}

/** Adopt whatever a login produced: a session to store, or the org-setup step
 *  a first-time uninvited user has to pass through first. */
async function adoptLogin(result: OAuthResult, invite: string): Promise<void> {
  if (result.kind === "pending_org") {
    // First sign-in, no invite: the user names their org before a session
    // exists. The provisional token only authorizes POST /orgs.
    pendingProvisionalToken = result.provisionalToken;
    ui.showOrgSetup();
    return;
  }
  cancelRestoreRetry();
  authSession = result.session;
  if (invite) ui.clearInvite();
  reflectAuthSession();
  // Persisting is what makes the *next* launch free; failing at it must not
  // cost the user the sign-in they just completed. Tell them, keep the session.
  if ((await saveSession(result.session)) === "failed") ui.showError(t.errSessionNotSaved);
}

function handleLogout(): void {
  cancelRestoreRetry();
  authSession = null;
  void clearSession();
  reflectAuthSession();
}

// ---------------------------------------------------------------------------
// Org setup (first sign-in without an invite)
// ---------------------------------------------------------------------------

async function handleCreateOrg(name: string): Promise<void> {
  if (!pendingProvisionalToken) {
    ui.hideOrgSetup();
    return;
  }
  ui.setOrgSetupBusy(true);
  try {
    const resp = await fetch(`${ui.getAuthUrl()}/orgs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pendingProvisionalToken}`,
      },
      // Billing currency follows the UI locale, mirroring the pricing the user
      // was shown (¥300 on the ja site, $2 elsewhere). Stripe pins it for the
      // org's lifetime; self-host auth backends just ignore the field.
      body: JSON.stringify({ name, currency: locale === "ja" ? "jpy" : "usd" }),
    });
    if (resp.status === 403) throw new Error(t.errAlreadyInOrg);
    if (resp.status === 401) throw new Error(t.errSessionExpired);
    if (!resp.ok) throw new Error(t.errOrgCreate);
    const data: { token: string; refresh_token: string } = await resp.json();
    const claims = decodeClaims(data.token);
    if (!claims || !data.refresh_token) throw new Error(t.errOrgCreate);
    pendingProvisionalToken = null;
    const session: AuthSession = {
      token: data.token,
      claims,
      refreshToken: data.refresh_token,
    };
    cancelRestoreRetry();
    authSession = session;
    ui.hideOrgSetup();
    reflectAuthSession();
    if ((await saveSession(session)) === "failed") ui.showError(t.errSessionNotSaved);
  } catch (err) {
    ui.showError(err instanceof Error ? err.message : t.errOrgCreate);
  } finally {
    ui.setOrgSetupBusy(false);
  }
}

function handleCancelOrgSetup(): void {
  pendingProvisionalToken = null;
  ui.hideOrgSetup();
}

// ---------------------------------------------------------------------------
// Invite management (admin)
// ---------------------------------------------------------------------------

async function handleOpenInvitePanel(): Promise<void> {
  ui.showInvitePanel();
  await refreshInviteList();
}

async function refreshInviteList(): Promise<void> {
  if (!authSession) return;
  try {
    const resp = await fetch(`${ui.getAuthUrl()}/invites`, {
      headers: { Authorization: `Bearer ${authSession.token}` },
    });
    if (!resp.ok) throw new Error(t.errLoadInvites);
    const data: {
      invites: { token: string; role: string; expires_at: number; creator: string }[];
    } = await resp.json();
    const entries: InviteEntry[] = data.invites.map((i) => ({
      token: i.token,
      role: i.role,
      expiresAt: i.expires_at,
      creator: i.creator,
    }));
    ui.renderInviteList(entries);
  } catch {
    ui.showInvitePanelError(t.errLoadInvites);
  }
}

async function handleIssueInvite(role: "member" | "admin"): Promise<void> {
  if (!authSession) return;
  ui.setInviteIssueBusy(true);
  try {
    const resp = await fetch(`${ui.getAuthUrl()}/invites`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authSession.token}`,
      },
      body: JSON.stringify({ role }),
    });
    if (!resp.ok) throw new Error(t.errIssueInvite);
    const data: { invite: string } = await resp.json();
    ui.showInviteResult(data.invite, ui.getAuthUrl());
    await refreshInviteList();
  } catch {
    ui.showInvitePanelError(t.errIssueInvite);
  } finally {
    ui.setInviteIssueBusy(false);
  }
}

async function handleRevokeInvite(token: string): Promise<void> {
  if (!authSession) return;
  try {
    await fetch(`${ui.getAuthUrl()}/invites/${encodeURIComponent(token)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authSession.token}` },
    });
  } catch {
    /* the refresh below shows the authoritative state either way */
  }
  await refreshInviteList();
}

// ---------------------------------------------------------------------------
// Member management (admin)
// ---------------------------------------------------------------------------

async function handleOpenMembersPanel(): Promise<void> {
  ui.showMembersPanel();
  await refreshMemberList();
}

async function refreshMemberList(): Promise<void> {
  if (!authSession) return;
  try {
    const resp = await fetch(`${ui.getAuthUrl()}/members`, {
      headers: { Authorization: `Bearer ${authSession.token}` },
    });
    if (!resp.ok) throw new Error(t.errLoadMembers);
    const data: {
      members: { subject: string; name: string | null; email: string | null; role: string }[];
    } = await resp.json();
    const self = authSession.claims.sub;
    const entries: MemberEntry[] = data.members.map((m) => ({
      subject: m.subject,
      name: m.name || m.email || m.subject,
      role: m.role,
      isSelf: m.subject === self,
    }));
    ui.renderMemberList(entries);
  } catch {
    ui.showMembersPanelError(t.errLoadMembers);
  }
}

/** Remove a member (the button itself is two-step, so this fires confirmed).
 *  The freed seat syncs to Stripe on the auth side; the member's session dies
 *  when their JWT expires. */
async function handleRemoveMember(subject: string): Promise<void> {
  if (!authSession) return;
  try {
    const resp = await fetch(`${ui.getAuthUrl()}/members/${encodeURIComponent(subject)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authSession.token}` },
    });
    if (!resp.ok && resp.status !== 404) throw new Error(t.errRemoveMember);
  } catch {
    ui.showMembersPanelError(t.errRemoveMember);
  }
  await refreshMemberList(); // authoritative state either way
}

// ---------------------------------------------------------------------------
// Billing (admin) — hands off to Stripe's hosted Customer Portal (INFRA §6)
// ---------------------------------------------------------------------------

/** Ask the auth backend for a Customer Portal session and open it in the system
 *  browser. The portal (add card / change plan / cancel) is Stripe-hosted; we
 *  build no billing UI of our own. A 404 means this deployment has billing off
 *  (self-host) — say so plainly rather than failing cryptically. */
async function handleOpenBilling(): Promise<void> {
  if (!authSession) return;
  ui.showToast(t.openingBilling);
  try {
    const resp = await fetch(`${ui.getAuthUrl()}/billing/portal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authSession.token}` },
    });
    if (resp.status === 404) {
      ui.showToast(t.billingNotEnabled, "error");
      return;
    }
    if (!resp.ok) throw new Error("portal session failed");
    const data: { url: string } = await resp.json();
    await openExternal(data.url);
  } catch {
    ui.showToast(t.errBillingPortal, "error");
  }
}

// ---------------------------------------------------------------------------
// Billing lock (hosted: trial expired / subscription lapsed → server refuses
// entry with `org_suspended`, so the CTA to fix it must live on the join card)
// ---------------------------------------------------------------------------

/** Stripe subscription status while the org is locked, else null. */
let billingLockStatus: string | null = null;
/** Which org `billingLockStatus` was computed for. */
let billingLockOrg: string | null = null;
let billingLockTimer: number | null = null;
/** While the notice is up, re-ask this often — the unlock happens out of band
 *  (card added on Stripe's page → webhook resumes the subscription). */
const BILLING_LOCK_POLL_MS = 10_000;

/** Ask the auth backend whether our org is locked and reflect the answer.
 *  Unreachable or malformed answers leave the current state alone (fail-open,
 *  mirroring the signaling server's own gate). */
async function syncBillingLock(): Promise<void> {
  const org = authSession?.claims.org;
  const authUrl = ui.getAuthUrl();
  if (!org || !authUrl) return applyBillingLock(null);
  // A lock belongs to the org it was computed for. After an org switch the
  // fail-open branches below would otherwise keep the previous org's lock
  // covering the join controls when the new org's status can't be fetched.
  if (billingLockStatus !== null && billingLockOrg !== org) applyBillingLock(null);
  try {
    const resp = await fetch(`${authUrl}/billing/status/${encodeURIComponent(org)}`);
    if (resp.ok) {
      const data: { status?: string; locked?: boolean } = await resp.json();
      // The session may have changed (sign-out, org switch) while in flight;
      // whatever triggered that change owns the state now.
      if (authSession?.claims.org !== org) return;
      billingLockOrg = org;
      applyBillingLock(data.locked ? (data.status ?? "paused") : null);
      return;
    }
  } catch {
    /* offline — keep whatever we showed last */
  }
  // Non-200 or unreachable: keep the shown state, but keep the poll alive —
  // the unlock happens out of band, so one auth hiccup must not end it.
  scheduleBillingRecheck();
}

function applyBillingLock(status: string | null): void {
  billingLockStatus = status;
  if (billingLockTimer !== null) {
    window.clearTimeout(billingLockTimer);
    billingLockTimer = null;
  }
  if (status === null) {
    ui.setBillingLock(null);
    return;
  }
  ui.setBillingLock({
    trial: status === "paused", // paused = card-less trial ran out (INFRA §6)
    admin: authSession?.claims.role === "admin",
  });
  scheduleBillingRecheck();
}

/** (Re)arm the next status check, only while the lock notice is up. */
function scheduleBillingRecheck(): void {
  if (billingLockStatus === null) return;
  if (billingLockTimer !== null) window.clearTimeout(billingLockTimer);
  billingLockTimer = window.setTimeout(() => void syncBillingLock(), BILLING_LOCK_POLL_MS);
}

// Coming back from Stripe's page is the moment the answer most likely changed.
window.addEventListener("focus", () => {
  if (billingLockStatus !== null) void syncBillingLock();
});

/** The token a new connection should present: a manual (Advanced) token wins,
 *  then a live OAuth session; otherwise guest. Expired sessions are dropped
 *  on the spot so we don't knock on the server with a dead JWT. */
async function effectiveToken(manual: string): Promise<string> {
  if (manual) return manual;
  // An org switch in flight owns the session: connecting with the pre-switch
  // token would put the user in the org the chip no longer shows.
  if (orgSwitchPending) await orgSwitchPending;
  if (!authSession || !isLive(authSession.claims)) {
    const { session, problem } = await loadSession(ui.getAuthUrl());
    authSession = session;
    reflectAuthSession();
    // Three different dead ends, three different things to do about them: sign
    // in again, unlock the keychain, or wait for the network.
    if (!session) ui.showError(problem === "keychain" ? t.errKeychain : t.errSessionExpired);
    else if (!isLive(session.claims)) ui.showError(t.errAuthOffline);
  }
  return authSession && isLive(authSession.claims) ? authSession.token : "";
}

// ---------------------------------------------------------------------------
// Connection orchestration
// ---------------------------------------------------------------------------

function openConnection(values: JoinFormValues, signal: AbortSignal): Promise<{ net: HirobaNet; msg: WelcomeMsg }> {
  return new Promise((resolve, reject) => {
    const net = new HirobaNet();
    let settled = false;
    let welcomeTimer = 0;
    const finish = (fn: () => void, close = false) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(welcomeTimer);
      signal.removeEventListener("abort", abort);
      if (close) net.close();
      fn();
    };
    const abort = () => finish(() => reject(new Error("cancelled")), true);
    const fail = () => finish(
      () => reject(new Error(signal.aborted ? "cancelled" : "connection failed")),
      true,
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return abort();
    net.onError(fail);
    net.onClose(fail);
    // A pre-welcome `error` frame (auth_failed, org_suspended, …) beats the
    // close that follows it, so the user sees the real reason instead of a
    // generic "could not connect".
    net.on(
      "error",
      (e) => {
        finish(() => reject(new Error(e.detail.code)), true);
      },
      { once: true },
    );
    net
      .connect(values.serverUrl, signal)
      .then(() => {
        if (signal.aborted) return abort();
        // The socket can open and then blackhole before `welcome` arrives (a
        // Wi-Fi roam or sleep right after the handshake). TCP won't surface
        // that for minutes, so the hello→welcome span needs its own clock —
        // net.connect's timeout only covers the open.
        welcomeTimer = window.setTimeout(
          () => finish(() => reject(new Error("connection_timeout")), true),
          12_000,
        );
        net.on(
          "welcome",
          (e) => finish(() => resolve({ net, msg: e.detail })),
          { once: true },
        );
        net.send({
          t: "hello",
          token: values.token || undefined,
          name: values.name,
          color: values.color,
          avatar: values.avatar || undefined,
        });
      })
      .catch(fail);
  });
}

async function connectSession(
  values: JoinFormValues,
  signal: AbortSignal,
): Promise<{ net: HirobaNet; msg: WelcomeMsg; iceServers: RTCIceServer[] }> {
  // Resolve ICE before opening the WebSocket so a slow /ice response cannot
  // leave post-welcome events arriving before session handlers are installed.
  const iceServers = await resolveIceServers(values.serverUrl, values.token, signal);
  const { net, msg } = await openConnection(values, signal);
  return { net, msg, iceServers };
}

async function handleJoin(values: JoinFormValues): Promise<void> {
  // Resolve the token once and remember it, so auto-reconnect reuses the same
  // credential the session was opened with.
  values = { ...values, token: await effectiveToken(values.token) };
  lastJoin = values;
  userLeaving = false;
  reconnectAttempts = 0;
  reconnectState = "idle";
  droppedInCall = false;
  const controller = new AbortController();
  connectAbort?.abort();
  connectAbort = controller;
  try {
    const { net, msg, iceServers } = await connectSession(values, controller.signal);
    if (controller.signal.aborted || connectAbort !== controller) {
      net.close();
      return;
    }
    startSession(net, msg, iceServers);
    if (!localStorage.getItem(LS_MOVE_HINT_SEEN)) {
      moveHintActive = true;
      ui.showMoveHint();
    }
  } catch (err) {
    const code = err instanceof Error ? err.message : "";
    if (code === "cancelled" || (err instanceof DOMException && err.name === "AbortError")) return;
    ui.showJoin(connectionErrorCopy(code));
    reflectSuspension(code);
  } finally {
    if (connectAbort === controller) connectAbort = null;
  }
}

/** An `org_suspended` refusal means the lock screen (with the admin's fix-it
 *  CTA) belongs on the join card — show it at once with our best guess at the
 *  status, then let the status endpoint refine trial-ended vs. payment-lapsed.
 *  Also covers the status check and the server's gate disagreeing (its cache
 *  lags up to a minute). */
function reflectSuspension(code: string): void {
  if (code !== "org_suspended") return;
  billingLockOrg = authSession?.claims.org ?? null;
  applyBillingLock(billingLockStatus ?? "paused");
  void syncBillingLock();
}

function handleCancelConnect(): void {
  connectAbort?.abort();
  connectAbort = null;
  ui.showJoin();
}

function connectionErrorCopy(code: string): string {
  switch (code) {
    case "auth_failed": return t.errAuthFailed;
    case "org_suspended": return t.errOrgSuspended;
    case "space_full": return t.errSpaceFull;
    case "space_limit": return t.errSpaceLimit;
    case "unknown_space": return t.errUnknownSpace;
    case "forbidden": return t.errForbidden;
    default: return t.errConnect;
  }
}

function isPermanentConnectionError(code: string): boolean {
  return ["auth_failed", "org_suspended", "space_full", "space_limit", "unknown_space", "forbidden"].includes(code);
}

function startSession(net: HirobaNet, msg: WelcomeMsg, iceServers: RTCIceServer[]): void {
  net.onClose(onSessionDropped);
  net.onError(onSessionDropped);

  initSession(net, msg, iceServers);
  bindServerMessages(net);
  startHeartbeat(msg.heartbeat === true);
  reconnectAttempts = 0;
  reconnectState = "idle";
  canvas.classList.add("walkable"); // pointer cursor: the floor is clickable
  ui.showSpace();
  // After the space is on screen, so the toast isn't buried under the overlay.
  if (droppedInCall) {
    droppedInCall = false;
    ui.showToast(t.callDropped);
  }
  resetIdleTimer();
  wake();
}

function onSessionDropped(): void {
  if (userLeaving || !session) return;
  if (session.pages.size > 0) droppedInCall = true;
  teardownSession();
  offlineDeadline = Date.now() + OFFLINE_WINDOW_MS;
  scheduleReconnect();
}

/** Ping the server on a fixed cadence and treat sustained pong silence as a
 *  dropped connection (rationale at {@link HEARTBEAT_MS}). Cleared by
 *  {@link teardownSession}; safe across sleep — timers don't run while
 *  suspended, so a resume gets the full missed-pong allowance (~30–45s)
 *  before the connection is written off. */
function startHeartbeat(capable: boolean): void {
  heartbeatMissed = 0;
  heartbeatCapable = capable;
  heartbeatTimer = window.setInterval(() => {
    if (!session) return;
    if (heartbeatCapable && heartbeatMissed >= HEARTBEAT_MISSED_LIMIT) {
      onSessionDropped();
      return;
    }
    heartbeatMissed++;
    session.net.send({ t: "ping" });
  }, HEARTBEAT_MS);
}

function scheduleReconnect(): void {
  if (!lastJoin) return giveUpReconnect();
  // A failure logged while the OS reports no network says nothing about the
  // server, so it doesn't cost a normal attempt — spending the budget on
  // connects that can't succeed is what turns a sleep resume or a Wi-Fi roam
  // into a trip back to the join screen. We keep trying anyway, slowly:
  // `onLine` only decides which budget the failure comes out of, never whether
  // we bother (it can be wrong about a LAN self-host). Offline retries run on
  // a wall-clock window instead of a count, because `onLine` can also be
  // wrong the other way (see OFFLINE_WINDOW_MS).
  const offline = !navigator.onLine;
  if (offline) {
    reconnectAttempts = 0;
    if (Date.now() > offlineDeadline) return giveUpReconnect();
  } else if (reconnectAttempts >= MAX_RECONNECT) {
    return giveUpReconnect();
  }
  const attempt = offline ? 0 : ++reconnectAttempts;
  const delay = offline ? OFFLINE_RETRY_MS : Math.min(8000, 400 * 2 ** (attempt - 1));
  reconnectState = "waiting";
  ui.showReconnecting(attempt, MAX_RECONNECT, offline);
  const scheduledAt = Date.now();
  reconnectTimer = window.setTimeout(async () => {
    if (userLeaving || !lastJoin) return;
    // Fired far past the delay ⇒ the machine was suspended, not waiting. The
    // clock kept running while nothing could possibly have connected, so the
    // resume gets a full offline window rather than an already-spent one.
    if (Date.now() - scheduledAt > delay + SUSPEND_GAP_MS) {
      offlineDeadline = Date.now() + OFFLINE_WINDOW_MS;
    }
    reconnectState = "connecting";
    const controller = new AbortController();
    connectAbort = controller;
    try {
      const { net, msg, iceServers } = await connectSession(lastJoin, controller.signal);
      if (userLeaving || controller.signal.aborted || connectAbort !== controller) {
        net.close();
        return;
      }
      startSession(net, msg, iceServers);
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      if (userLeaving || code === "cancelled" || (err instanceof DOMException && err.name === "AbortError")) return;
      if (isPermanentConnectionError(code)) {
        giveUpReconnect(connectionErrorCopy(code));
        reflectSuspension(code);
        return;
      }
      scheduleReconnect();
    } finally {
      if (connectAbort === controller) connectAbort = null;
    }
  }, delay);
}

/** Stop trying and put the user back on the join card. The call is gone for
 *  good at this point, and `errRejoin` already explains why. */
function giveUpReconnect(message: string = t.errRejoin): void {
  reconnectState = "idle";
  droppedInCall = false;
  ui.showJoin(message);
}

// A network that just came back outranks the backoff clock: the attempt budget
// exists to stop hammering a dead server, not to give up on a Wi-Fi roam or a
// sleep resume (whose queued timers fire while the interface is still down).
// An in-flight attempt is left alone — every phase of it (ICE, open, welcome)
// carries its own 12s timeout, and cutting it short could kill a connect that
// was about to land.
window.addEventListener("online", () => {
  if (reconnectState !== "waiting" || session || userLeaving || !lastJoin) return;
  window.clearTimeout(reconnectTimer);
  // A fresh normal budget: the earlier failures weren't the server's. The
  // offline window is left alone — extending it here would let an interface
  // that flaps on and off keep the reconnect alive forever.
  reconnectAttempts = 0;
  scheduleReconnect();
});

function handleCancelReconnect(): void {
  window.clearTimeout(reconnectTimer);
  connectAbort?.abort();
  connectAbort = null;
  reconnectAttempts = 0;
  reconnectState = "idle";
  droppedInCall = false;
  userLeaving = true;
  ui.showJoin();
}

// ---------------------------------------------------------------------------
// Session initialization (from `welcome`)
// ---------------------------------------------------------------------------

function initSession(net: HirobaNet, msg: WelcomeMsg, iceServers: RTCIceServer[]): void {
  const input = new InputHandler();
  const audio = new AudioEngine();
  // Restore the user's last-picked devices (no-op side effects: the mic isn't
  // acquired yet, so this just seeds the preference for the first unmute).
  void audio.setMicDevice(localStorage.getItem(LS_MIC_DEVICE));
  void audio.setSpeakerDevice(localStorage.getItem(LS_SPEAKER_DEVICE));

  // The server echoes the *validated* avatar in `you`; trusting it (not the
  // form value) keeps what we render for ourselves consistent with what
  // everyone else sees.
  const self = {
    id: msg.id,
    name: msg.you.name,
    color: msg.you.color,
    avatar: msg.you.avatar,
  };

  const roster = new Map<string, RosterMember>();
  for (const m of msg.roster) roster.set(m.id, m);

  const peerPositions = new Map<string, { x: number; y: number }>();
  renderer.init(msg.space, msg.you);
  for (const peer of msg.peers) {
    renderer.upsertPeer(peer);
    peerPositions.set(peer.id, { x: peer.x, y: peer.y });
  }

  audio.init(
    msg.space,
    (to, data) => net.send({ t: "signal", to, data }),
    wake,
    iceServers, // STUN / TURN resolved from override → server /ice → STUN (NFR-07)
    handleRemoteVideo,
    handleLocalVideo,
  );

  input.init(
    msg.space,
    msg.you.x,
    msg.you.y,
    (x, y) => renderer.setSelfPosition(x, y),
    (x, y) => net.send({ t: "move", x, y }),
    onInputActivity,
  );

  session = {
    net,
    input,
    audio,
    self,
    spaceId: msg.spaceId,
    space: msg.space,
    spaces: msg.spaces,
    roster,
    offline: new Set(),
    peerPositions,
    pages: new Map(),
    ringingOut: new Map(),
    ringingIn: new Map(),
    remoteVideos: new Map(),
    visibleScreen: null,
    screenDismissed: false,
    localPromoted: false,
    away: false,
    dnd: false,
    pageAutoUnmuted: false,
  };

  ui.setOrgName(msg.org.name);
  document.title = `Hiroba — ${msg.org.name}`;
  ui.setMuted(audio.isMuted);
  ui.setScreenSharing(false);
  ui.setCameraOn(false);
  ui.setScreenShareView(null, "");
  ui.setSelfStatus(false, false);
  ui.setCall(null);
  ui.renderTabs(msg.spaces, msg.spaceId);
  rebuildRoster();
  setPeerCount();
  nudgeShown = false;
}

// ---------------------------------------------------------------------------
// Roster & tabs rendering (org scope)
// ---------------------------------------------------------------------------

/** Display name for a space id (falls back to the id if unknown). */
function spaceName(spaceId: string): string {
  const sp = session?.spaces.find((s) => s.id === spaceId);
  return sp ? spaceLabel(sp.id, sp.name) : spaceId;
}

/** Right-side status text for a roster member. */
function statusLabel(status: Status, spaceId: string): string {
  switch (status) {
    case "in_call":
      return t.statusInCall;
    case "dnd":
      return t.statusDnd;
    case "away":
      return t.statusAway;
    case "active":
      return spaceName(spaceId);
  }
}

/** Our own effective status, computed locally (the server excludes us from
 *  presence; the two user flags plus any active page determine it). */
function selfStatus(): Status {
  if (!session) return "active";
  if (session.pages.size > 0) return "in_call";
  if (session.dnd) return "dnd";
  if (session.away) return "away";
  return "active";
}

/** Rebuild the sidebar from current roster + self state. */
function rebuildRoster(): void {
  if (!session) return;
  const entries: RosterEntry[] = [];

  // Self first.
  const ss = selfStatus();
  entries.push({
    id: session.self.id,
    name: session.self.name,
    color: session.self.color,
    avatar: session.self.avatar,
    label: statusLabel(ss, session.spaceId),
    tone: ss,
    isSelf: true,
    canPage: false,
  });

  // Then everyone else (online first, then greyed offline), name-sorted.
  const others = [...session.roster.values()].sort((a, b) => {
    const ao = session!.offline.has(a.id) ? 1 : 0;
    const bo = session!.offline.has(b.id) ? 1 : 0;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });
  for (const m of others) {
    const off = session.offline.has(m.id);
    entries.push({
      id: m.id,
      name: m.name,
      color: m.color,
      avatar: m.avatar,
      label: off ? t.statusOffline : statusLabel(m.status, m.spaceId),
      tone: off ? "offline" : m.status,
      isSelf: false,
      canPage: !off && !session.pages.has(m.id),
    });
  }

  ui.renderRoster(entries);
  syncAvatarStatuses();
}

/** Push org-wide status onto canvas avatars for self + peers in this space. */
function syncAvatarStatuses(): void {
  if (!session) return;
  renderer.setSelfStatus(selfStatus());
  for (const id of session.peerPositions.keys()) {
    const member = session.roster.get(id);
    renderer.updatePeerStatus(id, member?.status ?? "active");
  }
}

/** "Just you" / "N here" for the current space. */
function setPeerCount(): void {
  if (!session) return;
  ui.setPeerCount(session.peerPositions.size + 1);
}

// ---------------------------------------------------------------------------
// Demand-driven loop
// ---------------------------------------------------------------------------

function wake(): void {
  dirty = true;
  if (!session || rafScheduled) return;
  rafScheduled = true;
  rafId = requestAnimationFrame(frame);
}

function frame(now: number): void {
  rafScheduled = false;
  if (!session) return;

  const moving = session.input.tick(now);
  renderer.setWalkTarget(session.input.moveTarget); // floor marker while walking
  session.audio.updateGains(session.input.position, session.peerPositions);
  const audioActive = session.audio.pollLevels();

  // Speaking counts as presence: without this, a long proximity chat with no
  // keyboard/mouse activity flips the user to Away mid-conversation.
  if (session.audio.selfLevel > 0) markActive();

  if (shouldDraw(moving, audioActive, wasAnimating, dirty)) {
    frameLevels.selfLevel = session.audio.selfLevel;
    wasAnimating = renderer.draw(now, frameLevels);
    dirty = false;
  }

  updateNudge();

  if (
    shouldKeepAwake(
      moving,
      audioActive,
      wasAnimating,
      session.audio.hasConnections(),
      session.audio.isMuted,
    )
  ) {
    rafScheduled = true;
    rafId = requestAnimationFrame(frame);
  }
}

/** Fired by InputHandler on the first key of a press. */
function onInputActivity(): void {
  if (moveHintActive) {
    moveHintActive = false;
    // Dismissed by actually moving: the hint has been read and acted on, so
    // don't show it again on later joins.
    localStorage.setItem(LS_MOVE_HINT_SEEN, "1");
    ui.hideMoveHint();
  }
  markActive();
  wake();
}

function updateNudge(): void {
  if (!session) return;
  const want = session.audio.isMuted && someoneInRange();
  if (want !== nudgeShown) {
    nudgeShown = want;
    ui.setMuteNudge(want);
  }
}

function someoneInRange(): boolean {
  if (!session) return false;
  const me = session.input.position;
  const nr = session.space.nearRadius;
  for (const p of session.peerPositions.values()) {
    if (Math.hypot(me.x - p.x, me.y - p.y) <= nr) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Idle → away
// ---------------------------------------------------------------------------
// Activity = keys/clicks/UI actions (via markActive callers) and local voice
// (selfLevel > 0 each frame). Peer audio alone does not count.

/** Restart the idle countdown; called on any user activity. */
function resetIdleTimer(): void {
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(goAway, IDLE_MS);
}

/** Mark the user active again (clears `away`, restarts the idle countdown). */
function markActive(): void {
  if (session && session.away) {
    session.away = false;
    ui.setSelfStatus(false, session.dnd);
    session.net.send({ t: "set_status", away: false });
    rebuildRoster();
  }
  resetIdleTimer();
}

function goAway(): void {
  if (!session || session.away) return;
  // Remember whether this idle flip will change the *effective* status the user
  // sees (DND / in-call already outrank Away, so no toast in those cases).
  const effectiveWasActive = !session.dnd && session.pages.size === 0;
  session.away = true;
  ui.setSelfStatus(true, session.dnd);
  session.net.send({ t: "set_status", away: true });
  rebuildRoster();
  if (effectiveWasActive) {
    ui.showToast(t.idleAwayToast(IDLE_MINUTES));
  }
}

// ---------------------------------------------------------------------------
// Server message routing
// ---------------------------------------------------------------------------

function bindServerMessages(net: HirobaNet): void {
  // --- Space scope (2D canvas) ---

  net.on("space_joined", (e) => {
    if (!session) return;
    const { peer } = e.detail;
    renderer.upsertPeer(peer);
    session.peerPositions.set(peer.id, { x: peer.x, y: peer.y });
    setPeerCount();
    wake();
  });

  net.on("space_left", (e) => {
    if (!session) return;
    const { id } = e.detail;
    renderer.removePeer(id);
    session.peerPositions.delete(id);
    // End their proximity audio; a page link to the same peer (if any) survives.
    session.audio.disconnectProximity(id);
    setPeerCount();
    wake();
  });

  net.on("state", (e) => {
    if (!session) return;
    for (const p of e.detail.peers) {
      renderer.updatePeerPosition(p.id, p.x, p.y);
      session.peerPositions.set(p.id, { x: p.x, y: p.y });
    }
    wake();
  });

  net.on("mute", (e) => {
    if (!session) return;
    const msg = e.detail;
    renderer.updatePeerMute(msg.id, msg.muted);
    wake();
  });

  net.on("proximity", (e) => {
    if (!session) return;
    const { connect, disconnect } = e.detail;
    for (const entry of connect) {
      void session.audio.connect(entry.id, entry.initiator, "proximity");
    }
    for (const id of disconnect) {
      session.audio.disconnectProximity(id);
    }
    if (connect.length > 0) wake();
  });

  net.on("signal", (e) => {
    if (!session) return;
    void session.audio.handleSignal(e.detail.from, e.detail.data);
  });

  net.on("pong", () => {
    heartbeatCapable = true;
    heartbeatMissed = 0;
  });

  // --- Space switch ---

  net.on("space_snapshot", (e) => {
    if (!session) return;
    const { spaceId, space, you, peers } = e.detail;

    // Drop the old space's spatial audio; a page link survives the move.
    session.audio.disconnectAllProximity();
    session.audio.setSpace(space);

    session.spaceId = spaceId;
    session.space = space;

    // Reset the canvas + input to the new space.
    const selfPeer: Peer = {
      id: session.self.id,
      name: session.self.name,
      color: session.self.color,
      avatar: session.self.avatar,
      x: you.x,
      y: you.y,
      muted: session.audio.isMuted,
    };
    renderer.init(space, selfPeer);
    session.input.setSpace(space, you.x, you.y);

    session.peerPositions.clear();
    for (const peer of peers) {
      renderer.upsertPeer(peer);
      session.peerPositions.set(peer.id, { x: peer.x, y: peer.y });
    }

    ui.renderTabs(session.spaces, spaceId);
    rebuildRoster(); // our own spaceId label changed
    setPeerCount();
    wake();
  });

  // --- Org scope (sidebar) ---

  net.on("spaces", (e) => {
    if (!session) return;
    session.spaces = e.detail.spaces;
    ui.renderTabs(session.spaces, session.spaceId);
  });

  net.on("presence", (e) => {
    if (!session) return;
    const m = e.detail.member;
    if (m.id === session.self.id) return; // server excludes us; ignore if echoed
    session.roster.set(m.id, m);
    session.offline.delete(m.id); // a fresh presence means they're online
    rebuildRoster();
  });

  net.on("presence_left", (e) => {
    if (!session) return;
    // Product choice: keep the member listed, greyed, rather than removing.
    if (session.roster.has(e.detail.id)) session.offline.add(e.detail.id);
    rebuildRoster();
  });

  // --- Paging (cross-space 1:1): ring → accept → connect ---

  net.on("page_ringing", (e) => {
    if (!session) return;
    const { to } = e.detail;
    const name = session.roster.get(to)?.name ?? to;
    session.ringingOut.set(to, name);
    updateCallBanner();
    rebuildRoster();
    wake();
  });

  net.on("page_offer", (e) => {
    if (!session) return;
    const { from } = e.detail;
    const name = session.roster.get(from)?.name ?? from;
    session.ringingIn.set(from, name);
    updateCallBanner();
    syncIncomingAlert();
    rebuildRoster();
    wake();
  });

  net.on("page_connect", (e) => {
    if (!session) return;
    const { peer, initiator } = e.detail;
    session.ringingOut.delete(peer);
    session.ringingIn.delete(peer);
    void session.audio.connect(peer, initiator, "page");
    session.pages.set(peer, session.roster.get(peer)?.name ?? peer);
    // Voice goes live only after both sides have accepted (PROTOCOL.md §page).
    void goLiveForPage();
    updateCallBanner();
    syncIncomingAlert();
    rebuildRoster();
    wake();
  });

  net.on("page_rejected", (e) => {
    if (!session) return;
    const name = session.roster.get(e.detail.to)?.name ?? t.someone;
    session.ringingOut.delete(e.detail.to);
    const reason = e.detail.reason;
    ui.showToast(pageRejectedCopy(reason, name));
    updateCallBanner();
    rebuildRoster();
    wake();
  });

  net.on("page_end", (e) => {
    if (!session) return;
    const { from } = e.detail;
    const wasIncoming = session.ringingIn.has(from);
    const name = session.ringingIn.get(from) ?? session.roster.get(from)?.name ?? from;
    // Pending offer cancelled / timed out, or live hang-up.
    session.ringingIn.delete(from);
    session.ringingOut.delete(from);
    session.audio.endPage(from); // keeps proximity audio if still near
    session.pages.delete(from);
    if (wasIncoming && e.detail.reason === "timeout") ui.showToast(t.pageMissed(name));
    session.remoteVideos.delete(from);
    syncVideoViews();
    if (session.pages.size === 0) {
      stopScreenShare();
      stopCamera();
    }
    updateCallBanner();
    syncIncomingAlert();
    void restoreMuteAfterPage();
    rebuildRoster();
    wake();
  });

  // --- Errors ---

  net.on("error", (e) => {
    ui.showToast(e.detail.message, "error");
  });
}

function pageRejectedCopy(reason: "dnd" | "busy" | "offline" | "declined" | "timeout", name: string): string {
  switch (reason) {
    case "dnd": return t.pageDnd(name);
    case "busy": return t.pageBusy(name);
    case "declined": return t.pageDeclined(name);
    case "timeout": return t.pageTimeout(name);
    case "offline": return t.pageOffline(name);
  }
}

/**
 * What the call banner is currently showing (and what Accept / Hang-up act on).
 * Priority: first incoming offer > live call > first outgoing ring.
 * Hang-up must only affect this focus — never tear down hidden concurrent rings.
 */
type CallFocus =
  | { mode: "in_call" }
  | { mode: "incoming"; peerId: string; name: string }
  | { mode: "outgoing"; peerId: string; name: string };

function callFocus(): CallFocus | null {
  if (!session) return null;
  if (session.ringingIn.size > 0) {
    const [peerId, name] = [...session.ringingIn.entries()][0];
    return { mode: "incoming", peerId, name };
  }
  if (session.pages.size > 0) return { mode: "in_call" };
  if (session.ringingOut.size > 0) {
    const [peerId, name] = [...session.ringingOut.entries()][0];
    return { mode: "outgoing", peerId, name };
  }
  return null;
}

/** Reflect page ring / live state on the call banner (see {@link callFocus}). */
function updateCallBanner(): void {
  if (!session) return;
  const focus = callFocus();

  if (focus?.mode === "in_call") {
    const n = session.pages.size;
    if (n === 1) {
      ui.setCall({ mode: "in_call", text: t.inCallWith([...session.pages.values()][0]) });
    } else {
      ui.setCall({ mode: "in_call", text: t.inCallN(n) });
    }
    syncScreenReopenButton();
    return;
  }

  // Not in a live page: hide screen-share chrome.
  ui.setScreenSharing(false);
  ui.setCameraOn(false);
  ui.setScreenShareView(null, "");
  ui.setScreenReopenVisible(false);
  session.visibleScreen = null;
  session.screenDismissed = false;
  session.localPromoted = false;

  if (focus?.mode === "incoming") {
    ui.setCall({ mode: "incoming", text: t.pageIncoming(focus.name) });
    return;
  }
  if (focus?.mode === "outgoing") {
    ui.setCall({ mode: "outgoing", text: t.pageCalling(focus.name) });
    return;
  }
  ui.setCall(null);
  syncScreenReopenButton();
}

/**
 * Ringtone + Dock/taskbar attention while any incoming offer is pending.
 * The in-app banner alone is invisible when the window is unfocused — without
 * this the ring→accept flow (PROTOCOL.md §page) times out silently (~25s).
 * Keeps ringing across concurrent offers; stops when `ringingIn` is empty.
 */
function syncIncomingAlert(): void {
  if (!session) return;
  if (session.ringingIn.size > 0) {
    session.audio.startRingtone();
    void requestWindowAttention(true);
  } else {
    session.audio.stopRingtone();
    void requestWindowAttention(false);
  }
}

/**
 * Ask the OS to surface the app (Dock bounce / taskbar flash). Critical keeps
 * requesting until focus; `active: false` clears the request where the WM
 * supports it (no-op on macOS for null).
 */
async function requestWindowAttention(active: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const win = getCurrentWindow();
    await win.requestUserAttention(
      active ? UserAttentionType.Critical : null,
    );
  } catch (err) {
    console.warn("[attention] requestUserAttention failed:", err);
  }
}

/** Pick the best remote video to show (page peers only; a screen share beats
 *  a camera, then earliest-started wins). */
function preferredRemoteVideo(): { peerId: string; stream: MediaStream; mode: "screen" | "camera" | null } | null {
  if (!session) return null;
  let first: { peerId: string; stream: MediaStream; mode: "screen" | "camera" | null } | null = null;
  for (const [peerId, entry] of session.remoteVideos) {
    if (!session.pages.has(peerId)) continue;
    if (entry.mode === "screen") return { peerId, ...entry };
    first ??= { peerId, ...entry };
  }
  return first;
}

function syncScreenReopenButton(): void {
  if (!session) return;
  const hasHidden =
    session.screenDismissed && preferredRemoteVideo() !== null && !session.visibleScreen;
  ui.setScreenReopenVisible(hasHidden);
}

/** Title for a remote peer's video panel. `mode` is briefly null right after
 *  the track attaches, before the peer's "video-mode" label arrives. */
function videoTitle(mode: "screen" | "camera" | null, peerName: string): string {
  if (mode === "camera") return t.peerCamera(peerName);
  if (mode === "screen") return t.sharedScreen(peerName);
  return t.peerVideo(peerName);
}

function handleRemoteVideo(peerId: string, stream: MediaStream | null, mode: "screen" | "camera" | null): void {
  if (!session) return;
  if (!session.pages.has(peerId)) return;

  if (stream) {
    session.remoteVideos.set(peerId, { stream, mode });
  } else {
    session.remoteVideos.delete(peerId);
  }
  syncVideoViews();
}

function handleLocalVideo(stream: MediaStream | null, mode: "screen" | "camera" | null): void {
  if (!session) return;
  ui.setScreenSharing(mode === "screen");
  ui.setCameraOn(mode === "camera");
  // Starting local video is an explicit gesture — bring a dismissed panel back.
  if (stream && mode) session.screenDismissed = false;
  syncVideoViews();
}

/**
 * Recompute both video surfaces from current state — the single place that
 * decides what goes where. The main panel shows the remote stream by default
 * (screen share beats camera); local video takes it only when nothing remote
 * exists or the user promoted it by clicking the self-view. Whichever active
 * stream is not in the main panel goes to the corner self-view.
 */
function syncVideoViews(): void {
  if (!session) return;
  const local = session.audio.screenShareStream ?? session.audio.cameraStream;
  const remote = preferredRemoteVideo();

  if (!local || !remote) session.localPromoted = false;
  // Dismissal minimizes the remote view; once nothing remote remains there is
  // nothing left dismissed, and the local preview may reclaim the panel.
  if (!remote) session.screenDismissed = false;

  if (session.screenDismissed) {
    session.visibleScreen = null;
    ui.setScreenShareView(null, ""); // also hides the self-view
    syncScreenReopenButton();
    return;
  }

  if (remote && !session.localPromoted) {
    session.visibleScreen = { kind: "remote", peerId: remote.peerId };
    ui.setScreenShareView(remote.stream, videoTitle(remote.mode, session.pages.get(remote.peerId) ?? remote.peerId));
    ui.setSelfView(local);
  } else if (local) {
    session.visibleScreen = { kind: "local" };
    ui.setScreenShareView(local, session.audio.isCameraOn ? t.yourCamera : t.yourScreen);
    ui.setSelfView(remote?.stream ?? null);
  } else {
    session.visibleScreen = null;
    ui.setScreenShareView(null, "");
  }
  syncScreenReopenButton();
}

// Unconditional: the engine no-ops when nothing is live, and it needs the call
// even then to cancel a capture still sitting in the OS picker (which is
// exactly the case an `isScreenSharing` guard here would hide).
function stopScreenShare(): void {
  if (!session) return;
  session.audio.stopScreenShare(); // fires handleLocalVideo(null), which re-syncs
}

function stopCamera(): void {
  if (!session) return;
  session.audio.stopCamera(); // fires handleLocalVideo(null), which re-syncs
}

/**
 * After a page is accepted, voice goes live for both peers (PROTOCOL.md §page).
 * If we're muted, auto-unmute (acquiring the mic) and tell the org. We remember
 * that we did so, to restore mute when the call ends. Accept/Answer is a user
 * gesture, so mic acquisition usually succeeds on the receiver path too.
 */
async function goLiveForPage(): Promise<void> {
  if (!session || !session.audio.isMuted) return;
  try {
    const muted = await session.audio.toggleMute();
    ui.setMuted(muted);
    renderer.setSelfMuted(muted);
    if (!muted) {
      session.pageAutoUnmuted = true;
      session.net.send({ t: "mute", muted: false });
    }
  } catch {
    /* mic denied; the user can still unmute from the banner */
  }
}

/** When the last page ends, restore mute if (and only if) we auto-unmuted for
 *  it and the user hasn't since taken manual control of the mic. */
async function restoreMuteAfterPage(): Promise<void> {
  if (!session || session.pages.size > 0) return;
  if (!session.pageAutoUnmuted) return;
  session.pageAutoUnmuted = false;
  if (session.audio.isMuted) return;
  try {
    const muted = await session.audio.toggleMute();
    ui.setMuted(muted);
    renderer.setSelfMuted(muted);
    session.net.send({ t: "mute", muted });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// UI actions
// ---------------------------------------------------------------------------

async function handleMicToggle(): Promise<void> {
  if (!session) return;
  markActive();
  // Manual mic control takes ownership: don't auto-restore mute after a page.
  session.pageAutoUnmuted = false;
  try {
    const muted = await session.audio.toggleMute();
    ui.setMuted(muted);
    renderer.setSelfMuted(muted);
    session.net.send({ t: "mute", muted });
    wake();
  } catch {
    ui.setMuted(true);
    // We're inside a session, so the join-card error area is hidden — surface
    // the failure where the user actually is.
    ui.showToast(t.errMicDenied, "error");
  }
}

function handleOpenAudioSettings(): void {
  if (!session) return;
  const audio = session.audio;
  void (async () => {
    // Device lists don't require mic permission (enumerateDevices always
    // works; labels are just blank without it) — resolve and open the panel
    // regardless of whether the preview below succeeds, so a denied/missing
    // mic doesn't also lock the user out of picking a speaker.
    const { inputs, outputs } = await audio.listDevices();
    ui.openAudioSettings(
      inputs.map((d) => ({ id: d.deviceId, label: d.label })),
      outputs.map((d) => ({ id: d.deviceId, label: d.label })),
      audio.micDevice ?? "",
      audio.speakerDevice ?? "",
    );
    cancelAnimationFrame(audioSettingsRaf);
    const meterLoop = () => {
      ui.setMicLevel(audio.getMicLevel());
      audioSettingsRaf = requestAnimationFrame(meterLoop);
    };
    meterLoop();
    try {
      await audio.startMicPreview(audio.micDevice);
    } catch {
      // Mic preview denied/unavailable: meter just stays at 0 — the panel
      // (and speaker selection) is still fully usable.
    }
  })().catch(() => ui.showToast(t.errMicDenied, "error"));
}

function handleCloseAudioSettings(): void {
  cancelAnimationFrame(audioSettingsRaf);
  session?.audio.stopMicPreview();
}

/**
 * In-app language switch: re-translate session-dependent chrome that was
 * rendered with the previous locale (roster labels, call banner text, space
 * tabs, screen-share titles, device "System default" label).
 */
function handleLocaleChange(): void {
  if (!session) return;

  rebuildRoster();
  setPeerCount();
  ui.setMuted(session.audio.isMuted);
  ui.setSelfStatus(session.away, session.dnd);
  ui.renderTabs(session.spaces, session.spaceId);
  updateCallBanner();

  // Screen-share / camera titles and button labels.
  ui.setScreenSharing(session.audio.isScreenSharing);
  ui.setCameraOn(session.audio.isCameraOn);
  syncVideoViews();

  // Audio-settings panel: refill so "System default" / field labels match.
  if (!document.getElementById("audio-settings")?.hasAttribute("hidden")) {
    void session.audio.listDevices().then(({ inputs, outputs }) => {
      if (!session) return;
      ui.openAudioSettings(
        inputs.map((d) => ({ id: d.deviceId, label: d.label })),
        outputs.map((d) => ({ id: d.deviceId, label: d.label })),
        session.audio.micDevice ?? "",
        session.audio.speakerDevice ?? "",
      );
    });
  }
}

async function handleMicDeviceChange(deviceId: string): Promise<void> {
  if (!session) return;
  const id = deviceId || null;
  try {
    await session.audio.setMicDevice(id);
    if (id) localStorage.setItem(LS_MIC_DEVICE, id);
    else localStorage.removeItem(LS_MIC_DEVICE);
  } catch {
    ui.showToast(t.errMicDenied, "error");
  }
}

async function handleSpeakerDeviceChange(deviceId: string): Promise<void> {
  if (!session) return;
  const id = deviceId || null;
  await session.audio.setSpeakerDevice(id);
  if (id) localStorage.setItem(LS_SPEAKER_DEVICE, id);
  else localStorage.removeItem(LS_SPEAKER_DEVICE);
}

function handleEnterSpace(spaceId: string): void {
  if (!session || spaceId === session.spaceId) return;
  markActive();
  session.net.send({ t: "enter_space", spaceId });
}

function handleCreateSpace(name: string): void {
  if (!session) return;
  markActive();
  session.net.send({ t: "create_space", name });
}

function handlePage(memberId: string): void {
  if (!session) return;
  markActive();
  // Optimistic outgoing UI until page_ringing / page_rejected arrives.
  const name = session.roster.get(memberId)?.name ?? memberId;
  session.ringingOut.set(memberId, name);
  updateCallBanner();
  session.net.send({ t: "page", to: memberId });
  wake();
}

/** Accept the offer currently shown on the banner (incoming focus only). */
function handlePageAccept(): void {
  if (!session) return;
  const focus = callFocus();
  if (focus?.mode !== "incoming") return;
  markActive();
  session.net.send({ t: "page_accept", to: focus.peerId });
  // Server will reply with page_connect; keep ringingIn until then so the
  // banner stays visible if accept is slow.
  wake();
}

/**
 * Act on the banner's current focus only (same priority as {@link callFocus}):
 * - in_call  → hang up every live page (banner aggregates them)
 * - incoming → decline that one offer (not hidden outgoing rings)
 * - outgoing → cancel that one ring (not hidden incoming offers)
 */
function handleHangUp(): void {
  if (!session) return;
  const focus = callFocus();
  if (!focus) return;

  if (focus.mode === "in_call") {
    for (const id of session.pages.keys()) {
      session.net.send({ t: "page_end", to: id });
      session.audio.endPage(id); // keeps proximity audio if still near
    }
    session.pages.clear();
    session.remoteVideos.clear();
    session.screenDismissed = false;
    stopScreenShare();
    stopCamera();
    void restoreMuteAfterPage();
  } else if (focus.mode === "incoming") {
    session.net.send({ t: "page_end", to: focus.peerId });
    session.ringingIn.delete(focus.peerId);
  } else {
    session.net.send({ t: "page_end", to: focus.peerId });
    session.ringingOut.delete(focus.peerId);
  }

  updateCallBanner();
  syncIncomingAlert();
  rebuildRoster();
  wake();
}

async function handleScreenShareToggle(): Promise<void> {
  if (!session) return;
  markActive();
  if (session.pages.size === 0) return;

  if (session.audio.isScreenSharing) {
    stopScreenShare();
    return;
  }

  // macOS gates whole-display capture behind the Screen Recording permission,
  // and a missing grant doesn't error — it yields black frames. Preflight in
  // Rust (which also triggers the one-time OS prompt) and explain instead of
  // shipping a black rectangle. Non-macOS builds report granted.
  if (isTauri()) {
    try {
      if (!(await invoke<boolean>("screen_capture_permission"))) {
        ui.setScreenSharing(false);
        ui.showScreenPermissionHelp(
          () => void invoke("open_screen_recording_settings").catch(() => {}),
          () => void relaunch(),
        );
        return;
      }
    } catch {
      // Older shell without the command — fall through and try the capture.
    }
  }

  try {
    await session.audio.startScreenShare();
  } catch {
    ui.setScreenSharing(false);
    ui.showToast(t.errScreenShare, "error");
  }
}

async function handleCameraToggle(): Promise<void> {
  if (!session) return;
  markActive();
  if (session.pages.size === 0) return;

  if (session.audio.isCameraOn) {
    stopCamera();
    return;
  }

  try {
    await session.audio.startCamera();
  } catch {
    ui.setCameraOn(false);
    ui.showToast(t.errCameraDenied, "error");
  }
}

function handleCloseScreenShare(): void {
  if (!session) return;
  if (session.visibleScreen?.kind === "local") {
    // Closing our own video means stop sending it.
    if (session.audio.isScreenSharing) stopScreenShare();
    else stopCamera();
    return;
  }
  session.screenDismissed = true;
  session.localPromoted = false;
  syncVideoViews();
}

function handleReopenScreenShare(): void {
  if (!session) return;
  session.screenDismissed = false;
  syncVideoViews();
}

/** Clicking the self-view swaps it with the main panel (e.g. "show my own
 *  screen share large"). Remote stays the default whenever a swap partner
 *  disappears — syncVideoViews clears the flag then. */
function handleSelfViewClick(): void {
  if (!session) return;
  session.localPromoted = !session.localPromoted;
  syncVideoViews();
}

function handleSetStatus(away: boolean, dnd: boolean): void {
  if (!session) return;
  session.away = away;
  session.dnd = dnd;
  session.net.send({ t: "set_status", away, dnd });
  rebuildRoster();
  if (away) window.clearTimeout(idleTimer);
  else resetIdleTimer();
}

// ---------------------------------------------------------------------------
// Leave / teardown
// ---------------------------------------------------------------------------

function handleLeave(): void {
  if (!session) return;
  userLeaving = true;
  window.clearTimeout(reconnectTimer);
  window.clearTimeout(idleTimer);
  reconnectState = "idle";
  droppedInCall = false;
  session.net.send({ t: "bye" });
  teardownSession();
  ui.showJoin();
}

function teardownSession(): void {
  if (!session) return;
  const s = session;
  session = null;

  window.clearTimeout(idleTimer);
  window.clearInterval(heartbeatTimer);
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  rafScheduled = false;
  cancelAnimationFrame(audioSettingsRaf);

  s.input.destroy();
  // destroy() also stopRingtone(); clear Dock/taskbar attention explicitly.
  s.audio.destroy();
  void requestWindowAttention(false);
  s.net.close();

  canvas.classList.remove("walkable", "can-page", "can-sit");
  renderer.setPageHover(null);
  renderer.reset();
  document.title = "Hiroba";
}
