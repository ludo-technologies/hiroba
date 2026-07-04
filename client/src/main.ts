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

import { HirobaNet } from "./net.js";
import { Renderer, type FrameLevels } from "./render.js";
import { InputHandler } from "./input.js";
import { AudioEngine } from "./audio.js";
import {
  UIManager,
  type InviteEntry,
  type JoinFormValues,
  type RosterEntry,
} from "./ui.js";
import { shouldDraw, shouldKeepAwake } from "./loop.js";
import { startUpdateChecks } from "./updater.js";
import { resolveIceServers } from "./config.js";
import { spaceLabel, t } from "./i18n.js";
import {
  clearSession,
  decodeClaims,
  isLive,
  isTauri,
  loadSession,
  oauthLogin,
  openExternal,
  saveSession,
  type AuthSession,
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

  /** Active page links: peer id → display name (for the call banner). */
  pages: Map<string, string>;

  /** User-controllable status flags (effective status is server-computed). */
  away: boolean;
  dnd: boolean;

  /** True if we auto-unmuted for a page so we can restore mute when it ends. */
  pageAutoUnmuted: boolean;
}

let session: Session | null = null;

// Reconnect bookkeeping.
const MAX_RECONNECT = 6;
let lastJoin: JoinFormValues | null = null;
let userLeaving = false; // suppresses reconnect when the user left on purpose
let reconnectAttempts = 0;
let reconnectTimer = 0;

// Loop bookkeeping.
let rafId = 0;
let rafScheduled = false;
let dirty = false;
let wasAnimating = false;

// Ambient-prompt state.
let moveHintActive = false;
let nudgeShown = false;

// Idle → away (NFR-01: dim + go quiet after inactivity).
const IDLE_MS = 5 * 60 * 1000; // provisional 5 minutes
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
    onLogin: handleLogin,
    onLogout: handleLogout,
    onCreateOrg: handleCreateOrg,
    onCancelOrgSetup: handleCancelOrgSetup,
    onOpenInvitePanel: handleOpenInvitePanel,
    onIssueInvite: handleIssueInvite,
    onRevokeInvite: handleRevokeInvite,
    onOpenBilling: handleOpenBilling,
    onMicToggle: handleMicToggle,
    onLeave: handleLeave,
    onCancelReconnect: handleCancelReconnect,
    onEnterSpace: handleEnterSpace,
    onCreateSpace: handleCreateSpace,
    onPage: handlePage,
    onHangUp: handleHangUp,
    onSetStatus: handleSetStatus,
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

// Push-to-toggle mute shortcut (M) — standard in voice tools. Ignores typing
// contexts and modifier chords so it never hijacks text input or app shortcuts.
window.addEventListener("keydown", (e) => {
  if (!session) return;
  if (e.code !== "KeyM" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const tgt = e.target;
  if (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement) return;
  void handleMicToggle();
});

// Click-to-walk: a click (or tap) on the floor sets the walk destination;
// dragging with the button held steers it. Keyboard input still wins —
// input.ts drops the target on the first movement key.
function pointToWalk(e: PointerEvent): void {
  if (!session || !e.isPrimary) return;
  const world = renderer.screenToWorld(e.clientX, e.clientY);
  if (!world) return;
  session.input.setMoveTarget(world.x, world.y);
}
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  pointToWalk(e);
});
canvas.addEventListener("pointermove", (e) => {
  if (e.buttons !== 1) return;
  pointToWalk(e);
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

void (async () => {
  authSession = await loadSession();
  if (authSession) reflectAuthSession();
})();

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
}

async function handleLogin(
  provider: "google" | "github",
  authUrl: string,
  invite: string,
): Promise<void> {
  ui.setLoginBusy(true);
  try {
    const result = await oauthLogin(authUrl, provider, invite || undefined);
    if (result.kind === "pending_org") {
      // First sign-in, no invite: the user names their org before a session
      // exists. The provisional token only authorizes POST /orgs.
      pendingProvisionalToken = result.provisionalToken;
      ui.showOrgSetup();
      return;
    }
    await saveSession(result.session);
    authSession = result.session;
    if (invite) ui.clearInvite();
    reflectAuthSession();
  } catch (err) {
    ui.showError(err instanceof Error ? err.message : t.errSignIn);
  } finally {
    ui.setLoginBusy(false);
  }
}

function handleLogout(): void {
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
      body: JSON.stringify({ name }),
    });
    if (resp.status === 403) throw new Error(t.errAlreadyInOrg);
    if (resp.status === 401) throw new Error(t.errSessionExpired);
    if (!resp.ok) throw new Error(t.errOrgCreate);
    const data: { token: string } = await resp.json();
    const claims = decodeClaims(data.token);
    if (!claims) throw new Error(t.errOrgCreate);
    pendingProvisionalToken = null;
    const session: AuthSession = { token: data.token, claims };
    await saveSession(session);
    authSession = session;
    ui.hideOrgSetup();
    reflectAuthSession();
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

