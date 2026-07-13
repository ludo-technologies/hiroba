/**
 * i18n.ts — UI strings for Hiroba, in English and Japanese.
 *
 * Locale resolution (first match wins):
 *   1. `localStorage` key `hiroba_locale` (user choice from the in-app switcher)
 *   2. `navigator.language` (ja → Japanese, anything else → English)
 *
 * The whole UI speaks ONE language. `setLocale()` updates the live catalog,
 * rewrites static `data-i18n*` nodes, and persists the choice so the next boot
 * matches. Dynamic strings re-read `t` / `locale` (ESM live bindings).
 *
 * Static DOM nodes opt in via `data-i18n` (textContent), `data-i18n-placeholder`,
 * `data-i18n-title`, and `data-i18n-arialabel` attributes resolved by
 * `applyStaticI18n()`; dynamic strings are read from the `t` catalog directly.
 * Parameterized messages are functions so word order can differ per language.
 */

export type Locale = "en" | "ja";

const LS_LOCALE = "hiroba_locale";

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(LS_LOCALE);
    if (saved === "en" || saved === "ja") return saved;
  } catch {
    /* private mode / unavailable storage — fall through */
  }
  return typeof navigator !== "undefined" && /^ja\b/i.test(navigator.language ?? "")
    ? "ja"
    : "en";
}

/** Active UI locale. Reassigned by {@link setLocale}; importers see the live binding. */
export let locale: Locale = detectLocale();

