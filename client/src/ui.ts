/**
 * ui.ts — DOM wiring for Hiroba's join form, HUD, and ambient prompts.
 *
 * Responsibilities:
 *  - Join overlay: identity (name + live avatar preview), curated color
 *    swatches with a custom-color escape hatch, and an Advanced disclosure for
 *    the server URL so guests aren't confronted with it (FR-09, FR-10).
 *  - Persistence of name/color/server to localStorage (FR-10).
 *  - HUD: peer count, mic toggle (with a drawn glyph), Leave.
 *  - Ambient prompts: a first-run movement hint, a calm "unmute to talk"
 *    nudge, and a reconnecting overlay for unexpected drops.
 *
 * This module owns the DOM; it does NOT own app state. main.ts passes callbacks
 * so the layers stay decoupled.
 */

import type { SpaceDescriptor } from "./protocol.js";
import {
  applyStaticI18n,
  locale,
  setLocale,
  spaceLabel,
  t,
  type Locale,
} from "./i18n.js";
import { CODE_LENGTH, extractInviteCode, sanitizeCode, type OrgSummary } from "./auth.js";
import { CustomSelect, type SelectOption } from "./select.js";
import { bindOverlayDismiss } from "./overlay.js";

// ---------------------------------------------------------------------------
// LocalStorage keys
// ---------------------------------------------------------------------------

const LS_NAME = "hiroba_name";
const LS_COLOR = "hiroba_color";
const LS_AVATAR = "hiroba_avatar";
const LS_SERVER = "hiroba_server";
const LS_TOKEN = "hiroba_token";
const LS_AUTH = "hiroba_auth_server";

// Default signaling / auth URLs, baked in at build time via Vite's
// `VITE_HIROBA_SERVER` / `VITE_HIROBA_AUTH_SERVER` (set in the environment or
// a `.env` file). The loopback fallback exists ONLY under `vite dev`: the
// `import.meta.env.DEV` branch is statically eliminated from production
// bundles, and vite.config.ts refuses to build without both vars — so a
// distribution build can never silently point at 127.0.0.1 (the `!` below is
// backed by that build-time check). A user's Advanced override in localStorage
// takes precedence: the inputs are seeded with these defaults in
// `_restoreFromStorage` and then overwritten by any saved value.
const DEFAULT_SERVER: string = import.meta.env.DEV
  ? import.meta.env.VITE_HIROBA_SERVER || "ws://127.0.0.1:8787/ws"
  : import.meta.env.VITE_HIROBA_SERVER!;
const DEFAULT_AUTH_SERVER: string = import.meta.env.DEV
  ? import.meta.env.VITE_HIROBA_AUTH_SERVER || "http://127.0.0.1:8788"
  : import.meta.env.VITE_HIROBA_AUTH_SERVER!;

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/** Persist a URL only when it deviates from the build-time default. Storing
 *  the resolved value would pin the user to whatever default this build
 *  shipped — so a later build could never move them to a new default, and a
 *  dev run's loopback would leak into a release build (dev and release share
 *  the WebView storage under the same Tauri identifier). */
function persistUrlDeviation(key: string, value: string, defaultValue: string): void {
  if (value === defaultValue) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

/** Side length the uploaded avatar is centre-cropped + downscaled to.
 *  256 keeps photos crisp now that floor tokens render at ~240 physical px
 *  in a team space on a hi-DPI display. */
const AVATAR_SIZE = 256;

/** Client-side cap on the encoded data URL; mirrors the server's 64 KB gate
 *  (state.rs MAX_AVATAR_LEN) so an avatar we accept is never silently dropped. */
const AVATAR_MAX_CHARS = 64 * 1024;

/** Curated friendly palette offered as one-tap swatches. Each carries a
 *  localized name so a swatch announces "Clay", not "#b54f2c" (the catalog is
 *  read lazily so the labels follow a language switch). */
const PALETTE: { hex: string; name: () => string }[] = [
  { hex: "#b54f2c", name: () => t.colorClay }, // accent
  { hex: "#e6a94e", name: () => t.colorAmber },
  { hex: "#d9594f", name: () => t.colorCoral },
  { hex: "#86b27a", name: () => t.colorSage },
  { hex: "#4f9dde", name: () => t.colorSky },
  { hex: "#b07ad0", name: () => t.colorLilac },
  { hex: "#46b9b0", name: () => t.colorTeal },
  { hex: "#8a93a6", name: () => t.colorSlate },
];

// ---------------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------------

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required DOM element: #${id}`);
  return el as T;
}

const elJoin = $<HTMLDivElement>("join");
const elJoinForm = $<HTMLFormElement>("join-form");
const elJoinName = $<HTMLInputElement>("join-name");
const elJoinColor = $<HTMLInputElement>("join-color");
const elJoinServer = $<HTMLInputElement>("join-server");
const elJoinToken = $<HTMLInputElement>("join-token");
const elJoinAuth = $<HTMLInputElement>("join-auth");
const elJoinInvite = $<HTMLInputElement>("join-invite");
const elAuthBlock = $<HTMLDivElement>("auth-block");
const elAuthActions = $<HTMLDivElement>("auth-actions");
const elAuthRestoring = $<HTMLDivElement>("auth-restoring");
const elLoginGoogle = $<HTMLButtonElement>("login-google");
const elLoginGithub = $<HTMLButtonElement>("login-github");
// Label spans inside the buttons — busy text swaps these, not textContent,
// so the inline provider logos survive.
const elLoginGoogleLabel = elLoginGoogle.querySelector<HTMLSpanElement>(".oauth-label")!;
const elLoginGithubLabel = elLoginGithub.querySelector<HTMLSpanElement>(".oauth-label")!;
const elEmailStep = $<HTMLDivElement>("email-step");
const elLoginEmail = $<HTMLInputElement>("login-email");
const elLoginEmailSend = $<HTMLButtonElement>("login-email-send");
const elLoginEmailSendLabel = elLoginEmailSend.querySelector<HTMLSpanElement>(".oauth-label")!;
const elCodeStep = $<HTMLDivElement>("code-step");
const elCodeSentMsg = $<HTMLParagraphElement>("code-sent-msg");
const elLoginCode = $<HTMLInputElement>("login-code");
const elLoginCodeVerify = $<HTMLButtonElement>("login-code-verify");
const elLoginCodeVerifyLabel = elLoginCodeVerify.querySelector<HTMLSpanElement>(".oauth-label")!;
const elLoginCodeResend = $<HTMLButtonElement>("login-code-resend");
const elLoginCodeBack = $<HTMLButtonElement>("login-code-back");
const elAuthSession = $<HTMLDivElement>("auth-session");
const elAuthUser = $<HTMLSpanElement>("auth-user");
const elAuthOrgSelect = $<HTMLDivElement>("auth-org-select");
const elAuthLogout = $<HTMLButtonElement>("auth-logout");
const elJoinBtn = $<HTMLButtonElement>("join-btn");
const elJoinError = $<HTMLParagraphElement>("join-error");
const elJoinSettingsBtn = $<HTMLButtonElement>("join-settings-btn");
const elServerSettings = $<HTMLDivElement>("server-settings");
const elServerSettingsClose = $<HTMLButtonElement>("server-settings-close");
const elLangSwitchServerSettings = $<HTMLDivElement>("lang-switch-server-settings");
const elSwatches = $<HTMLDivElement>("color-swatches");
const elAvatar = $<HTMLButtonElement>("avatar-preview");
const elAvatarInitial = $<HTMLSpanElement>("avatar-initial");
const elAvatarRemove = $<HTMLButtonElement>("avatar-remove");
const elAvatarFile = $<HTMLInputElement>("avatar-file");

const elOrgSetup = $<HTMLDivElement>("org-setup");
const elOrgSetupName = $<HTMLInputElement>("org-setup-name");
const elOrgSetupBtn = $<HTMLButtonElement>("org-setup-btn");
const elOrgSetupBack = $<HTMLButtonElement>("org-setup-back");

const elBillingLock = $<HTMLDivElement>("billing-lock");
const elBillingLockTitle = $<HTMLHeadingElement>("billing-lock-title");
const elBillingLockDesc = $<HTMLParagraphElement>("billing-lock-desc");
const elBillingLockCta = $<HTMLButtonElement>("billing-lock-cta");
const elBillingLockOrgs = $<HTMLDivElement>("billing-lock-orgs");
const elBillingLockOrgsList = $<HTMLDivElement>("billing-lock-orgs-list");

const elAdminMenuBtn = $<HTMLButtonElement>("admin-menu-btn");
const elAdminMenu = $<HTMLDivElement>("admin-menu");
const elBillingBtn = $<HTMLButtonElement>("billing-panel-btn");

const elInvitePanel = $<HTMLDivElement>("invite-panel");
const elInvitePanelBtn = $<HTMLButtonElement>("invite-panel-btn");
const elRosterInviteBtn = $<HTMLButtonElement>("roster-invite-btn");
const elInvitePanelClose = $<HTMLButtonElement>("invite-panel-close");
const elInviteRoleHost = $<HTMLElement>("invite-role");
const elInviteIssueBtn = $<HTMLButtonElement>("invite-issue-btn");
const elInviteResult = $<HTMLDivElement>("invite-result");
const elInviteResultCode = $<HTMLDivElement>("invite-result-code");
const elInviteCopyLink = $<HTMLButtonElement>("invite-copy-link");
const elInviteCopyCode = $<HTMLButtonElement>("invite-copy-code");
const elInviteList = $<HTMLUListElement>("invite-list");
const elInvitePanelError = $<HTMLParagraphElement>("invite-panel-error");