/** The token a new connection should present: a manual (Advanced) token wins,
 *  then a live OAuth session; otherwise guest. Expired sessions are dropped
 *  on the spot so we don't knock on the server with a dead JWT. */
function effectiveToken(manual: string): string {
  if (manual) return manual;
  if (authSession && !isLive(authSession.claims)) {
    handleLogout();
    ui.showError(t.errSessionExpired);
  }
  return authSession?.token ?? "";
}

// ---------------------------------------------------------------------------
// Connection orchestration
// ---------------------------------------------------------------------------

function openConnection(values: JoinFormValues): Promise<{ net: HirobaNet; msg: WelcomeMsg }> {
  return new Promise((resolve, reject) => {
    const net = new HirobaNet();
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error("connection failed"));
    };
    net.onError(fail);
    net.onClose(fail);
    net
      .connect(values.serverUrl)
      .then(() => {
        net.send({
          t: "hello",
          token: values.token || undefined,
          name: values.name,
          color: values.color,
          avatar: values.avatar || undefined,
        });
        net.on(
          "welcome",
          (e) => {
            if (settled) return;
            settled = true;
            resolve({ net, msg: e.detail });
          },
          { once: true },
        );
      })
      .catch(fail);
  });
}

async function connectSession(
  values: JoinFormValues,
): Promise<{ net: HirobaNet; msg: WelcomeMsg; iceServers: RTCIceServer[] }> {
  // Resolve ICE before opening the WebSocket so a slow /ice response cannot
  // leave post-welcome events arriving before session handlers are installed.
  const iceServers = await resolveIceServers(values.serverUrl, values.token);
  const { net, msg } = await openConnection(values);
  return { net, msg, iceServers };
}

async function handleJoin(values: JoinFormValues): Promise<void> {
  // Resolve the token once and remember it, so auto-reconnect reuses the same
  // credential the session was opened with.
  values = { ...values, token: effectiveToken(values.token) };
  lastJoin = values;
  userLeaving = false;
  reconnectAttempts = 0;
  try {
    const { net, msg, iceServers } = await connectSession(values);
    startSession(net, msg, iceServers);
    moveHintActive = true;
    ui.showMoveHint();
  } catch {
    ui.showJoin(t.errConnect);
  }
}

function startSession(net: HirobaNet, msg: WelcomeMsg, iceServers: RTCIceServer[]): void {
  net.onClose(onSessionDropped);
  net.onError(onSessionDropped);

  initSession(net, msg, iceServers);
  bindServerMessages(net);
  reconnectAttempts = 0;
  canvas.classList.add("walkable"); // pointer cursor: the floor is clickable
  ui.showSpace();
  resetIdleTimer();
  wake();
}