const EN = {
  // Join card
  brandTag: "Your team's virtual office",
  signInGoogle: "Sign in with Google",
  signInGithub: "Sign in with GitHub",
  signOut: "Sign out",
  waitingBrowser: "Waiting for browser…",
  fieldName: "Display name",
  namePlaceholder: "Your name",
  fieldColor: "Your color",
  serverSettings: "Server settings",
  fieldServer: "Server",
  fieldToken: "Access token (optional)",
  tokenPlaceholder: "Leave blank for a guest session",
  fieldAuthServer: "Auth server",
  fieldInvite: "Invite code (optional)",
  invitePlaceholder: "Paste an invite code or link",
  enter: "Enter Hiroba",

  // Org setup (first sign-in without an invite)
  orgSetupTitle: "Name your organization",
  orgSetupDesc: "You're almost in. Give your organization a name — teammates you invite will join it.",
  fieldOrgName: "Organization name",
  orgNamePlaceholder: "e.g. Acme Inc",
  createOrg: "Create organization",
  creatingOrg: "Creating…",
  backToLogin: "Back to sign-in",

  // Admin menu (gear in the sidebar header)
  adminMenuTitle: "Admin settings",
  manageInvitesTitle: "Manage invitations",
  manageBillingTitle: "Manage billing",
  invitePanel: "Invites",
  closePanel: "Close",
  inviteRole: "Role",
  roleMember: "Member",
  roleAdmin: "Admin",
  issueInvite: "Issue invite",
  issuingInvite: "Issuing…",
  copyInviteLink: "Copy link",
  copyInviteCode: "Copy code",
  copied: "Copied!",
  activeInvites: "Active invites",
  noActiveInvites: "No active invites.",
  revokeInvite: "Revoke",
  inviteExpiresAt: (date: string) => `expires ${date}`,
  inviteByCreator: (name: string) => `by ${name}`,

  // Errors
  errName: "Please enter a display name.",
  errServer: "Please enter a server URL.",
  errAuthUrl: "Please set the auth server URL (under Server settings).",
  errConnect: "Could not connect to the server. Check the URL and try again.",
  errAuthFailed: "The server rejected the sign-in. Please sign in and try again.",
  errOrgSuspended: "This organization is suspended. Ask an administrator to update billing.",
  errSpaceFull: "This space is full. Try another space or ask an administrator.",
  errSpaceLimit: "This organization has reached its space limit.",
  errUnknownSpace: "That space no longer exists. Rejoin and choose another space.",
  errForbidden: "You don't have permission to perform this action.",
  errRejoin: "Lost connection to the server. Please rejoin.",
  errSessionExpired: "Your session expired — please sign in again.",
  errMicDenied: "Microphone access denied. Check browser/OS permissions.",
  errSignIn: "Sign-in failed. Please try again.",
  errOrgName: "Please enter an organization name.",
  errOrgCreate: "Couldn't create the organization. Please try again.",
  errAlreadyInOrg: "You already belong to an organization — please sign in again.",
  errIssueInvite: "Couldn't issue the invite. Please try again.",
  errLoadInvites: "Couldn't load invites.",

  // Member management (admin)
  manageMembersTitle: "Manage members",
  removeMember: "Remove",
  confirmRemoveMember: "Confirm?",
  errLoadMembers: "Couldn't load members.",
  errRemoveMember: "Couldn't remove that member. Please try again.",
  openingBilling: "Opening billing…",
  billingNotEnabled: "Billing isn't enabled for this deployment.",
  errBillingPortal: "Couldn't open the billing portal. Please try again.",

  // Reconnect overlay
  reconnecting: "Reconnecting…",
  reconnectAttempt: (n: number, max: number) => `Reconnecting… (attempt ${n}/${max})`,
  cancel: "Cancel",

  // Onboarding / nudge
  onboardOr: "or",
  onboardWalk: "to walk around",
  onboardClick: "— or click the floor / a seat",
  onboardCallTip: "Call from the sidebar · DND blocks unexpected calls",
  nudgeText: "Someone's nearby — press M to talk",

  // Auto-update banner
  updateAvailable: (v: string) => `Hiroba ${v} is available`,
  updateInstall: "Restart to update",
  updateDownloading: "Updating…",
  updateLater: "Later",
  updateFailed: "Update failed — please try again later.",

  // Invite deep link (hiroba://invite/<token>)
  inviteApplied: "Invite code applied — sign in to join the org.",

  // HUD
  muted: "Muted",
  live: "Live",
  micTitleMuted: "Click or press M to talk (you're muted)",
  micTitleLive: "Click or press M to mute",
  justYou: "Just you",
  nHere: (n: number) => `${n} here`,
  leave: "Leave",
  leaveTitle: "Leave the office",

  // Audio settings panel (gear next to the mic button)
  audioSettingsTitle: "Audio settings",
  fieldMicrophone: "Microphone",
  fieldSpeaker: "Speaker",
  fieldLanguage: "Language",
  langAriaLabel: "Language",
  micLevelAria: "Microphone input level",
  defaultDevice: "System default",

  // Sidebar / roster — status is a mutually exclusive 3-way choice
  // (Active / Away / DND). Server effective priority remains in_call > dnd > away.
  active: "Active",
  activeTitle:
    "Available. Switches to Away after 5 minutes of inactivity.",
  away: "Away",
  awayTitle:
    "Away — soft idle signal. Also set automatically after 5 minutes idle; any activity returns you to Active.",
  dnd: "DND",
  dndTitle: "Do not disturb — blocks all incoming calls (takes priority over Away)",
  dndEnabled: "Do not disturb on — incoming calls are blocked",
  dndDisabled: "Do not disturb off — you can receive calls again",
  idleAwayToast: (min: number) =>
    `Away after ${min} min idle — move or click to return to Active`,
  youName: (name: string) => `${name} (you)`,
  callBtn: "Call",
  callTitle: (name: string) => `Call ${name}`,
  rosterEmpty: "Just you so far — teammates appear here when they join.",
  statusInCall: "In a call",
  statusDnd: "Do not disturb",
  statusAway: "Away",
  statusOffline: "Offline",
  ariaMembers: "Members",
  ariaStatus: "Your status",
  ariaColor: "Avatar color",
  avatarUpload: "Upload a profile photo",
  avatarRemove: "Remove photo",
  errAvatar: "Couldn't use that image. Try another file.",

  // Space tabs
  ariaSpaces: "Spaces",
  createTeam: "Create a team space",
  teamName: "Team name",
  teamTitle: (name: string) => `${name} (team)`,
  // Built-in space display names (keyed by the server's stable space id).
  spaceLobby: "Lobby",
  spaceDev: "Dev",

  // Paging / call banner
  inCallWith: (name: string) => `In call with ${name}`,
  inCallN: (n: number) => `In call with ${n} people`,
  shareScreen: "Share screen",
  shareScreenTitle: "Share your screen in this call",
  stopSharing: "Stop sharing",
  stopSharingTitle: "Stop screen sharing",
  closeScreen: "Close screen share",
  enterFullscreen: "Enter fullscreen",
  exitFullscreen: "Exit fullscreen",
  yourScreen: "Your screen",
  sharedScreen: (name: string) => `${name}'s screen`,
  errScreenShare: "Couldn't start screen sharing. Check browser/OS permissions.",
  viewScreen: "View screen",
  viewScreenTitle: "Show the shared screen again",
  cameraOn: "Turn on camera",
  cameraOnTitle: "Turn on your camera in this call",
  cameraOff: "Turn off camera",
  cameraOffTitle: "Turn off your camera",
  yourCamera: "Your camera",
  peerCamera: (name: string) => `${name}'s camera`,
  peerVideo: (name: string) => `${name}'s video`,
  errCameraDenied: "Camera access denied. Check browser/OS permissions.",
  hangUp: "Hang up",
  pageCancel: "Cancel",
  pageDecline: "Decline",
  pageAccept: "Answer",
  someone: "They",
  pageCalling: (name: string) => `Calling ${name}…`,
  pageIncoming: (name: string) => `Incoming call from ${name}`,
  pageDnd: (name: string) => `${name} is in do-not-disturb.`,
  pageBusy: (name: string) => `${name} is already in a call.`,
  pageOffline: (name: string) => `${name} is offline.`,
  pageDeclined: (name: string) => `${name} declined the call.`,
  pageTimeout: (name: string) => `${name} didn't answer.`,
  pageMissed: (name: string) => `You missed a call from ${name}.`,
};