const elScreenPerm = $<HTMLDivElement>("screen-perm");
const elScreenPermClose = $<HTMLButtonElement>("screen-perm-close");
const elScreenPermOpen = $<HTMLButtonElement>("screen-perm-open");
const elScreenPermRelaunch = $<HTMLButtonElement>("screen-perm-relaunch");
const elMembersPanel = $<HTMLDivElement>("members-panel");
const elMembersPanelBtn = $<HTMLButtonElement>("members-panel-btn");
const elMembersPanelClose = $<HTMLButtonElement>("members-panel-close");
const elMemberList = $<HTMLUListElement>("member-list");
const elMembersPanelError = $<HTMLParagraphElement>("members-panel-error");

const elReconnect = $<HTMLDivElement>("reconnect");
const elReconnectMsg = $<HTMLParagraphElement>("reconnect-msg");
const elReconnectCancel = $<HTMLButtonElement>("reconnect-cancel");

const elHud = $<HTMLDivElement>("hud");
const elMic = $<HTMLButtonElement>("mic");
const elMicLabel = $<HTMLSpanElement>("mic-label");
const elCount = $<HTMLSpanElement>("count");
const elLeave = $<HTMLButtonElement>("leave");

const elAudioSettingsBtn = $<HTMLButtonElement>("audio-settings-btn");
const elAudioSettings = $<HTMLDivElement>("audio-settings");
const elAudioSettingsClose = $<HTMLButtonElement>("audio-settings-close");
const elMicSelectHost = $<HTMLElement>("mic-device-select");
const elSpeakerSelectHost = $<HTMLElement>("speaker-device-select");
const elLangSwitchSettings = $<HTMLDivElement>("lang-switch-settings");
const elMicLevel = $<HTMLDivElement>("mic-level");
const elMicLevelBar = $<HTMLDivElement>("mic-level-bar");

const elOnboard = $<HTMLDivElement>("onboard");
const elNudge = $<HTMLDivElement>("mute-nudge");

const elSidebar = $<HTMLElement>("sidebar");
const elOrgName = $<HTMLSpanElement>("org-name");
const elRoster = $<HTMLUListElement>("roster");
const elStatusActive = $<HTMLButtonElement>("status-active");
const elStatusAway = $<HTMLButtonElement>("status-away");
const elStatusDnd = $<HTMLButtonElement>("status-dnd");
const elTabs = $<HTMLElement>("tabs");
const elCallBanner = $<HTMLDivElement>("call-banner");
const elCallText = $<HTMLSpanElement>("call-text");
const elScreenShare = $<HTMLButtonElement>("screen-share");
const elCameraToggle = $<HTMLButtonElement>("camera-toggle");
const elScreenReopen = $<HTMLButtonElement>("screen-reopen");
const elCallAccept = $<HTMLButtonElement>("call-accept");
const elHangup = $<HTMLButtonElement>("hangup");
const elScreenPanel = $<HTMLDivElement>("screen-panel");
const elScreenTitle = $<HTMLSpanElement>("screen-title");
const elScreenClose = $<HTMLButtonElement>("screen-close");
const elScreenFullscreen = $<HTMLButtonElement>("screen-fullscreen");
const elScreenVideo = $<HTMLVideoElement>("screen-video");
const elSelfView = $<HTMLButtonElement>("self-view");
const elSelfVideo = $<HTMLVideoElement>("self-video");
const elToasts = $<HTMLDivElement>("toasts");
const elUpdateBanner = $<HTMLDivElement>("update-banner");
const elUpdateText = $<HTMLSpanElement>("update-text");
const elUpdateInstall = $<HTMLButtonElement>("update-install");
const elUpdateLater = $<HTMLButtonElement>("update-later");

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface JoinFormValues {
  name: string;
  color: string;
  /** Uploaded avatar as a small data URL; empty when none is set. */
  avatar: string;
  serverUrl: string;
  /** Optional access token; empty for a self-host guest session. */
  token: string;
}

/** What the signed-in chip displays (from the session JWT's claims). */
export interface AuthDisplay {
  name: string;
  org: string;
  role: string;
}

/** An unused invite row shown in the admin panel (mirrors GET /invites). */
export interface InviteEntry {
  token: string;
  role: string;
  /** Unix seconds. */
  expiresAt: number;
  creator: string;
}

/** An org member shown in the admin panel (mirrors GET /members). */
export interface MemberEntry {
  /** Provider-prefixed JWT subject, e.g. `google:1098…`. */
  subject: string;
  name: string;
  role: string;
  isSelf: boolean;
}

export interface UICallbacks {
  onJoin(values: JoinFormValues): void;
  /** Cancel the current connection attempt. */
  onCancelConnect(): void;
  /** Start an interactive OAuth login via the Tauri shell (FR-13). */
  onLogin(provider: "google" | "github", authUrl: string, invite: string): void;
  /** Ask the auth backend to mail a one-time login code. */
  onEmailStart(email: string, authUrl: string): void;
  /** Trade a mailed code for a session. */
  onEmailVerify(code: string, authUrl: string, invite: string): void;
  /** Drop the stored session and return to the signed-out state. */
  onLogout(): void;
  /** Re-anchor the session in another org the user belongs to (chip dropdown
   *  or the billing-lock escape hatch). */
  onSwitchOrg(orgSlug: string): void;
  /** Found the org for a pending first sign-in (org-setup step). */
  onCreateOrg(name: string): void;
  /** Abandon the org-setup step and return to the sign-in form. */
  onCancelOrgSetup(): void;
  /** Admin opened the invite panel — load the current invite list. */
  onOpenInvitePanel(): void;
  /** Admin issues a new invite with the chosen role. */
  onIssueInvite(role: "member" | "admin"): void;
  /** Admin revokes an unused invite. */
  onRevokeInvite(token: string): void;
  /** Admin opened the member panel — load the current member list. */
  onOpenMembersPanel(): void;
  /** Admin removes a member from the org (frees their seat). */
  onRemoveMember(subject: string): void;
  /** Admin opens the Stripe Customer Portal (add card / change plan / cancel). */
  onOpenBilling(): void;
  onMicToggle(): void;
  /** Gear next to the mic button opened the audio-settings panel. */
  onOpenAudioSettings(): void;
  /** The audio-settings panel closed (stop any mic preview). */
  onCloseAudioSettings(): void;
  /** Chose a microphone from the audio-settings panel ("" = system default). */
  onMicDeviceChange(deviceId: string): void;
  /** Chose a speaker from the audio-settings panel ("" = system default). */
  onSpeakerDeviceChange(deviceId: string): void;
  onLeave(): void;
  /** Cancel an in-progress auto-reconnect and return to the join screen. */
  onCancelReconnect(): void;
  /** Switch to another space (tab click). */
  onEnterSpace(spaceId: string): void;
  /** Create a new team space with the given name (FR-14). */
  onCreateSpace(name: string): void;
  /** Start a page (cross-space 1:1) with a roster member (FR-10). */
  onPage(memberId: string): void;
  /** Accept an incoming page offer. */
  onPageAccept(): void;
  /** Hang up a live page, cancel an outgoing ring, or decline an incoming offer. */
  onHangUp(): void;
  /** Start or stop screen sharing in the current page link. */
  onScreenShareToggle(): void;
  /** Start or stop sending the camera in the current page link. */
  onCameraToggle(): void;
  /** Hide/stop the currently visible screen-share panel. */
  onCloseScreenShare(): void;
  /** Swap the picture-in-picture self-view with the main video panel. */
  onSelfViewClick(): void;
  /** Re-show a remote screen share after the panel was dismissed. */
  onReopenScreenShare(): void;
  /**
   * Set the user-controllable status flags. UI sends exclusive combinations:
   * Active → (false, false), Away → (true, false), DND → (false, true).
   */
  onSetStatus(away: boolean, dnd: boolean): void;
  /**
   * UI language changed via the in-app switcher. Re-render dynamic strings
   * (roster, call banner, space tabs, …) that were translated earlier.
   */
  onLocaleChange(): void;
}

/** Call banner mode: live conversation vs ring states. */
export type CallBannerMode = "in_call" | "outgoing" | "incoming";

/**
 * A roster row, fully prepared by main.ts (which knows the space catalog and
 * self state). The UI just renders it.
 */
export interface RosterEntry {
  id: string;
  name: string;
  color: string;
  /** Uploaded avatar data URL, shown in place of the color dot when present. */
  avatar?: string;
  /** Right-side status / space text (e.g. "Lobby", "In call", "Away"). */
  label: string;
  tone: "active" | "away" | "dnd" | "in_call" | "offline";
  isSelf: boolean;
  /** Whether to offer a "page" button on this row. */
  canPage: boolean;
}

/** The reconnect overlay's message, derived so `showReconnecting` and the
 *  locale re-render can't drift apart. */
function reconnectCopy(state: { attempt: number; max: number; offline: boolean }): string {
  if (state.offline) return t.reconnectOffline;
  return state.attempt <= 1 ? t.reconnecting : t.reconnectAttempt(state.attempt, state.max);
}

// ---------------------------------------------------------------------------
// UI manager
// ---------------------------------------------------------------------------

export class UIManager {
  private callbacks: UICallbacks;
  private custom = false; // whether the current color came from the custom picker
  private avatar = ""; // uploaded avatar data URL ("" = none, use initial+color)
  private onboardTimer = 0;

  /** Running under Tauri: interactive login is possible and the session token
   *  lives in the OS keychain, so localStorage must NOT hold tokens. */
  private tauri: boolean;

  // Self status flags, mirrored on the exclusive Active / Away / DND control.
  // Server effective priority is in_call > dnd > away; the UI shows one choice
  // (dnd wins over away when both flags are set, e.g. idle while on DND).
  private away = false;
  private dnd = false;

  // Invite issued last (for the copy buttons) + the auth base to build links.
  private inviteToken = "";
  private inviteAuthBase = "";