function onSessionDropped(): void {
  if (userLeaving || !session) return;
  teardownSession();
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (!lastJoin) {
    ui.showJoin(t.errRejoin);
    return;
  }
  if (reconnectAttempts >= MAX_RECONNECT) {
    ui.showJoin(t.errRejoin);
    return;
  }
  const attempt = ++reconnectAttempts;
  const delay = Math.min(8000, 400 * 2 ** (attempt - 1));
  ui.showReconnecting(attempt, MAX_RECONNECT);
  reconnectTimer = window.setTimeout(async () => {
    if (userLeaving || !lastJoin) return;
    try {
      const { net, msg, iceServers } = await connectSession(lastJoin);
      if (userLeaving) {
        net.close();
        return;
      }
      startSession(net, msg, iceServers);
    } catch {
      scheduleReconnect();
    }
  }, delay);
}

function handleCancelReconnect(): void {
  window.clearTimeout(reconnectTimer);
  reconnectAttempts = 0;
  userLeaving = true;
  ui.showJoin();
}

// ---------------------------------------------------------------------------
// Session initialization (from `welcome`)
// ---------------------------------------------------------------------------

function initSession(net: HirobaNet, msg: WelcomeMsg, iceServers: RTCIceServer[]): void {
  const input = new InputHandler();
  const audio = new AudioEngine();

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
    away: false,
    dnd: false,
    pageAutoUnmuted: false,
  };

  ui.setOrgName(msg.org.name);
  document.title = `Hiroba — ${msg.org.name}`;
  ui.setMuted(audio.isMuted);
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
  session.away = true;
  ui.setSelfStatus(true, session.dnd);
  session.net.send({ t: "set_status", away: true });
  rebuildRoster();
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

  // --- Paging (cross-space 1:1) ---

  net.on("page_connect", (e) => {
    if (!session) return;
    const { peer, initiator } = e.detail;
    void session.audio.connect(peer, initiator, "page");
    session.pages.set(peer, session.roster.get(peer)?.name ?? peer);
    // Barge-in: voice goes live immediately for both peers (PROTOCOL.md §page).
    void goLiveForPage();
    updateCallBanner();
    rebuildRoster();
    wake();
  });

  net.on("page_rejected", (e) => {
    if (!session) return;
    const name = session.roster.get(e.detail.to)?.name ?? t.someone;
    ui.showToast(e.detail.reason === "dnd" ? t.pageDnd(name) : t.pageOffline(name));
  });

  net.on("page_end", (e) => {
    if (!session) return;
    const { from } = e.detail;
    session.audio.endPage(from); // keeps proximity audio if still near
    session.pages.delete(from);
    updateCallBanner();
    void restoreMuteAfterPage();
    rebuildRoster();
    wake();
  });

  // --- Errors ---

  net.on("error", (e) => {
    ui.showToast(e.detail.message, "error");
  });
}

/** Reflect the current page links on the call banner. */
function updateCallBanner(): void {
  if (!session) return;
  const n = session.pages.size;
  if (n === 0) ui.setCall(null);
  else if (n === 1) ui.setCall(t.inCallWith([...session.pages.values()][0]));
  else ui.setCall(t.inCallN(n));
}

/**
 * Barge-in: a page makes voice live immediately (PROTOCOL.md §page). If we're
 * muted, auto-unmute (acquiring the mic) and tell the org. We remember that we
 * did so, to restore mute when the call ends. Mic acquisition needs a gesture;
 * if it fails (e.g. the *receiver* with no gesture/permission) we fall back to
 * muted — the in-call banner still lets the user unmute with one click.
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
  session.net.send({ t: "page", to: memberId });
}

function handleHangUp(): void {
  if (!session) return;
  for (const id of session.pages.keys()) {
    session.net.send({ t: "page_end", to: id });
    session.audio.endPage(id); // keeps proximity audio if still near
  }
  session.pages.clear();
  updateCallBanner();
  void restoreMuteAfterPage();
  rebuildRoster();
  wake();
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
  session.net.send({ t: "bye" });
  teardownSession();
  ui.showJoin();
}

function teardownSession(): void {
  if (!session) return;
  const s = session;
  session = null;

  window.clearTimeout(idleTimer);
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  rafScheduled = false;

  s.input.destroy();
  s.audio.destroy();
  s.net.close();

  canvas.classList.remove("walkable");
  renderer.reset();
  document.title = "Hiroba";
}