const JA: typeof EN = {
  // Join card
  brandTag: "チームのバーチャルオフィス",
  signInGoogle: "Google でサインイン",
  signInGithub: "GitHub でサインイン",
  signOut: "サインアウト",
  waitingBrowser: "ブラウザで認証中…",
  fieldName: "表示名",
  namePlaceholder: "名前",
  fieldColor: "カラー",
  serverSettings: "サーバー設定",
  fieldServer: "サーバー",
  fieldToken: "アクセストークン(任意)",
  tokenPlaceholder: "空欄でゲスト参加",
  fieldAuthServer: "認証サーバー",
  fieldInvite: "招待コード(任意)",
  invitePlaceholder: "招待コードまたはリンクを貼り付け",
  enter: "オフィスに入る",

  // Org setup (first sign-in without an invite)
  orgSetupTitle: "組織に名前をつけましょう",
  orgSetupDesc: "もう少しです。組織の名前を入力してください。招待した仲間はこの組織に参加します。",
  fieldOrgName: "組織名",
  orgNamePlaceholder: "例:Acme Inc",
  createOrg: "組織を作成",
  creatingOrg: "作成中…",
  backToLogin: "サインインに戻る",

  // Admin menu (gear in the sidebar header)
  adminMenuTitle: "管理メニュー",
  manageInvitesTitle: "招待の管理",
  manageBillingTitle: "お支払いの管理",
  invitePanel: "招待",
  closePanel: "閉じる",
  inviteRole: "ロール",
  roleMember: "メンバー",
  roleAdmin: "管理者",
  issueInvite: "招待を発行",
  issuingInvite: "発行中…",
  copyInviteLink: "リンクをコピー",
  copyInviteCode: "コードをコピー",
  copied: "コピーしました",
  activeInvites: "有効な招待",
  noActiveInvites: "有効な招待はありません。",
  revokeInvite: "取消",
  inviteExpiresAt: (date: string) => `${date} まで有効`,
  inviteByCreator: (name: string) => `${name} が発行`,

  // Errors
  errName: "表示名を入力してください。",
  errServer: "サーバーURLを入力してください。",
  errAuthUrl: "認証サーバーのURLを設定してください(サーバー設定内)。",
  errConnect: "サーバーに接続できませんでした。URLを確認してもう一度お試しください。",
  errAuthFailed: "サーバーに認証を拒否されました。サインインしてからもう一度お試しください。",
  errOrgSuspended: "この組織は利用停止中です。管理者にお支払い状況の確認を依頼してください。",
  errSpaceFull: "このスペースは満員です。別のスペースを選ぶか、管理者にご相談ください。",
  errSpaceLimit: "この組織はスペース数の上限に達しています。",
  errUnknownSpace: "指定されたスペースは存在しません。再入室して別のスペースを選んでください。",
  errForbidden: "この操作を行う権限がありません。",
  errRejoin: "サーバーとの接続が切れました。もう一度入室してください。",
  errSessionExpired: "セッションの有効期限が切れました。もう一度サインインしてください。",
  errMicDenied: "マイクを使用できません。ブラウザ/OSの権限設定を確認してください。",
  errSignIn: "サインインに失敗しました。もう一度お試しください。",
  errOrgName: "組織名を入力してください。",
  errOrgCreate: "組織を作成できませんでした。もう一度お試しください。",
  errAlreadyInOrg: "すでに組織に所属しています。もう一度サインインしてください。",
  errIssueInvite: "招待を発行できませんでした。もう一度お試しください。",
  errLoadInvites: "招待の一覧を取得できませんでした。",

  // Member management (admin)
  manageMembersTitle: "メンバーの管理",
  removeMember: "削除",
  confirmRemoveMember: "本当に削除？",
  errLoadMembers: "メンバーの一覧を取得できませんでした。",
  errRemoveMember: "メンバーを削除できませんでした。もう一度お試しください。",
  openingBilling: "お支払い管理を開いています…",
  billingNotEnabled: "この環境では課金は有効化されていません。",
  errBillingPortal: "お支払い管理を開けませんでした。もう一度お試しください。",

  // Reconnect overlay
  reconnecting: "再接続中…",
  reconnectAttempt: (n: number, max: number) => `再接続中…(${n}/${max} 回目)`,
  cancel: "キャンセル",

  // Onboarding / nudge
  onboardOr: "または",
  onboardWalk: "で移動",
  onboardClick: "(クリックで移動・席に座れます)",
  onboardCallTip: "サイドバーの「呼ぶ」で通話 · 取り込み中は着信を遮断",
  nudgeText: "近くに誰かいます — M キーで話せます",

  // Auto-update banner
  updateAvailable: (v: string) => `Hiroba ${v} が利用できます`,
  updateInstall: "更新して再起動",
  updateDownloading: "更新中…",
  updateLater: "後で",
  updateFailed: "更新に失敗しました。しばらくしてからもう一度お試しください。",

  // Invite deep link (hiroba://invite/<token>)
  inviteApplied: "招待コードを受け取りました。サインインすると参加できます。",

  // HUD
  muted: "ミュート中",
  live: "オン",
  micTitleMuted: "クリックか M キーで話す(現在ミュート)",
  micTitleLive: "クリックか M キーでミュート",
  justYou: "自分だけ",
  nHere: (n: number) => `${n}人がここに`,
  leave: "退室",
  leaveTitle: "オフィスから退室",

  // Audio settings panel (gear next to the mic button)
  audioSettingsTitle: "オーディオ設定",
  fieldMicrophone: "マイク",
  fieldSpeaker: "スピーカー",
  fieldLanguage: "言語",
  langAriaLabel: "言語",
  micLevelAria: "マイクの入力レベル",
  defaultDevice: "システムのデフォルト",

  // Sidebar / roster — ステータスは Active / Away / DND の排他 3 択
  // （サーバー実効優先度は in_call > dnd > away のまま）
  active: "在席",
  activeTitle: "在席中。5分間操作がないと自動で離席になります。",
  away: "離席",
  awayTitle:
    "離席 — ソフトな離席表示。5分操作なしでも自動で離席になります。操作すると在席に戻ります。",
  dnd: "取込中",
  dndTitle: "取り込み中 — 着信通話をすべて遮断（離席より優先）",
  dndEnabled: "取り込み中オン — 着信は届きません",
  dndDisabled: "取り込み中オフ — 着信を受けられます",
  idleAwayToast: (min: number) =>
    `${min}分間操作がなかったため離席になりました — 操作すると在席に戻ります`,
  youName: (name: string) => `${name}(自分)`,
  callBtn: "呼ぶ",
  callTitle: (name: string) => `${name} に呼びかけ`,
  rosterEmpty: "まだ自分だけです。仲間が参加するとここに表示されます。",
  statusInCall: "通話中",
  statusDnd: "取り込み中",
  statusAway: "離席",
  statusOffline: "オフライン",
  ariaMembers: "メンバー",
  ariaStatus: "自分のステータス",
  ariaColor: "アバターの色",
  avatarUpload: "プロフィール写真をアップロード",
  avatarRemove: "写真を削除",
  errAvatar: "この画像は使用できませんでした。別のファイルをお試しください。",

  // Space tabs
  ariaSpaces: "スペース",
  createTeam: "チームスペースを作成",
  teamName: "チーム名",
  teamTitle: (name: string) => `${name}(チーム)`,
  // Built-in space display names (keyed by the server's stable space id).
  spaceLobby: "ロビー",
  spaceDev: "開発",

  // Paging / call banner
  inCallWith: (name: string) => `${name} と通話中`,
  inCallN: (n: number) => `${n}人と通話中`,
  shareScreen: "画面共有",
  shareScreenTitle: "この通話で画面を共有",
  stopSharing: "共有停止",
  stopSharingTitle: "画面共有を停止",
  closeScreen: "画面共有を閉じる",
  enterFullscreen: "全画面表示にする",
  exitFullscreen: "全画面表示を終了",
  yourScreen: "自分の画面",
  sharedScreen: (name: string) => `${name} の画面`,
  errScreenShare: "画面共有を開始できませんでした。ブラウザ/OSの権限設定を確認してください。",
  viewScreen: "画面を見る",
  viewScreenTitle: "共有画面を再表示",
  cameraOn: "カメラ",
  cameraOnTitle: "この通話でカメラをオンにする",
  cameraOff: "カメラ停止",
  cameraOffTitle: "カメラをオフにする",
  yourCamera: "自分のカメラ",
  peerCamera: (name: string) => `${name} のカメラ`,
  peerVideo: (name: string) => `${name} のビデオ`,
  errCameraDenied: "カメラを使用できません。ブラウザ/OSの権限設定を確認してください。",
  hangUp: "切断",
  pageCancel: "キャンセル",
  pageDecline: "拒否",
  pageAccept: "応答",
  someone: "相手",
  pageCalling: (name: string) => `${name} に呼びかけ中…`,
  pageIncoming: (name: string) => `${name} から着信`,
  pageDnd: (name: string) => `${name} は取り込み中です。`,
  pageBusy: (name: string) => `${name} は通話中です。`,
  pageOffline: (name: string) => `${name} はオフラインです。`,
  pageDeclined: (name: string) => `${name} が通話を拒否しました。`,
  pageTimeout: (name: string) => `${name} が応答しませんでした。`,
  pageMissed: (name: string) => `${name} からの着信に応答できませんでした。`,
};