  // Last values for dynamic chrome so a mid-session locale switch can re-paint
  // without round-tripping through main.ts for UI-owned state.
  private lastMuted = true;
  private lastPeerCount = 1;
  /** Last value pushed to the level meter's ARIA state (0..100), so a 60 Hz
   *  meter loop only touches the DOM when the rounded level actually moves. */
  private lastMicLevelPct = 0;
  private lastCall: { mode: CallBannerMode; text: string } | null = null;
  private lastScreenSharing = false;
  private lastCameraOn = false;
  private lastScreenFullscreen = false;
  private lastScreenReopenVisible = false;
  private lastInvites: InviteEntry[] | null = null;
  private lastMembers: MemberEntry[] | null = null;
  private lastReconnect: { attempt: number; max: number; offline: boolean } | null = null;
  private lastUpdateVersion: string | null = null;
  private lastLoginBusy = false;
  private lastEmailBusy = false;
  private lastCodeBusy = false;
  /** Address a code was mailed to, while the code step is on screen. */
  private codeSentTo: string | null = null;
  private lastOrgSetupBusy = false;
  private lastInviteIssueBusy = false;
  /** Billing-lock notice currently shown on the join card, if any. */
  private lastBillingLock: { trial: boolean; admin: boolean } | null = null;
  /** What the signed-in chip shows, kept for re-rendering when the org list
   *  arrives (it comes from a separate, slower request than the session). */
  private lastAuth: AuthDisplay | null = null;
  private lastOrgs: OrgSummary[] = [];
  private lastOrgSlug = "";

  private readonly inviteRoleSelect: CustomSelect;
  private readonly orgSelect: CustomSelect;
  private readonly micSelect: CustomSelect;
  private readonly speakerSelect: CustomSelect;

  constructor(callbacks: UICallbacks, opts: { tauri: boolean }) {
    this.callbacks = callbacks;
    this.tauri = opts.tauri;
    applyStaticI18n(); // resolve data-i18n* before the user can read the DOM

    this.inviteRoleSelect = new CustomSelect(elInviteRoleHost, {
      options: [
        { value: "member", label: t.roleMember },
        { value: "admin", label: t.roleAdmin },
      ],
      value: "member",
    });
    this.orgSelect = new CustomSelect(elAuthOrgSelect, {
      onChange: (orgSlug) => this.callbacks.onSwitchOrg(orgSlug),
      ariaLabel: t.orgSwitchAria,
    });
    this.micSelect = new CustomSelect(elMicSelectHost, {
      onChange: (deviceId) => this.callbacks.onMicDeviceChange(deviceId),
      ariaLabel: t.fieldMicrophone,
    });
    this.speakerSelect = new CustomSelect(elSpeakerSelectHost, {
      onChange: (deviceId) => this.callbacks.onSpeakerDeviceChange(deviceId),
      ariaLabel: t.fieldSpeaker,
    });

    this._buildSwatches();
    this._restoreFromStorage();
    this._bindForm();
    this._bindServerSettings();
    this._bindLangSwitch();
    this._bindAuth();
    this._bindOrgSetup();
    this._bindBillingLock();
    this._bindInvitePanel();
    this._bindMembersPanel();
    this._bindHud();
    this._bindScreenPerm();
    this._bindAudioSettings();
    this._bindReconnect();
    this._bindSidebar();
    this._refreshAvatar();
    // No loopback receiver in a plain browser → no interactive login there.
    // Under Tauri a stored session may still be on its way in, so the sign-in
    // buttons wait rather than greet a signed-in user with a login form.
    if (this.tauri) this.setAuthRestoring(true);
    else elAuthBlock.setAttribute("hidden", "");
  }

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  /** Show the join overlay and hide everything else (leave / error / give-up). */
  showJoin(error?: string): void {
    elJoin.removeAttribute("hidden");
    elReconnect.setAttribute("hidden", "");
    elHud.setAttribute("hidden", "");
    this.micSelect.close();
    this.speakerSelect.close();
    elAudioSettings.setAttribute("hidden", "");
    elSidebar.setAttribute("hidden", "");
    elTabs.setAttribute("hidden", "");
    this.hideOrgSetup();
    this.hideInvitePanel();
    this.setCall(null);
    this.hideMoveHint();
    this.setMuteNudge(false);
    elJoinBtn.disabled = false;
    delete elJoinBtn.dataset.connecting;
    elJoinBtn.textContent = t.enter;
    if (error) {
      elJoinError.textContent = error;
      elJoinError.removeAttribute("hidden");
    } else {
      elJoinError.setAttribute("hidden", "");
    }
    // Land the keyboard where the user will type (or just hit Enter to rejoin).
    elJoinName.focus();
  }

  /** Hide the overlays and show the HUD + sidebar + tabs (on connection). */
  showSpace(): void {
    elJoin.setAttribute("hidden", "");
    elServerSettings.setAttribute("hidden", "");
    elReconnect.setAttribute("hidden", "");
    elHud.removeAttribute("hidden");
    elSidebar.removeAttribute("hidden");
    elTabs.removeAttribute("hidden");
    elJoinError.setAttribute("hidden", "");
    elJoinBtn.disabled = false;
    delete elJoinBtn.dataset.connecting;
    elJoinBtn.textContent = t.enter;
    // Join via Enter can leave focus stranded on a now-hidden input. Shortcuts
    // already survive that (isTypingTarget ignores [hidden] subtrees); this
    // clears the stale focus itself, as a guard against WebView focus quirks.
    const ae = document.activeElement;
    if (ae instanceof HTMLElement && ae.closest("[hidden]")) ae.blur();
  }

  /** Show the reconnecting overlay during auto-reconnect backoff. `offline`
   *  means the OS reports no network: retries continue but cost nothing, so
   *  there is no budget worth counting down in front of the user. */
  showReconnecting(attempt: number, max: number, offline = false): void {
    this.lastReconnect = { attempt, max, offline };
    elJoin.setAttribute("hidden", "");
    elHud.setAttribute("hidden", "");
    elSidebar.setAttribute("hidden", "");
    elTabs.setAttribute("hidden", "");
    elReconnect.removeAttribute("hidden");
    elReconnectMsg.textContent = reconnectCopy(this.lastReconnect);
  }

  /** Update the peer count pill. `total` includes self. */
  setPeerCount(total: number): void {
    this.lastPeerCount = total;
    elCount.textContent = total === 1 ? t.justYou : t.nHere(total);
  }

  /**
   * Reflect the current mute state on the mic button.
   * aria-pressed semantics: pressed = live (unmuted).
   */
  setMuted(muted: boolean): void {
    this.lastMuted = muted;
    elMic.setAttribute("aria-pressed", muted ? "false" : "true");
    elMicLabel.textContent = muted ? t.muted : t.live;
    elMic.title = muted ? t.micTitleMuted : t.micTitleLive;
    if (!muted) this.setMuteNudge(false);
  }

  /**
   * Populate the mic/speaker selects and show the audio-settings panel. Called
   * by main.ts once it has resolved the device lists from AudioEngine.
   */
  openAudioSettings(
    inputs: { id: string; label: string }[],
    outputs: { id: string; label: string }[],
    selectedMic: string,
    selectedSpeaker: string,
  ): void {
    this._fillDeviceSelect(this.micSelect, inputs, t.fieldMicrophone, selectedMic);
    this._fillDeviceSelect(this.speakerSelect, outputs, t.fieldSpeaker, selectedSpeaker);
    elAudioSettings.removeAttribute("hidden");
  }

  /** Update the input-level meter (0..1) while the audio-settings panel is open.
   *  The percentage drives both the bar width and role="meter"'s aria-valuenow,
   *  so assistive tech reads the same level the bar shows. */
  setMicLevel(level: number): void {
    const pct = Math.round(Math.max(0, Math.min(1, level)) * 100);
    elMicLevelBar.style.width = `${pct}%`;
    if (pct !== this.lastMicLevelPct) {
      this.lastMicLevelPct = pct;
      elMicLevel.setAttribute("aria-valuenow", String(pct));
      elMicLevel.setAttribute("aria-valuetext", `${pct}%`);
    }
  }

  private _fillDeviceSelect(
    select: CustomSelect,
    devices: { id: string; label: string }[],
    kindLabel: string,
    selected: string,
  ): void {
    const options: SelectOption[] = [
      { value: "", label: t.defaultDevice },
      ...devices.map((d, i) => ({
        value: d.id,
        // Labels are blank until the browser has granted mic permission once.
        label: d.label || `${kindLabel} ${i + 1}`,
      })),
    ];
    select.setOptions(options, selected);
  }

  /** Show a non-fatal error in the join error area. */
  showError(msg: string): void {
    elJoinError.textContent = msg;
    elJoinError.removeAttribute("hidden");
  }

  // -------------------------------------------------------------------------
  // Auth (interactive OAuth login, FR-13)
  // -------------------------------------------------------------------------

  /**
   * Hold the sign-in block back while the stored session is being restored.
   * The keychain read — plus, on the first launch of the day, a token-renewal
   * round-trip to the auth server — is asynchronous, and without this every
   * launch opens on "sign in with e-mail", which reads as being signed out.
   * {@link setAuthSession} is the settle point, whichever way it goes.
   */
  setAuthRestoring(active: boolean): void {
    if (!active) {
      elAuthRestoring.setAttribute("hidden", "");
      return;
    }
    elAuthRestoring.removeAttribute("hidden");
    elAuthActions.setAttribute("hidden", "");
    elAuthSession.setAttribute("hidden", "");
  }

