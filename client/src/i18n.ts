/**
 * i18n.ts — UI strings for Hiroba, in English and Japanese.
 *
 * The locale is picked once at boot from `navigator.language` (ja → Japanese,
 * anything else → English) so the whole UI speaks ONE language — previously the
 * roster spoke Japanese while the chrome spoke English.
 *
 * Static DOM nodes opt in via `data-i18n` (textContent), `data-i18n-placeholder`,
 * `data-i18n-title`, and `data-i18n-arialabel` attributes resolved by
 * `applyStaticI18n()`; dynamic strings are read from the `t` catalog directly.
 * Parameterized messages are functions so word order can differ per language.
 */

export type Locale = "en" | "ja";

export const locale: Locale =
  typeof navigator !== "undefined" && /^ja\b/i.test(navigator.language ?? "")
    ? "ja"
    : "en";

const EN = {
  // Join card
  brandTag: "Your team's virtual office",
  tagline: "Step into the office, see who's around, and walk over for a chat.",
  signInGoogle: "Sign in with Google",
  signInGithub: "Sign in with GitHub",
  signOut: "Sign out",
  authHint: "…or continue below as a guest on a self-hosted office.",
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
  invitePlaceholder: "Paste an invite code or link to join its org on sign-in",
  enter: "Enter Hiroba",
  connecting: "Connecting…",

  // Org setup (first sign-in without an invite)
  orgSetupTitle: "Name your organization",
  orgSetupDesc: "You're almost in. Give your organization a name — teammates you invite will join it.",
  fieldOrgName: "Organization name",
  orgNamePlaceholder: "e.g. Acme Inc",
  createOrg: "Create organization",
  creatingOrg: "Creating…",
  backToLogin: "Back to sign-in",

  // Invite management (admin)
  manageInvites: "Invites",
  manageInvitesTitle: "Manage invitations",
  manageBilling: "Billing",
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
  errRejoin: "Lost connection to the server. Please rejoin.",
  errSessionExpired: "Your session expired — please sign in again.",
  errMicDenied: "Microphone access denied. Check browser/OS permissions.",
  errSignIn: "Sign-in failed. Please try again.",
  errOrgName: "Please enter an organization name.",
  errOrgCreate: "Couldn't create the organization. Please try again.",
  errAlreadyInOrg: "You already belong to an organization — please sign in again.",
  errIssueInvite: "Couldn't issue the invite. Please try again.",
  errLoadInvites: "Couldn't load invites.",
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
  onboardClick: "— or click the floor",
  nudgeText: "Someone's nearby — press M to talk",

  // HUD
  muted: "Muted",
  live: "Live",
  micTitleMuted: "Click or press M to talk (you're muted)",
  micTitleLive: "Click or press M to mute",
  justYou: "Just you",
  nHere: (n: number) => `${n} here`,
  leave: "Leave",
  leaveTitle: "Leave the office",

  // Sidebar / roster
  away: "Away",
  dnd: "Do not disturb",
  youName: (name: string) => `${name} (you)`,
  callBtn: "Call",
  callTitle: (name: string) => `Call ${name}`,
  rosterEmpty: "Just you so far — teammates appear here when they join.",
  statusInCall: "In a call",
  statusDnd: "Do not disturb",
  statusAway: "Away",
  statusOffline: "Offline",
  ariaMembers: "Members",
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
  hangUp: "Hang up",
  someone: "They",
  pageDnd: (name: string) => `${name} is in do-not-disturb.`,
  pageOffline: (name: string) => `${name} is offline.`,
};

const JA: typeof EN = {
  // Join card
  brandTag: "チームのバーチャルオフィス",
  tagline: "ふらっと出社して、近くの人とすぐ話せる。",
  signInGoogle: "Google でサインイン",
  signInGithub: "GitHub でサインイン",
  signOut: "サインアウト",
  authHint: "…またはセルフホストのオフィスにゲストとして参加できます。",
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
  invitePlaceholder: "招待コードまたはリンクを貼ると、サインイン時にその組織に参加します",
  enter: "オフィスに入る",
  connecting: "接続中…",

  // Org setup (first sign-in without an invite)
  orgSetupTitle: "組織に名前をつけましょう",
  orgSetupDesc: "もう少しです。組織の名前を入力してください。招待した仲間はこの組織に参加します。",
  fieldOrgName: "組織名",
  orgNamePlaceholder: "例:Acme Inc",
  createOrg: "組織を作成",
  creatingOrg: "作成中…",
  backToLogin: "サインインに戻る",

  // Invite management (admin)
  manageInvites: "招待",
  manageInvitesTitle: "招待の管理",
  manageBilling: "お支払い",
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
  errRejoin: "サーバーとの接続が切れました。もう一度入室してください。",
  errSessionExpired: "セッションの有効期限が切れました。もう一度サインインしてください。",
  errMicDenied: "マイクを使用できません。ブラウザ/OSの権限設定を確認してください。",
  errSignIn: "サインインに失敗しました。もう一度お試しください。",
  errOrgName: "組織名を入力してください。",
  errOrgCreate: "組織を作成できませんでした。もう一度お試しください。",
  errAlreadyInOrg: "すでに組織に所属しています。もう一度サインインしてください。",
  errIssueInvite: "招待を発行できませんでした。もう一度お試しください。",
  errLoadInvites: "招待の一覧を取得できませんでした。",
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
  onboardClick: "(クリックでも移動できます)",
  nudgeText: "近くに誰かいます — M キーで話せます",

  // HUD
  muted: "ミュート中",
  live: "オン",
  micTitleMuted: "クリックか M キーで話す(現在ミュート)",
  micTitleLive: "クリックか M キーでミュート",
  justYou: "自分だけ",
  nHere: (n: number) => `${n}人がここに`,
  leave: "退室",
  leaveTitle: "オフィスから退室",

  // Sidebar / roster
  away: "離席",
  dnd: "取り込み中",
  youName: (name: string) => `${name}(自分)`,
  callBtn: "呼ぶ",
  callTitle: (name: string) => `${name} に呼びかけ`,
  rosterEmpty: "まだ自分だけです。仲間が参加するとここに表示されます。",
  statusInCall: "通話中",
  statusDnd: "取り込み中",
  statusAway: "離席",
  statusOffline: "オフライン",
  ariaMembers: "メンバー",
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
  hangUp: "切断",
  someone: "相手",
  pageDnd: (name: string) => `${name} は取り込み中です。`,
  pageOffline: (name: string) => `${name} はオフラインです。`,
};

/** The active message catalog. */
export const t: typeof EN = locale === "ja" ? JA : EN;

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
 * Resolve `data-i18n*` attributes on static DOM nodes. Call once at boot,
 * before the first paint the user can read. Keys must name string entries in
 * the catalog; parameterized (function) entries are dynamic-only.
 */
export function applyStaticI18n(): void {
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