/** The active message catalog. Reassigned by {@link setLocale}. */
export let t: typeof EN = locale === "ja" ? JA : EN;

/**
 * Switch the UI language, persist the choice, and rewrite static `data-i18n*`
 * nodes. Returns `true` when the locale actually changed. Callers that hold
 * dynamic strings (roster labels, call banner, …) should re-render afterward.
 */
export function setLocale(next: Locale): boolean {
  if (next !== "en" && next !== "ja") return false;
  if (next === locale) return false;
  locale = next;
  t = next === "ja" ? JA : EN;
  try {
    localStorage.setItem(LS_LOCALE, next);
  } catch {
    /* still switch in-memory even if persistence fails */
  }
  applyStaticI18n();
  return true;
}

/**
 * Localized display name for a space. Built-in spaces (the server's stable
 * `lobby` / `dev` ids) are localized; user-created spaces keep their own name.
 */
export function spaceLabel(id: string, name: string): string {
  if (id === "lobby") return t.spaceLobby;
  if (id === "dev") return t.spaceDev;
  return name;
}

/**
 * Resolve `data-i18n*` attributes on static DOM nodes. Call at boot and after
 * every {@link setLocale}. Keys must name string entries in the catalog;
 * parameterized (function) entries are dynamic-only.
 */
export function applyStaticI18n(): void {
  // No-op outside a browser (unit tests import the catalog without a DOM).
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  const dict = t as Record<string, unknown>;
  const text = (key: string | undefined): string | null => {
    if (!key) return null;
    const v = dict[key];
    return typeof v === "string" ? v : null;
  };
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const v = text(el.dataset.i18n);
    if (v !== null) el.textContent = v;
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    const v = text(el.dataset.i18nPlaceholder);
    if (v !== null) el.setAttribute("placeholder", v);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const v = text(el.dataset.i18nTitle);
    if (v !== null) el.title = v;
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-arialabel]")) {
    const v = text(el.dataset.i18nArialabel);
    if (v !== null) el.setAttribute("aria-label", v);
  }
}