  /** Reflect the signed-in state: chip with name/org, or the login buttons. */
  setAuthSession(session: AuthDisplay | null): void {
    this.setAuthRestoring(false);
    this.lastAuth = session;
    if (session) {
      this._renderAuthChip();
      elAuthSession.removeAttribute("hidden");
      elAuthActions.setAttribute("hidden", "");
    } else {
      this.lastOrgs = [];
      this.lastOrgSlug = "";
      elAuthOrgSelect.setAttribute("hidden", "");
      elAuthSession.setAttribute("hidden", "");
      elAuthActions.removeAttribute("hidden");
      // Signing out mid-code-entry would otherwise leave a stale code step.
      this.showEmailStep();
    }
  }

  /**
   * The session's memberships, current org first as the backend orders them.
   * Two or more turn the chip's org text into a switcher (and put the escape
   * hatch on the billing-lock notice); fewer keep the plain text — the list
   * arrives from a separate request and may legitimately never come (offline,
   * old backend), which must simply mean "no switcher".
   */
  setOrgList(orgs: OrgSummary[], currentSlug: string): void {
    this.lastOrgs = orgs;
    this.lastOrgSlug = currentSlug;
    this._renderAuthChip();
    this._renderBillingLockOrgs();
  }

  /** Freeze both switch surfaces while a switch is in flight — the refresh
   *  token is single-use, so there is exactly one rotation at a time. */
  setOrgSwitchBusy(busy: boolean): void {
    this.orgSelect.setDisabled(busy);
    for (const btn of elBillingLockOrgsList.querySelectorAll("button")) {
      btn.disabled = busy;
    }
  }

  private _renderAuthChip(): void {
    const session = this.lastAuth;
    if (!session) return;
    if (this.lastOrgs.length >= 2) {
      elAuthUser.textContent = session.name;
      this.orgSelect.setOptions(
        this.lastOrgs.map((o) => ({
          value: o.slug,
          label: o.role === "admin" ? `${o.name} (admin)` : o.name,
        })),
        this.lastOrgSlug,
      );
      elAuthOrgSelect.removeAttribute("hidden");
    } else {
      elAuthOrgSelect.setAttribute("hidden", "");
      elAuthUser.textContent =
        session.role === "admin"
          ? `${session.name} — ${session.org} (admin)`
          : `${session.name} — ${session.org}`;
    }
  }

  /** Disable the login buttons while the browser dance is in flight. */
  setLoginBusy(busy: boolean): void {
    this.lastLoginBusy = busy;
    elLoginGoogle.disabled = busy;
    elLoginGithub.disabled = busy;
    elLoginGoogleLabel.textContent = busy ? t.waitingBrowser : t.signInGoogle;
    elLoginGithubLabel.textContent = busy ? t.waitingBrowser : t.signInGithub;
  }

  /** Disable the address step while a code is being mailed. */
  setEmailBusy(busy: boolean): void {
    this.lastEmailBusy = busy;
    elLoginEmail.disabled = busy;
    elLoginEmailSend.disabled = busy;
    elLoginCodeResend.disabled = busy;
    elLoginEmailSendLabel.textContent = busy ? t.sendingCode : t.sendCode;
  }

  /** Disable the code step while the code is being redeemed. */
  setCodeBusy(busy: boolean): void {
    this.lastCodeBusy = busy;
    elLoginCode.disabled = busy;
    elLoginCodeVerify.disabled = busy;
    elLoginCodeVerifyLabel.textContent = busy ? t.verifyingCode : t.verifyCode;
  }

  /** Swap the address step for the code step once a code is on its way. */
  showCodeStep(email: string): void {
    this.codeSentTo = email;
    elCodeSentMsg.textContent = t.codeSentTo(email);
    elEmailStep.setAttribute("hidden", "");
    elCodeStep.removeAttribute("hidden");
    elLoginCode.value = "";
    elLoginCode.focus();
  }

  /** Back to the address step (wrong address, sign-out, or a fresh start). */
  showEmailStep(): void {
    this.codeSentTo = null;
    elCodeStep.setAttribute("hidden", "");
    elEmailStep.removeAttribute("hidden");
    elLoginCode.value = "";
  }

  /** The address a code was last mailed to, for a resend. */
  getCodeEmail(): string | null {
    return this.codeSentTo;
  }

  /** Fill the display name from the login profile unless the user typed one. */
  prefillName(name: string): void {
    if (!elJoinName.value.trim() && name) {
      elJoinName.value = name;
      this._refreshAvatar();
    }
  }

  /** The invite field is single-use; clear it once consumed by a login. */
  clearInvite(): void {
    elJoinInvite.value = "";
  }

  /** Open the server-settings dialog (self-host connection details),
   *  optionally landing focus on the field the user must fix. */
  private showServerSettings(focus?: HTMLInputElement): void {
    elServerSettings.removeAttribute("hidden");
    focus?.focus();
  }

  private hideServerSettings(): void {
    elServerSettings.setAttribute("hidden", "");
  }

  private _bindServerSettings(): void {
    elJoinSettingsBtn.addEventListener("click", () => this.showServerSettings());
    elServerSettingsClose.addEventListener("click", () => this.hideServerSettings());
    bindOverlayDismiss(elServerSettings, () => this.hideServerSettings());
  }

  /** Wire EN | JA switchers on the server-settings dialog and audio-settings panel. */
  private _bindLangSwitch(): void {
    this._syncLangSwitch();
    const onClick = (e: Event) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-lang]");
      if (!btn) return;
      const next = btn.dataset.lang as Locale | undefined;
      if (next !== "en" && next !== "ja") return;
      if (!setLocale(next)) return;
      this._onLocaleChanged();
    };
    elLangSwitchServerSettings.addEventListener("click", onClick);
    elLangSwitchSettings.addEventListener("click", onClick);
  }

  /** Highlight the active language on both switchers. */
  private _syncLangSwitch(): void {
    for (const root of [elLangSwitchServerSettings, elLangSwitchSettings]) {
      for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
        const active = btn.dataset.lang === locale;
        btn.classList.toggle("active", active);
        if (active) btn.setAttribute("aria-current", "true");
        else btn.removeAttribute("aria-current");
      }
    }
  }

  /**
   * After `setLocale`: re-apply UI-owned dynamic chrome, then let main.ts
   * rebuild session-dependent strings (roster, call banner, tabs, …).
   */
  private _onLocaleChanged(): void {
    this._syncLangSwitch();
    this._syncSwatchLabels();

    // Invite role select labels.
    const role = this.inviteRoleSelect.value || "member";
    this.inviteRoleSelect.setOptions(
      [
        { value: "member", label: t.roleMember },
        { value: "admin", label: t.roleAdmin },
      ],
      role,
    );

    // Join / auth / org-setup button labels.
    if (elJoinBtn.dataset.connecting === "true") {
      elJoinBtn.textContent = t.cancel;
    } else {
      elJoinBtn.textContent = t.enter;
    }
    this.setLoginBusy(this.lastLoginBusy);
    this.setEmailBusy(this.lastEmailBusy);
    this.setCodeBusy(this.lastCodeBusy);
    if (this.codeSentTo) elCodeSentMsg.textContent = t.codeSentTo(this.codeSentTo);
    this.setOrgSetupBusy(this.lastOrgSetupBusy);
    this.setInviteIssueBusy(this.lastInviteIssueBusy);
    this.setBillingLock(this.lastBillingLock);

    // HUD chrome that UI owns directly.
    this.setMuted(this.lastMuted);
    this.setPeerCount(this.lastPeerCount);
    this.setSelfStatus(this.away, this.dnd);
    this.setScreenSharing(this.lastScreenSharing);
    this.setCameraOn(this.lastCameraOn);
    this.setScreenFullscreen(this.lastScreenFullscreen);
    this.setScreenReopenVisible(this.lastScreenReopenVisible);

    // Call banner button labels (text itself is re-translated by main).
    if (this.lastCall) {
      const mode = this.lastCall.mode;
      if (mode === "incoming") elHangup.textContent = t.pageDecline;
      else if (mode === "outgoing") elHangup.textContent = t.pageCancel;
      else elHangup.textContent = t.hangUp;
    }

    // Admin panels, if they have data already loaded.
    if (this.inviteToken) {
      elInviteCopyLink.textContent = t.copyInviteLink;
      elInviteCopyCode.textContent = t.copyInviteCode;
    }
    if (this.lastInvites && !elInvitePanel.hasAttribute("hidden")) {
      this.renderInviteList(this.lastInvites);
    }
    if (this.lastMembers && !elMembersPanel.hasAttribute("hidden")) {
      this.renderMemberList(this.lastMembers);
    }

    if (this.lastReconnect && !elReconnect.hasAttribute("hidden")) {
      elReconnectMsg.textContent = reconnectCopy(this.lastReconnect);
    }

    if (this.lastUpdateVersion && !elUpdateBanner.hasAttribute("hidden")) {
      elUpdateText.textContent = t.updateAvailable(this.lastUpdateVersion);
      if (!elUpdateInstall.disabled) {
        elUpdateInstall.textContent = t.updateInstall;
      } else {
        elUpdateInstall.textContent = t.updateDownloading;
      }
    }

    // Device selects keep their options; only the "System default" label needs a refresh.
    // main reopens/refills when the panel is open via onLocaleChange if needed.
    this.callbacks.onLocaleChange();
  }

  private _bindAuth(): void {
    // Every sign-in path needs the auth server; resolve it once, complaining
    // in the same way, and hand back null when it isn't set.
    const authUrl = (): string | null => {
      const url = elJoinAuth.value.trim();
      if (!url) {
        this.showError(t.errAuthUrl);
        this.showServerSettings(elJoinAuth);
        return null;
      }
      persistUrlDeviation(LS_AUTH, url, DEFAULT_AUTH_SERVER);
      elJoinError.setAttribute("hidden", "");
      return url;
    };

    const start = (provider: "google" | "github") => {
      const url = authUrl();
      if (!url) return;
      // The field accepts a bare code or a shared /invite/<token> link.
      this.callbacks.onLogin(provider, url, extractInviteCode(elJoinInvite.value));
    };
    elLoginGoogle.addEventListener("click", () => start("google"));
    elLoginGithub.addEventListener("click", () => start("github"));
    elAuthLogout.addEventListener("click", () => this.callbacks.onLogout());

    // ── E-mail one-time code ───────────────────────────────────────────────
    const sendCode = (email: string) => {
      const url = authUrl();
      if (!url) return;
      if (!email) {
        this.showError(t.errEmail);
        elLoginEmail.focus();
        return;
      }
      this.callbacks.onEmailStart(email, url);
    };
    elLoginEmailSend.addEventListener("click", () => sendCode(elLoginEmail.value.trim()));
    elLoginEmail.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      // The address input sits inside the join <form>; Enter here means
      // "send me a code", not "submit the form".
      e.preventDefault();
      sendCode(elLoginEmail.value.trim());
    });
    elLoginCodeResend.addEventListener("click", () => sendCode(this.codeSentTo ?? ""));
    elLoginCodeBack.addEventListener("click", () => {
      this.showEmailStep();
      elLoginEmail.focus();
    });

    const verify = () => {
      const url = authUrl();
      if (!url) return;
      const code = sanitizeCode(elLoginCode.value);
      if (code.length !== CODE_LENGTH) {
        this.showError(t.errCode);
        elLoginCode.focus();
        return;
      }
      this.callbacks.onEmailVerify(code, url, extractInviteCode(elJoinInvite.value));
    };
    elLoginCodeVerify.addEventListener("click", verify);
    // Typing/pasting only ever leaves digits in the field, and a full-length
    // code submits itself — the extra click adds nothing. The length cap lives
    // here rather than in a `maxlength`: the browser applies that *before* this
    // handler, so pasting "code: 012 345" would be truncated to its first six
    // characters and sanitize down to nothing.
    elLoginCode.addEventListener("input", () => {
      elLoginCode.value = sanitizeCode(elLoginCode.value);
      if (elLoginCode.value.length === CODE_LENGTH) verify();
    });
    elLoginCode.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      verify();
    });
  }

  /** The auth server base URL as currently configured (Advanced field). */
  getAuthUrl(): string {
    return elJoinAuth.value.trim().replace(/\/+$/, "");
  }

  // -------------------------------------------------------------------------
  // Org setup (first sign-in without an invite)
  // -------------------------------------------------------------------------

  /** Swap the join form body for the org-name step. */
  showOrgSetup(): void {
    elJoinForm.classList.add("org-setup-mode");
    elOrgSetup.removeAttribute("hidden");
    elJoinError.setAttribute("hidden", "");
    elOrgSetupName.focus();
  }

  /** Return the join form to its normal sign-in state. */
  hideOrgSetup(): void {
    elJoinForm.classList.remove("org-setup-mode");
    elOrgSetup.setAttribute("hidden", "");
    this.setOrgSetupBusy(false);
  }

  setOrgSetupBusy(busy: boolean): void {
    this.lastOrgSetupBusy = busy;
    elOrgSetupBtn.disabled = busy;
    elOrgSetupBtn.textContent = busy ? t.creatingOrg : t.createOrg;
  }

  private _bindOrgSetup(): void {
    const submit = () => {
      const name = elOrgSetupName.value.trim();
      if (!name) {
        this.showError(t.errOrgName);
        elOrgSetupName.focus();
        return;
      }
      elJoinError.setAttribute("hidden", "");
      this.callbacks.onCreateOrg(name);
    };
    elOrgSetupBtn.addEventListener("click", submit);
    elOrgSetupName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    elOrgSetupBack.addEventListener("click", () => this.callbacks.onCancelOrgSetup());
  }

  // -------------------------------------------------------------------------
  // Billing lock (org's trial ended / subscription lapsed; hosted only)
  // -------------------------------------------------------------------------

  /**
   * Swap the join form body for the billing-lock notice, or restore it (null).
   * `trial` picks the copy (trial just ended vs. payment lapsed); `admin` adds
   * the Stripe portal CTA — members are pointed at their admin instead.
   */
  setBillingLock(lock: { trial: boolean; admin: boolean } | null): void {
    this.lastBillingLock = lock;
    if (!lock) {
      elJoinForm.classList.remove("billing-lock-mode");
      elBillingLock.setAttribute("hidden", "");
      return;
    }
    elJoinForm.classList.add("billing-lock-mode");
    elBillingLockTitle.textContent = lock.trial ? t.billingLockTrialTitle : t.billingLockInactiveTitle;
    elBillingLockDesc.textContent = lock.admin
      ? (lock.trial ? t.billingLockAdminTrialDesc : t.billingLockAdminInactiveDesc)
      : t.billingLockMemberDesc;
    if (lock.admin) {
      elBillingLockCta.textContent = lock.trial ? t.billingLockSubscribe : t.billingLockUpdate;
      elBillingLockCta.removeAttribute("hidden");
    } else {
      elBillingLockCta.setAttribute("hidden", "");
    }
    this._renderBillingLockOrgs();
    elBillingLock.removeAttribute("hidden");
    elJoinError.setAttribute("hidden", "");
  }

  /** The way out of a locked org: one button per *other* membership. */
  private _renderBillingLockOrgs(): void {
    const others = this.lastOrgs.filter((o) => o.slug !== this.lastOrgSlug);
    if (!this.lastBillingLock || others.length === 0) {
      elBillingLockOrgs.setAttribute("hidden", "");
      elBillingLockOrgsList.replaceChildren();
      return;
    }
    elBillingLockOrgsList.replaceChildren(
      ...others.map((org) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ghost-btn";
        btn.textContent = org.name;
        btn.addEventListener("click", () => this.callbacks.onSwitchOrg(org.slug));
        return btn;
      }),
    );
    elBillingLockOrgs.removeAttribute("hidden");
  }

  private _bindBillingLock(): void {
    elBillingLockCta.addEventListener("click", () => this.callbacks.onOpenBilling());
  }

  // -------------------------------------------------------------------------
  // Invite management panel (admin)
  // -------------------------------------------------------------------------

  /** Show / hide the admin-only gear menu (role=admin sessions only).
   *  The billing entry is shown for any admin; it reports gracefully if the
   *  deployment has no billing configured (self-host), so the client needn't
   *  know whether billing is on. */
  setAdminVisible(isAdmin: boolean): void {
    if (isAdmin) {
      elAdminMenuBtn.removeAttribute("hidden");
      elRosterInviteBtn.removeAttribute("hidden");
    } else {
      elAdminMenuBtn.setAttribute("hidden", "");
      elRosterInviteBtn.setAttribute("hidden", "");
      this._setAdminMenuOpen(false);
    }
  }

  private _setAdminMenuOpen(open: boolean): void {
    if (open) {
      elAdminMenu.removeAttribute("hidden");
    } else {
      elAdminMenu.setAttribute("hidden", "");
    }
    elAdminMenuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  showInvitePanel(): void {
    elInvitePanel.removeAttribute("hidden");
    elInvitePanelError.setAttribute("hidden", "");
    elInviteResult.setAttribute("hidden", "");
    elInviteList.replaceChildren();
  }

  hideInvitePanel(): void {
    this.inviteRoleSelect.close();
    elInvitePanel.setAttribute("hidden", "");
  }

  setInviteIssueBusy(busy: boolean): void {
    this.lastInviteIssueBusy = busy;
    elInviteIssueBtn.disabled = busy;
    elInviteIssueBtn.textContent = busy ? t.issuingInvite : t.issueInvite;
  }

  showInvitePanelError(msg: string): void {
    elInvitePanelError.textContent = msg;
    elInvitePanelError.removeAttribute("hidden");
  }

  /** Show the freshly issued invite with copy-link / copy-code actions. */
  showInviteResult(token: string, authBase: string): void {
    this.inviteToken = token;
    this.inviteAuthBase = authBase;
    elInviteResultCode.textContent = token;
    elInviteCopyLink.textContent = t.copyInviteLink;
    elInviteCopyCode.textContent = t.copyInviteCode;
    elInviteResult.removeAttribute("hidden");
  }

  /** Rebuild the active-invite list. */
  renderInviteList(invites: InviteEntry[]): void {
    this.lastInvites = invites;
    elInviteList.replaceChildren();
    if (invites.length === 0) {
      const li = document.createElement("li");
      li.className = "invite-empty";
      li.textContent = t.noActiveInvites;
      elInviteList.appendChild(li);
      return;
    }
    for (const inv of invites) {
      const li = document.createElement("li");
      li.className = "invite-row";

      const role = document.createElement("span");
      role.className = "invite-row-role";
      role.textContent = inv.role === "admin" ? t.roleAdmin : t.roleMember;
      li.appendChild(role);

      const meta = document.createElement("span");
      meta.className = "invite-row-meta";
      const expiry = new Date(inv.expiresAt * 1000).toLocaleString(locale, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      meta.textContent = inv.creator
        ? `${t.inviteExpiresAt(expiry)} · ${t.inviteByCreator(inv.creator)}`
        : t.inviteExpiresAt(expiry);
      // The row truncates on narrow panels; the tooltip repeats what is shown
      // rather than leaking the invite token into a hover.
      meta.title = meta.textContent;
      li.appendChild(meta);

      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "invite-revoke-btn";
      revoke.textContent = t.revokeInvite;
      revoke.addEventListener("click", () => this.callbacks.onRevokeInvite(inv.token));
      li.appendChild(revoke);

      elInviteList.appendChild(li);
    }
  }

  // -------------------------------------------------------------------------
  // Member management panel (admin)
  // -------------------------------------------------------------------------

  showMembersPanel(): void {
    elMembersPanel.removeAttribute("hidden");
    elMembersPanelError.setAttribute("hidden", "");
    elMemberList.replaceChildren();
  }

  hideMembersPanel(): void {
    elMembersPanel.setAttribute("hidden", "");
  }

  showMembersPanelError(msg: string): void {
    elMembersPanelError.textContent = msg;
    elMembersPanelError.removeAttribute("hidden");
  }

  /** Rebuild the member list. Removal is two-step (arm, then confirm) so a
   *  stray click can't kick someone; re-rendering resets any armed button. */
  renderMemberList(members: MemberEntry[]): void {
    this.lastMembers = members;
    elMemberList.replaceChildren();
    for (const m of members) {
      const li = document.createElement("li");
      li.className = "invite-row member-row";

      const role = document.createElement("span");
      role.className = "invite-row-role";
      role.textContent = m.role === "admin" ? t.roleAdmin : t.roleMember;
      li.appendChild(role);

      const name = document.createElement("span");
      name.className = "invite-row-meta member-row-name";
      name.textContent = m.isSelf ? t.youName(m.name) : m.name;
      name.title = m.subject;
      li.appendChild(name);

      if (!m.isSelf) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "invite-revoke-btn";
        remove.textContent = t.removeMember;
        remove.addEventListener("click", () => {
          if (remove.dataset.armed) {
            this.callbacks.onRemoveMember(m.subject);
          } else {
            remove.dataset.armed = "1";
            remove.textContent = t.confirmRemoveMember;
          }
        });
        li.appendChild(remove);
      }

      elMemberList.appendChild(li);
    }
  }

  private _bindMembersPanel(): void {
    elMembersPanelBtn.addEventListener("click", () => {
      this._setAdminMenuOpen(false);
      this.callbacks.onOpenMembersPanel();
    });
    elMembersPanelClose.addEventListener("click", () => this.hideMembersPanel());
    bindOverlayDismiss(elMembersPanel, () => this.hideMembersPanel());
  }

  private _bindInvitePanel(): void {
    elAdminMenuBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // keep the document close-handler from undoing the toggle
      this._setAdminMenuOpen(elAdminMenu.hasAttribute("hidden"));
    });
    document.addEventListener("click", (e) => {
      if (!elAdminMenu.contains(e.target as Node)) this._setAdminMenuOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this._setAdminMenuOpen(false);
    });
    elInvitePanelBtn.addEventListener("click", () => {
      this._setAdminMenuOpen(false);
      this.callbacks.onOpenInvitePanel();
    });
    elRosterInviteBtn.addEventListener("click", () => {
      this.callbacks.onOpenInvitePanel();
    });
    elBillingBtn.addEventListener("click", () => {
      this._setAdminMenuOpen(false);
      this.callbacks.onOpenBilling();
    });
    elInvitePanelClose.addEventListener("click", () => this.hideInvitePanel());
    bindOverlayDismiss(elInvitePanel, () => this.hideInvitePanel());
    elInviteIssueBtn.addEventListener("click", () => {
      const role = this.inviteRoleSelect.value === "admin" ? "admin" : "member";
      this.callbacks.onIssueInvite(role);
    });
    const copy = (btn: HTMLButtonElement, text: string, idleLabel: string) => {
      void navigator.clipboard.writeText(text).then(() => {
        btn.textContent = t.copied;
        window.setTimeout(() => (btn.textContent = idleLabel), 1400);
      });
    };
    elInviteCopyLink.addEventListener("click", () => {
      if (!this.inviteToken) return;
      copy(
        elInviteCopyLink,
        `${this.inviteAuthBase}/invite/${this.inviteToken}`,
        t.copyInviteLink,
      );
    });
    elInviteCopyCode.addEventListener("click", () => {
      if (!this.inviteToken) return;
      copy(elInviteCopyCode, this.inviteToken, t.copyInviteCode);
    });
  }

  // -------------------------------------------------------------------------
  // Ambient prompts
  // -------------------------------------------------------------------------

  /** Show the first-run movement hint. */
  showMoveHint(): void {
    window.clearTimeout(this.onboardTimer);
    elOnboard.classList.remove("fading");
    elOnboard.removeAttribute("hidden");
  }

  /** Fade out and remove the movement hint (called on first movement). */
  hideMoveHint(): void {
    if (elOnboard.hasAttribute("hidden")) return;
    elOnboard.classList.add("fading");
    this.onboardTimer = window.setTimeout(() => {
      elOnboard.setAttribute("hidden", "");
    }, 650);
  }

  /** Toggle the "someone's nearby — unmute to talk" nudge + mic pulse. */
  setMuteNudge(visible: boolean): void {
    if (visible) {
      elNudge.removeAttribute("hidden");
      elMic.classList.add("attention");
    } else {
      elNudge.setAttribute("hidden", "");
      elMic.classList.remove("attention");
    }
  }

  // -------------------------------------------------------------------------
  // Sidebar roster (org scope, FR-02/03)
  // -------------------------------------------------------------------------

  /** Set the org name shown atop the sidebar. Long names ellipsize, so the
   *  tooltip is the only way to read one in full. */
  setOrgName(name: string): void {
    elOrgName.textContent = name;
    elOrgName.title = name;
  }

  /** Rebuild the member list. `entries` is prepared by main.ts (incl. self). */
  renderRoster(entries: RosterEntry[]): void {
    elRoster.replaceChildren();
    for (const e of entries) {
      const li = document.createElement("li");
      li.className = "roster-row";
      li.dataset.tone = e.tone;
      if (e.isSelf) li.classList.add("is-self");
      if (e.tone === "offline") li.classList.add("is-offline");

      const dot = document.createElement("span");
      dot.className = "roster-dot";
      if (e.avatar) {
        dot.classList.add("has-avatar");
        dot.style.background = `url("${e.avatar}") center / cover, ${e.color}`;
      } else {
        dot.style.background = e.color;
      }
      li.appendChild(dot);

      const text = document.createElement("span");
      text.className = "roster-text";
      const nm = document.createElement("span");
      nm.className = "roster-name";
      nm.textContent = e.isSelf ? t.youName(e.name) : e.name;
      // Both lines ellipsize in the narrow sidebar — tooltips carry the rest.
      nm.title = nm.textContent;
      const st = document.createElement("span");
      st.className = "roster-status";
      st.textContent = e.label;
      st.title = e.label;
      text.append(nm, st);
      li.appendChild(text);

      if (e.canPage) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "page-btn";
        btn.title = t.callTitle(e.name);
        btn.setAttribute("aria-label", t.callTitle(e.name));
        btn.textContent = t.callBtn;
        btn.addEventListener("click", () => this.callbacks.onPage(e.id));
        li.appendChild(btn);
      }

      elRoster.appendChild(li);
    }

    // Empty floor: a gentle hint instead of a bare one-row list.
    if (entries.length <= 1) {
      const hint = document.createElement("li");
      hint.className = "roster-empty";
      hint.textContent = t.rosterEmpty;
      elRoster.appendChild(hint);
    }
  }

  /**
   * Reflect the self away/dnd flags on the exclusive status control.
   * Exactly one of Active / Away / DND is checked (DND wins if both flags are set).
   */
  setSelfStatus(away: boolean, dnd: boolean): void {
    this.away = away;
    this.dnd = dnd;
    const mode: "active" | "away" | "dnd" = dnd ? "dnd" : away ? "away" : "active";
    elStatusActive.setAttribute("aria-checked", mode === "active" ? "true" : "false");
    elStatusAway.setAttribute("aria-checked", mode === "away" ? "true" : "false");
    elStatusDnd.setAttribute("aria-checked", mode === "dnd" ? "true" : "false");
  }

  /**
   * User picked one of the exclusive status choices. Maps to wire flags and
   * toasts when DND is entered or left (easy to miss on an always-on tool).
   */
  private _selectStatus(away: boolean, dnd: boolean): void {
    if (this.away === away && this.dnd === dnd) return;
    const wasDnd = this.dnd;
    this.setSelfStatus(away, dnd);
    this.callbacks.onSetStatus(away, dnd);
    if (dnd && !wasDnd) this.showToast(t.dndEnabled);
    else if (!dnd && wasDnd) this.showToast(t.dndDisabled);
  }

  // -------------------------------------------------------------------------
  // Space tabs (FR-05)
  // -------------------------------------------------------------------------

  /** Rebuild the space tabs from the catalog, marking the current one active. */
  renderTabs(spaces: SpaceDescriptor[], currentSpaceId: string): void {
    elTabs.replaceChildren();
    for (const sp of spaces) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab";
      b.dataset.kind = sp.kind;
      if (sp.id === currentSpaceId) {
        b.classList.add("active");
        b.setAttribute("aria-current", "true");
      }
      const label = spaceLabel(sp.id, sp.name);
      b.textContent = label;
      b.title = sp.kind === "team" ? t.teamTitle(label) : label;
      b.addEventListener("click", () => {
        if (sp.id !== currentSpaceId) this.callbacks.onEnterSpace(sp.id);
      });
      elTabs.appendChild(b);
    }

    // "+" — create a new team space via a small inline input.
    const add = document.createElement("button");
    add.type = "button";
    add.className = "tab tab-add";
    add.textContent = "+";
    add.title = t.createTeam;
    add.setAttribute("aria-label", t.createTeam);
    add.addEventListener("click", () => this._beginCreateSpace(add));
    elTabs.appendChild(add);
  }

  /** Swap the "+" button for an inline input to name a new space. */
  private _beginCreateSpace(addBtn: HTMLButtonElement): void {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tab-add-input";
    input.maxLength = 32;
    input.placeholder = t.teamName;
    const commit = () => {
      const name = input.value.trim();
      input.replaceWith(addBtn);
      if (name) this.callbacks.onCreateSpace(name);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        input.replaceWith(addBtn);
      }
    });
    input.addEventListener("blur", commit);
    addBtn.replaceWith(input);
    input.focus();
  }

  // -------------------------------------------------------------------------
  // Call banner (ringing out/in, or live page)
  // -------------------------------------------------------------------------

  /**
   * Show the call banner, or hide it (`null`).
   * - `in_call`: screen share / camera / hang up
   * - `outgoing`: cancel only
   * - `incoming`: answer + decline
   */
  setCall(state: { mode: CallBannerMode; text: string } | null): void {
    this.lastCall = state;
    if (!state) {
      elCallBanner.setAttribute("hidden", "");
      elCallBanner.removeAttribute("data-mode");
      elCallAccept.setAttribute("hidden", "");
      return;
    }
    elCallText.textContent = state.text;
    elCallBanner.dataset.mode = state.mode;
    elCallBanner.removeAttribute("hidden");

    if (state.mode === "incoming") {
      elCallAccept.removeAttribute("hidden");
      elHangup.textContent = t.pageDecline;
    } else if (state.mode === "outgoing") {
      elCallAccept.setAttribute("hidden", "");
      elHangup.textContent = t.pageCancel;
    } else {
      elCallAccept.setAttribute("hidden", "");
      elHangup.textContent = t.hangUp;
    }
  }

  /** Reflect whether the local user is currently sharing their screen. */
  setScreenSharing(sharing: boolean): void {
    this.lastScreenSharing = sharing;
    elScreenShare.textContent = sharing ? t.stopSharing : t.shareScreen;
    elScreenShare.title = sharing ? t.stopSharingTitle : t.shareScreenTitle;
    elScreenShare.setAttribute("aria-pressed", sharing ? "true" : "false");
  }

  /** Reflect whether the local user is currently sending their camera. */
  setCameraOn(on: boolean): void {
    this.lastCameraOn = on;
    elCameraToggle.textContent = on ? t.cameraOff : t.cameraOn;
    elCameraToggle.title = on ? t.cameraOffTitle : t.cameraOnTitle;
    elCameraToggle.setAttribute("aria-pressed", on ? "true" : "false");
  }

  /** Explain the missing macOS Screen Recording permission. The OS hands the
   *  capture black frames instead of an error, so this replaces the generic
   *  failure toast with the actual fix: enable Hiroba in System Settings and
   *  relaunch (macOS applies a fresh grant only after a restart). */
  showScreenPermissionHelp(onOpenSettings: () => void, onRelaunch: () => void): void {
    // Plain assignment (not addEventListener) so a re-show never stacks handlers.
    elScreenPermOpen.onclick = onOpenSettings;
    elScreenPermRelaunch.onclick = onRelaunch;
    elScreenPerm.removeAttribute("hidden");
  }

  private hideScreenPerm(): void {
    elScreenPerm.setAttribute("hidden", "");
  }

  private _bindScreenPerm(): void {
    elScreenPermClose.addEventListener("click", () => this.hideScreenPerm());
    bindOverlayDismiss(elScreenPerm, () => this.hideScreenPerm());
  }

  /** Show the given video stream in the main panel, or hide the panel when
   *  null. The element stays permanently muted: remote video streams carry no
   *  audio (voice goes through the Web Audio gain path) and the local preview
   *  must not feed back, so muting also keeps autoplay policy from ever
   *  blocking playback. */
  setScreenShareView(stream: MediaStream | null, title: string): void {
    if (!stream) {
      elScreenVideo.pause();
      elScreenVideo.srcObject = null;
      elScreenPanel.setAttribute("hidden", "");
      this.setScreenFullscreen(false);
      this.setSelfView(null);
      return;
    }
    elScreenTitle.textContent = title;
    if (elScreenVideo.srcObject !== stream) {
      elScreenVideo.srcObject = stream;
      void elScreenVideo.play().catch(() => {
        /* User gesture/autoplay policy can block; controls are intentionally not shown. */
      });
    }
    elScreenPanel.removeAttribute("hidden");
    this.setScreenReopenVisible(false);
  }

  /** Show a stream in the corner picture-in-picture (self preview, or the
   *  remote video while the local one is promoted), or hide it when null.
   *  Always muted — it must never play remote audio. */
  setSelfView(stream: MediaStream | null): void {
    if (!stream) {
      elSelfVideo.pause();
      elSelfVideo.srcObject = null;
      elSelfView.setAttribute("hidden", "");
      return;
    }
    if (elSelfVideo.srcObject !== stream) {
      elSelfVideo.srcObject = stream;
      void elSelfVideo.play().catch(() => {
        /* Autoplay policy; muted playback is normally always allowed. */
      });
    }
    elSelfView.removeAttribute("hidden");
  }

  /** Expand or restore the screen-share panel to fill the window. */
  setScreenFullscreen(fullscreen: boolean): void {
    this.lastScreenFullscreen = fullscreen;
    elScreenPanel.classList.toggle("fullscreen", fullscreen);
    elScreenFullscreen.textContent = fullscreen ? "⤡" : "⤢";
    elScreenFullscreen.title = fullscreen ? t.exitFullscreen : t.enterFullscreen;
    elScreenFullscreen.setAttribute("aria-label", fullscreen ? t.exitFullscreen : t.enterFullscreen);
  }

  /** Offer to reopen a dismissed remote screen-share panel. */
  setScreenReopenVisible(visible: boolean): void {
    this.lastScreenReopenVisible = visible;
    if (visible) {
      elScreenReopen.title = t.viewScreenTitle;
      elScreenReopen.removeAttribute("hidden");
    } else {
      elScreenReopen.setAttribute("hidden", "");
    }
  }

  // -------------------------------------------------------------------------
  // Transient toasts
  // -------------------------------------------------------------------------

  /** Pop a short-lived toast (e.g. "Sora is in do-not-disturb"). */
  showToast(message: string, kind: "info" | "error" = "info"): void {
    const el = document.createElement("div");
    el.className = "toast";
    el.dataset.kind = kind;
    el.textContent = message;
    elToasts.appendChild(el);
    window.setTimeout(() => el.classList.add("leaving"), 2600);
    window.setTimeout(() => el.remove(), 3100);
  }

  // -------------------------------------------------------------------------
  // Invite deep link (hiroba://invite/<token>; driven by deeplink.ts)
  // -------------------------------------------------------------------------

  /** Drop an arriving invite code into the join form and tell the user. The
   *  code rides along on the next OAuth sign-in (`onLogin`'s invite param). */
  applyInvite(code: string): void {
    elJoinInvite.value = code;
    this.showToast(t.inviteApplied);
  }

  // -------------------------------------------------------------------------
  // Update banner (desktop auto-update; driven by updater.ts)
  // -------------------------------------------------------------------------

  /** Offer an available update. `onInstall` downloads, installs, relaunches. */
  showUpdateBanner(version: string, onInstall: () => void): void {
    this.lastUpdateVersion = version;
    elUpdateText.textContent = t.updateAvailable(version);
    elUpdateInstall.disabled = false;
    elUpdateInstall.textContent = t.updateInstall;
    // Plain assignment (not addEventListener) so a re-offer never stacks handlers.
    elUpdateInstall.onclick = () => {
      elUpdateInstall.disabled = true;
      elUpdateInstall.textContent = t.updateDownloading;
      elUpdateLater.setAttribute("hidden", "");
      onInstall();
    };
    elUpdateLater.onclick = () => elUpdateBanner.setAttribute("hidden", "");
    elUpdateLater.removeAttribute("hidden");
    elUpdateBanner.removeAttribute("hidden");
  }

  /** Re-arm the banner after a failed download/install and say so. */
  updateBannerFailed(): void {
    elUpdateInstall.disabled = false;
    elUpdateInstall.textContent = t.updateInstall;
    elUpdateLater.removeAttribute("hidden");
    this.showToast(t.updateFailed, "error");
  }

  private _bindSidebar(): void {
    // Exclusive 3-way: Active / Away / DND (maps to away+dnd flags on the wire).
    elStatusActive.addEventListener("click", () => {
      this._selectStatus(false, false);
    });
    elStatusAway.addEventListener("click", () => {
      this._selectStatus(true, false);
    });
    elStatusDnd.addEventListener("click", () => {
      this._selectStatus(false, true);
    });
    elScreenShare.addEventListener("click", () => this.callbacks.onScreenShareToggle());
    elCameraToggle.addEventListener("click", () => this.callbacks.onCameraToggle());
    elScreenReopen.addEventListener("click", () => this.callbacks.onReopenScreenShare());
    elScreenClose.addEventListener("click", () => this.callbacks.onCloseScreenShare());
    elScreenFullscreen.addEventListener("click", () => {
      this.setScreenFullscreen(!elScreenPanel.classList.contains("fullscreen"));
    });
    elScreenVideo.addEventListener("dblclick", () => {
      this.setScreenFullscreen(!elScreenPanel.classList.contains("fullscreen"));
    });
    elSelfView.addEventListener("click", () => this.callbacks.onSelfViewClick());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && elScreenPanel.classList.contains("fullscreen")) {
        this.setScreenFullscreen(false);
      }
    });
    elCallAccept.addEventListener("click", () => this.callbacks.onPageAccept());
    elHangup.addEventListener("click", () => this.callbacks.onHangUp());
  }

  // -------------------------------------------------------------------------
  // Join form internals
  // -------------------------------------------------------------------------

  private _buildSwatches(): void {
    for (const { hex } of PALETTE) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.style.background = hex;
      b.style.setProperty("--swatch-glow", hex);
      b.dataset.color = hex;
      // Plain buttons: Tab-navigable and Enter/Space-activatable out of the box.
      // (Not role="radio", which would also require arrow-key roving focus.)
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => this._selectColor(hex, /* custom */ false));
      elSwatches.appendChild(b);
    }

    // Custom-color swatch: opens the native picker for anything off-palette.
    const custom = document.createElement("button");
    custom.type = "button";
    custom.className = "swatch swatch-custom";
    custom.setAttribute("aria-pressed", "false");
    custom.dataset.custom = "1";
    custom.addEventListener("click", () => elJoinColor.click());
    elSwatches.appendChild(custom);

    this._syncSwatchLabels();

    // The hidden native input is the source of truth for custom colors.
    elJoinColor.addEventListener("input", () => {
      this._selectColor(elJoinColor.value, /* custom */ true);
    });
  }

  private _selectColor(color: string, custom: boolean): void {
    elJoinColor.value = color;
    this.custom = custom;
    this._syncSwatchSelection();
    this._refreshAvatar();
  }

  /** (Re-)label the swatches in the active language. */
  private _syncSwatchLabels(): void {
    for (const s of elSwatches.querySelectorAll<HTMLButtonElement>(".swatch")) {
      const label = s.dataset.custom
        ? t.colorCustom
        : PALETTE.find((p) => p.hex === s.dataset.color)?.name();
      if (label) {
        s.setAttribute("aria-label", label);
        s.title = label;
      }
    }
  }

  private _syncSwatchSelection(): void {
    const current = elJoinColor.value.toLowerCase();
    const swatches = elSwatches.querySelectorAll<HTMLButtonElement>(".swatch");
    let matched = false;
    for (const s of swatches) {
      if (s.dataset.custom) continue;
      const on = !this.custom && s.dataset.color?.toLowerCase() === current;
      s.setAttribute("aria-pressed", on ? "true" : "false");
      if (on) matched = true;
    }
    const customSwatch = elSwatches.querySelector<HTMLButtonElement>(".swatch-custom");
    if (customSwatch) {
      const on = this.custom || !matched;
      customSwatch.setAttribute("aria-pressed", on ? "true" : "false");
      customSwatch.style.setProperty("--swatch-glow", elJoinColor.value);
      if (on) customSwatch.style.background = elJoinColor.value;
      else customSwatch.style.removeProperty("background");
    }
  }

  private _refreshAvatar(): void {
    const name = elJoinName.value.trim();
    const color = elJoinColor.value;
    elAvatarInitial.textContent = (name[0] ?? "?").toUpperCase();
    elAvatar.style.setProperty("--avatar-glow", hexToGlow(color));
    elAvatarInitial.style.color = pickInk(color);
    if (this.avatar) {
      elAvatar.classList.add("has-image");
      elAvatar.style.background = `url("${this.avatar}") center / cover, ${color}`;
      elAvatarRemove.removeAttribute("hidden");
    } else {
      elAvatar.classList.remove("has-image");
      elAvatar.style.background = color;
      elAvatarRemove.setAttribute("hidden", "");
    }
  }

  // -------------------------------------------------------------------------
  // Avatar upload (Slack-style profile photo)
  // -------------------------------------------------------------------------

  /**
   * Centre-crop + downscale the picked image to a small square data URL.
   * WebP where the WebView can encode it, else JPEG (Safari/WKWebView's
   * toDataURL silently ignores unsupported types and returns PNG — the
   * prefix check catches that). The result is persisted immediately so the
   * photo survives restarts like the name and color do.
   */
  private async _setAvatarFromFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("image decode failed"));
        img.src = url;
      });
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      if (side === 0) throw new Error("empty image");
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = AVATAR_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      // Flatten transparency onto white (JPEG has no alpha channel).
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
      // A phone photo down to 256² is a steep downscale; the default resampler
      // aliases badly, and this runs once per upload so quality is free here.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(
        img,
        (img.naturalWidth - side) / 2,
        (img.naturalHeight - side) / 2,
        side,
        side,
        0,
        0,
        AVATAR_SIZE,
        AVATAR_SIZE,
      );
      // Step quality down until the data URL fits the 64 KB gate — a noisy
      // photo at 256² can overshoot at the first quality.
      let data = "";
      for (const q of [0.85, 0.72, 0.6]) {
        data = canvas.toDataURL("image/webp", q);
        if (!data.startsWith("data:image/webp")) data = canvas.toDataURL("image/jpeg", q);
        if (data.length <= AVATAR_MAX_CHARS) break;
      }
      if (data.length > AVATAR_MAX_CHARS) throw new Error("avatar too large");
      this.avatar = data;
      localStorage.setItem(LS_AVATAR, data);
      elJoinError.setAttribute("hidden", "");
      this._refreshAvatar();
    } catch {
      this.showError(t.errAvatar);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private _clearAvatar(): void {
    this.avatar = "";
    localStorage.removeItem(LS_AVATAR);
    this._refreshAvatar();
  }

  private _restoreFromStorage(): void {
    // Seed the (build-time injectable) defaults first; saved values override.
    elJoinServer.value = DEFAULT_SERVER;
    elJoinAuth.value = DEFAULT_AUTH_SERVER;
    const name = localStorage.getItem(LS_NAME);
    const color = localStorage.getItem(LS_COLOR);
    const avatar = localStorage.getItem(LS_AVATAR);
    // Only trust what we wrote ourselves: a small image data URL.
    if (avatar && avatar.startsWith("data:image/") && avatar.length <= AVATAR_MAX_CHARS) {
      this.avatar = avatar;
    }
    const server = localStorage.getItem(LS_SERVER);
    const authServer = localStorage.getItem(LS_AUTH);
    // Under Tauri the session lives in the keychain; purge any token a
    // previous (pre-keychain) build left in localStorage.
    if (this.tauri) localStorage.removeItem(LS_TOKEN);
    const token = this.tauri ? null : localStorage.getItem(LS_TOKEN);
    if (token) {
      elJoinToken.value = token;
    }
    if (authServer) {
      if (!import.meta.env.DEV && isLoopbackUrl(authServer)) {
        localStorage.removeItem(LS_AUTH);
      } else {
        elJoinAuth.value = authServer;
      }
    }
    if (name) elJoinName.value = name;
    if (color) {
      elJoinColor.value = color;
      this.custom = !PALETTE.some((p) => p.hex.toLowerCase() === color.toLowerCase());
    }
    if (server) {
      if (!import.meta.env.DEV && isLoopbackUrl(server)) {
        localStorage.removeItem(LS_SERVER);
      } else {
        elJoinServer.value = server;
      }
    }
    this._syncSwatchSelection();
  }

  private _persistToStorage(name: string, color: string, serverUrl: string, token: string): void {
    localStorage.setItem(LS_NAME, name);
    localStorage.setItem(LS_COLOR, color);
    persistUrlDeviation(LS_SERVER, serverUrl, DEFAULT_SERVER);
    persistUrlDeviation(LS_AUTH, elJoinAuth.value.trim(), DEFAULT_AUTH_SERVER);
    // Plain-browser fallback only: under Tauri, tokens live in the keychain
    // and never touch localStorage (AUTH_PLAN §2).
    if (token && !this.tauri) localStorage.setItem(LS_TOKEN, token);
    else localStorage.removeItem(LS_TOKEN);
  }

  private _bindForm(): void {
    elJoinName.addEventListener("input", () => this._refreshAvatar());

    // Avatar upload: the preview circle opens the picker; × clears the photo.
    elAvatar.addEventListener("click", () => elAvatarFile.click());
    elAvatarFile.addEventListener("change", () => {
      const file = elAvatarFile.files?.[0];
      elAvatarFile.value = ""; // re-picking the same file must re-fire change
      if (file) void this._setAvatarFromFile(file);
    });
    elAvatarRemove.addEventListener("click", () => this._clearAvatar());

    elJoinForm.addEventListener("submit", (e) => {
      e.preventDefault();

      const name = elJoinName.value.trim();
      const color = elJoinColor.value;
      const serverUrl = elJoinServer.value.trim();
      const token = elJoinToken.value.trim();

      if (!name) {
        this.showError(t.errName);
        elJoinName.focus();
        return;
      }
      if (!serverUrl) {
        this.showError(t.errServer);
        this.showServerSettings(elJoinServer);
        return;
      }

      if (elJoinBtn.dataset.connecting === "true") {
        this.callbacks.onCancelConnect();
        return;
      }
      elJoinBtn.dataset.connecting = "true";
      elJoinBtn.textContent = t.cancel;
      elJoinError.setAttribute("hidden", "");

      this._persistToStorage(name, color, serverUrl, token);
      this.callbacks.onJoin({ name, color, avatar: this.avatar, serverUrl, token });
    });
  }

  private _bindHud(): void {
    elMic.addEventListener("click", () => this.callbacks.onMicToggle());
    elLeave.addEventListener("click", () => this.callbacks.onLeave());
  }

  private _bindAudioSettings(): void {
    elAudioSettingsBtn.addEventListener("click", () => this.callbacks.onOpenAudioSettings());
    const close = () => {
      this.micSelect.close();
      this.speakerSelect.close();
      elAudioSettings.setAttribute("hidden", "");
      this.callbacks.onCloseAudioSettings();
    };
    elAudioSettingsClose.addEventListener("click", close);
    bindOverlayDismiss(elAudioSettings, close);
  }

  private _bindReconnect(): void {
    elReconnectCancel.addEventListener("click", () => this.callbacks.onCancelReconnect());
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Choose dark or light ink for legibility on a given background color. */
function pickInk(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#3a2e20" : "#ffffff";
}

/** A translucent version of a hex color, used for the avatar's soft glow. */
function hexToGlow(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "rgba(181, 79, 44, 0.6)";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.5)`;
}
