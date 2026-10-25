/**
 * i18n.ts — UI strings for Hiroba, in English, Japanese, Spanish and French.
 *
 * Locale resolution (first match wins):
 *   1. `localStorage` key `hiroba_locale` (user choice from the in-app switcher)
 *   2. `navigator.language`'s primary subtag (ja / es / fr → that language,
 *      anything else → English)
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

const LOCALES = ["en", "ja", "es", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(v: unknown): v is Locale {
  return (LOCALES as readonly unknown[]).includes(v);
}

const LS_LOCALE = "hiroba_locale";

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(LS_LOCALE);
    if (isLocale(saved)) return saved;
  } catch {
    /* private mode / unavailable storage — fall through */
  }
  const lang = typeof navigator !== "undefined" ? navigator.language ?? "" : "";
  const primary = lang.split("-")[0].toLowerCase();
  return isLocale(primary) ? primary : "en";
}

/** Active UI locale. Reassigned by {@link setLocale}; importers see the live binding. */
export let locale: Locale = detectLocale();

const EN = {
  // Join card
  signInGoogle: "Sign in with Google",
  signInGithub: "Sign in with GitHub",
  signOutAccount: "Sign out of Hiroba",
  newOrgAction: "+ New organization",
  orgSetupAnotherDesc: "Name the new organization. You stay a member of your current ones and can switch any time.",
  waitingBrowser: "Waiting for browser…",
  restoringSession: "Restoring your session…",

  // E-mail one-time code sign-in
  authOr: "or",
  fieldEmail: "Email address",
  emailPlaceholder: "you@example.com",
  sendCode: "Email me a code",
  sendingCode: "Sending…",
  fieldCode: "Login code",
  codeSentTo: (email: string) => `Enter the 6-digit code sent to ${email}.`,
  verifyCode: "Sign in",
  verifyingCode: "Signing in…",
  resendCode: "Send another code",
  changeEmail: "Use a different address",
  fieldName: "Display name",
  namePlaceholder: "Your name",
  fieldAvatar: "Avatar",
  fieldColor: "Your color",
  // Swatch names — the palette's hex codes are meaningless when read aloud.
  colorClay: "Clay",
  colorAmber: "Amber",
  colorCoral: "Coral",
  colorSage: "Sage",
  colorSky: "Sky",
  colorLilac: "Lilac",
  colorTeal: "Teal",
  colorSlate: "Slate",
  colorCustom: "Custom color",
  serverSettings: "Server settings",
  fieldServer: "Server",
  fieldToken: "Access token (optional)",
  tokenPlaceholder: "Leave blank for a guest session",
  fieldAuthServer: "Auth server",
  fieldInvite: "Invite link (optional)",
  invitePlaceholder: "Paste an invite link",
  enter: "Enter Hiroba",

  // Org setup (first sign-in without an invite)
  orgSetupTitle: "Name your organization",
  orgSetupDesc: "You're almost in. Give your organization a name — teammates you invite will join it.",
  fieldOrgName: "Organization name",
  orgNamePlaceholder: "e.g. Acme Inc",
  createOrg: "Create organization",
  creatingOrg: "Creating…",
  backToLogin: "Back to sign-in",
  orgSetupInvitedHint: "Were you invited to an existing organization?",
  joinWithInvite: "Join with invite",
  joiningWithInvite: "Joining…",
  errInviteCodeMissing: "Paste the invite link you received.",

  // Invite step (right after the org is founded) + invite-by-e-mail
  inviteSetupTitle: "Invite your teammates",
  inviteSetupDesc: (org: string) =>
    `An office comes alive with people in it. Add a few addresses and we'll send them a link to join ${org}.`,
  inviteSetupDescNoEmail: (org: string) =>
    `An office comes alive with people in it. Copy an invite link and share it with the people you'll be in ${org} with.`,
  fieldInviteEmails: "Email addresses",
  inviteEmailsPlaceholder: "aoi@example.com, ren@example.com",
  sendInvites: "Send email invites",
  sendingInvites: "Sending…",
  invitesSentTo: (list: string) => `Invites sent to ${list}.`,
  invitesFailedFor: (list: string) => `Couldn't send to ${list}.`,
  copyInviteLinkInstead: "Copy an invite link to share yourself",
  inviteLinkCopied: "Invite link copied — share it with your teammate.",
  inviteSetupEnter: "Enter the office",
  errInviteEmails: "Enter at least one email address.",
  errSendInvites: "Couldn't send the invites. Please try again.",
  errInvitesTooMany: "Too many invites sent recently. Please wait a while and try again.",
  errEmailInvitesUnavailable: "This server can't send email — share an invite link instead.",

  // Trial countdown (hosted; the org's subscription is trialing)
  trialDaysLeft: (n: number) => (n === 1 ? "Free trial: 1 day left" : `Free trial: ${n} days left`),
  trialEndsToday: "Free trial ends today",
  trialPillTitle: "Add a payment method to keep Hiroba after the trial",

  // Admin menu (gear in the sidebar header)
  adminMenuTitle: "Admin settings",
  inviteMembers: "Invite members",
  manageBillingTitle: "Manage billing",
  invitePanel: "Invites",
  closePanel: "Close",
  inviteRole: "Role for the person you invite",
  roleMember: "Member",
  roleAdmin: "Admin",
  inviteHow: "How do you want to reach them?",
  inviteMethodMail: "Send by email",
  inviteMethodMailDesc: "Hiroba emails them a link to join",
  inviteMethodLink: "Share a link",
  inviteMethodLinkDesc: "You paste it into Slack or a chat yourself",
  inviteMailHint: "Enter email addresses and Hiroba sends each one a link to join. Separate several with commas.",
  shareInviteLink: "Share an invite link",
  inviteLinkHint: "Creates one link to join and copies it. Paste it to your teammate in Slack or a chat. One link admits one person.",
  createInviteLink: "Copy a new invite link",
  creatingInviteLink: "Creating…",
  inviteLinkReady: "Link copied. Paste it to your teammate.",
  inviteLinkReadyNoClipboard: "Link created. Copy it and send it to your teammate.",
  inviteLinkHowTo: "They join by opening the link, or by pasting it into the app's invite link field.",
  createAnotherInviteLink: "Make a link for one more person",
  inviteNoEmailNotice: "This server has no email set up, so invites go out as links only.",
  copy: "Copy",
  copied: "Copied!",
  activeInvites: "Pending invites",
  noActiveInvites: "No pending invites.",
  inviteLinkLabel: "Invite link",
  revokeInvite: "Revoke",
  inviteExpiresAt: (date: string) => `expires ${date}`,
  inviteSentBy: (name: string) => `sent by ${name}`,
  inviteCreatedBy: (name: string) => `created by ${name}`,

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
  errAuthOffline:
    "Couldn't reach the auth server to renew your session. You stay signed in — check your connection and try again.",
  errKeychain:
    "Couldn't read your saved sign-in from the keychain. Unlock the login keychain (or allow Hiroba access) and restart, or sign in again.",
  errSessionNotSaved:
    "Signed in, but this device couldn't save the session to the keychain — the next launch will ask again.",
  errMicDenied: "Microphone access denied. Check browser/OS permissions.",
  errSignIn: "Sign-in failed. Please try again.",
  errEmail: "Please enter a valid email address.",
  errSendCode: "Couldn't send the code. Check the address and try again.",
  errCodeThrottled: (secs: number) => `Please wait ${secs}s before requesting another code.`,
  errCode: "That code is wrong or has expired. Request a new one.",
  errInvite: "That invite is invalid, already used, or expired. Ask for a new one.",
  errOrgName: "Please enter an organization name.",
  errOrgCreate: "Couldn't create the organization. Please try again.",
  errAlreadyInOrg: "You already belong to an organization — please sign in again.",
  errIssueInvite: "Couldn't create the invite link. Please try again.",
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

  // Billing lock (join screen; the org's subscription is paused or lapsed)
  billingLockTrialTitle: "Your free trial has ended",
  billingLockInactiveTitle: "Your subscription is inactive",
  billingLockAdminTrialDesc:
    "To keep using Hiroba, start your subscription. You'll enter payment details on Stripe's secure page, and Hiroba resumes automatically within a few minutes.",
  billingLockAdminInactiveDesc:
    "We couldn't collect the last payment. Update your payment details on Stripe's secure page and Hiroba resumes automatically within a few minutes.",
  billingLockMemberDesc: "Ask your organization's administrator to update the subscription.",
  billingLockSubscribe: "Start subscription",
  billingLockUpdate: "Update payment details",
  billingLockSwitchTitle: "Or continue in another organization you belong to:",

  // Org switcher (signed-in chip; shown when the user belongs to 2+ orgs)
  orgSwitchAria: "Switch organization",
  errOrgSwitch: "Couldn't switch organizations. Please try again.",

  // Join card (connecting) / reconnect overlay
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  reconnectAttempt: (n: number, max: number) => `Reconnecting… (attempt ${n}/${max})`,
  reconnectOffline: "Waiting for the network…",
  cancel: "Cancel",

  // Onboarding / nudge
  onboardOr: "or",
  onboardWalk: "to walk around",
  onboardClick: "— or click the floor / a seat",
  onboardCallTip: "Call from the sidebar · DND blocks unexpected calls",
  nudgeText: "Someone's nearby — press M to talk",
  roomHintText: "In the meeting room — nobody outside can hear",

  // Auto-update banner
  updateAvailable: (v: string) => `Hiroba ${v} is available`,
  updateInstall: "Restart to update",
  updateDownloading: "Updating…",
  updateLater: "Later",
  updateFailed: "Update failed — please try again later.",

  // Invite deep link (hiroba://invite/<token>)
  inviteApplied: "Invite link applied — sign in to join the org.",
  joinedOrg: (org: string) => `You joined ${org}.`,
  errJoinOrg: "Couldn't join the organization. Try opening the invite again.",

  // Browser guest (web build opened from an invite link)
  guestJoinHint: "You're joining as a guest from an invite link. Enter a name and you're in.",
  guestGetApp: "Get the desktop app",
  errGuestInvite: "This invite link has expired or was revoked. Ask your teammate for a new one.",

  // HUD
  muted: "Muted",
  live: "Live",
  micTitleMuted: "Click or press M to talk (you're muted)",
  micTitleLive: "Click or press M to mute",
  chatTitle: "Chat",
  chatEmpty: "No messages yet. Say hi!",
  chatPlaceholder: "Message…",
  chatSend: "Send",
  chatDelete: "Delete",
  chatReact: "React",
  chatToday: "Today",
  chatYesterday: "Yesterday",
  chatNew: "New",
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
  dndTitle:
    "Do not disturb — blocks incoming calls and nearby voice; walking up to you won't connect (takes priority over Away)",
  dndEnabled: "Do not disturb on — calls and nearby voice are blocked",
  dndDisabled: "Do not disturb off — calls and nearby voice work again",
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
  ariaAvatarPresets: "Avatar presets",
  avatarPreset: (n: number) => `Avatar ${n}`,
  avatarUpload: "Upload a profile photo",
  avatarRemove: "Remove photo",
  errAvatar: "Couldn't use that image. Try another file.",

  // Space tabs
  ariaSpaces: "Spaces",
  createTeam: "Create a team space",
  teamName: "Team name",
  layoutLabel: "Layout",
  layoutHint: "↑↓ to choose · Enter to create",
  layoutNames: { meeting: "Meeting", desks: "Desks", lounge: "Lounge", cafe: "Café" },
  teamTitle: (name: string) => `${name} (team)`,
  // Built-in space display names (keyed by the server's stable space id).
  spaceLobby: "Lobby",
  spaceDev: "Dev",

  // Paging / call banner
  inCallWith: (name: string) => `In call with ${name}`,
  inCallN: (n: number) => `In call with ${n} people`,
  shareScreen: "Share screen",
  shareScreenTitle: "Share your screen in this call",
  shareScreenRoomTitle: "Share your screen with everyone in this room",
  stopSharing: "Stop sharing",
  stopSharingTitle: "Stop screen sharing",
  closeScreen: "Close screen share",
  enterFullscreen: "Enter fullscreen",
  exitFullscreen: "Exit fullscreen",
  yourScreen: "Your screen",
  sharedScreen: (name: string) => `${name}'s screen`,
  errScreenShare: "Couldn't start screen sharing. Check browser/OS permissions.",
  screenPermTitle: "Allow screen recording",
  screenPermBody:
    "macOS blocks whole-screen sharing until you allow it: open System Settings → Privacy & Security → Screen & System Audio Recording, turn on Hiroba, then relaunch the app. macOS applies the change only after a restart.",
  screenPermOpen: "Open System Settings",
  screenPermRelaunch: "Relaunch Hiroba",
  viewScreen: "View screen",
  viewScreenTitle: "Show the shared screen again",
  cameraOn: "Turn on camera",
  cameraOnTitle: "Turn on your camera in this call",
  cameraOff: "Turn off camera",
  cameraOffTitle: "Turn off your camera",
  yourCamera: "Your camera",
  peerCamera: (name: string) => `${name}'s camera`,
  peerVideo: (name: string) => `${name}'s video`,
  selfViewTitle: "Swap with the main view",
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
  callDropped: "The call ended when the connection dropped.",
};

const JA: typeof EN = {
  // Join card
  signInGoogle: "Google でサインイン",
  signInGithub: "GitHub でサインイン",
  signOutAccount: "Hiroba からサインアウト",
  newOrgAction: "+ 新しい組織を作成",
  orgSetupAnotherDesc: "新しい組織の名前を入力してください。今の組織にも引き続き所属し、いつでも切り替えられます。",
  waitingBrowser: "ブラウザで認証中…",
  restoringSession: "セッションを復元中…",

  // E-mail one-time code sign-in
  authOr: "または",
  fieldEmail: "メールアドレス",
  emailPlaceholder: "you@example.com",
  sendCode: "コードをメールで受け取る",
  sendingCode: "送信中…",
  fieldCode: "ログインコード",
  codeSentTo: (email: string) => `${email} に送信した6桁のコードを入力してください。`,
  verifyCode: "サインイン",
  verifyingCode: "サインイン中…",
  resendCode: "コードを再送する",
  changeEmail: "別のアドレスを使う",
  fieldName: "表示名",
  namePlaceholder: "名前",
  fieldAvatar: "アバター",
  fieldColor: "カラー",
  // Swatch names — 読み上げでは hex 値が意味をなさないため色名で。
  colorClay: "テラコッタ",
  colorAmber: "アンバー",
  colorCoral: "コーラル",
  colorSage: "セージ",
  colorSky: "スカイ",
  colorLilac: "ライラック",
  colorTeal: "ティール",
  colorSlate: "スレート",
  colorCustom: "カスタムカラー",
  serverSettings: "サーバー設定",
  fieldServer: "サーバー",
  fieldToken: "アクセストークン(任意)",
  tokenPlaceholder: "空欄でゲスト参加",
  fieldAuthServer: "認証サーバー",
  fieldInvite: "招待リンク(任意)",
  invitePlaceholder: "招待リンクを貼り付け",
  enter: "オフィスに入る",

  // Org setup (first sign-in without an invite)
  orgSetupTitle: "組織に名前をつけましょう",
  orgSetupDesc: "もう少しです。組織の名前を入力してください。招待した仲間はこの組織に参加します。",
  fieldOrgName: "組織名",
  orgNamePlaceholder: "例:Acme Inc",
  createOrg: "組織を作成",
  creatingOrg: "作成中…",
  backToLogin: "サインインに戻る",
  orgSetupInvitedHint: "既存の組織に招待されていますか?",
  joinWithInvite: "招待で参加",
  joiningWithInvite: "参加中…",
  errInviteCodeMissing: "受け取った招待リンクを貼り付けてください。",

  // 招待ステップ(組織作成直後)+ メール招待
  inviteSetupTitle: "仲間を招待しましょう",
  inviteSetupDesc: (org: string) =>
    `オフィスは人がいてこそです。メールアドレスを入力すると、${org} への参加リンクを送ります。`,
  inviteSetupDescNoEmail: (org: string) =>
    `オフィスは人がいてこそです。招待リンクをコピーして、${org} で一緒に働く仲間に共有してください。`,
  fieldInviteEmails: "メールアドレス",
  inviteEmailsPlaceholder: "aoi@example.com, ren@example.com",
  sendInvites: "メールで招待を送る",
  sendingInvites: "送信中…",
  invitesSentTo: (list: string) => `${list} に招待を送りました。`,
  invitesFailedFor: (list: string) => `${list} には送れませんでした。`,
  copyInviteLinkInstead: "招待リンクをコピーして自分で共有",
  inviteLinkCopied: "招待リンクをコピーしました。仲間に共有してください。",
  inviteSetupEnter: "オフィスに入る",
  errInviteEmails: "メールアドレスを1つ以上入力してください。",
  errSendInvites: "招待を送れませんでした。もう一度お試しください。",
  errInvitesTooMany: "短時間に送った招待が多すぎます。しばらく待ってからお試しください。",
  errEmailInvitesUnavailable: "このサーバーはメールを送れません。招待リンクを共有してください。",

  // トライアル残日数(ホスト版)
  trialDaysLeft: (n: number) => `無料トライアル: 残り${n}日`,
  trialEndsToday: "無料トライアルは今日で終了",
  trialPillTitle: "トライアル後も使うにはお支払い方法を登録してください",

  // Admin menu (gear in the sidebar header)
  adminMenuTitle: "管理メニュー",
  inviteMembers: "メンバーを招待",
  manageBillingTitle: "お支払いの管理",
  invitePanel: "招待",
  closePanel: "閉じる",
  inviteRole: "招待する人のロール",
  roleMember: "メンバー",
  roleAdmin: "管理者",
  inviteHow: "どうやって届けますか？",
  inviteMethodMail: "メールで送る",
  inviteMethodMailDesc: "Hiroba が参加用のリンクをメールします",
  inviteMethodLink: "リンクを共有",
  inviteMethodLinkDesc: "Slack やチャットに自分で貼ります",
  inviteMailHint: "メールアドレスを入力すると、参加用のリンクを Hiroba から送ります。カンマ区切りで複数入れられます。",
  shareInviteLink: "招待リンクを共有",
  inviteLinkHint: "参加用のリンクを 1 つ作ってコピーします。Slack やチャットで相手に貼り付けてください。リンク 1 つで 1 人が参加できます。",
  createInviteLink: "招待リンクを作成してコピー",
  creatingInviteLink: "作成中…",
  inviteLinkReady: "リンクをコピーしました。相手に貼り付けて送ってください。",
  inviteLinkReadyNoClipboard: "リンクを作成しました。コピーして相手に送ってください。",
  inviteLinkHowTo: "相手はこのリンクを開くか、アプリの「招待リンク」欄に貼り付けると参加できます。",
  createAnotherInviteLink: "もう 1 人分のリンクを作る",
  inviteNoEmailNotice: "このサーバーはメール送信が設定されていないため、メールでの招待は使えません。",
  copy: "コピー",
  copied: "コピーしました",
  activeInvites: "未使用の招待",
  noActiveInvites: "未使用の招待はありません。",
  inviteLinkLabel: "招待リンク",
  revokeInvite: "取消",
  inviteExpiresAt: (date: string) => `${date} まで有効`,
  inviteSentBy: (name: string) => `${name} が送信`,
  inviteCreatedBy: (name: string) => `${name} が作成`,

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
  errAuthOffline:
    "認証サーバーに接続できず、セッションを更新できませんでした。サインインは維持されています。ネットワークを確認してもう一度お試しください。",
  errKeychain:
    "保存済みのサインイン情報をキーチェーンから読み込めませんでした。ログインキーチェーンのロックを解除する(またはHirobaのアクセスを許可する)か、もう一度サインインしてください。",
  errSessionNotSaved:
    "サインインしましたが、この端末ではキーチェーンにセッションを保存できませんでした。次回の起動時にまた求められます。",
  errMicDenied: "マイクを使用できません。ブラウザ/OSの権限設定を確認してください。",
  errSignIn: "サインインに失敗しました。もう一度お試しください。",
  errEmail: "有効なメールアドレスを入力してください。",
  errSendCode: "コードを送信できませんでした。アドレスを確認してもう一度お試しください。",
  errCodeThrottled: (secs: number) => `次のコードを送信できるまで ${secs} 秒お待ちください。`,
  errCode: "コードが違うか、有効期限が切れています。新しいコードを取得してください。",
  errInvite: "この招待は無効か、使用済みか、期限切れです。新しい招待をもらってください。",
  errOrgName: "組織名を入力してください。",
  errOrgCreate: "組織を作成できませんでした。もう一度お試しください。",
  errAlreadyInOrg: "すでに組織に所属しています。もう一度サインインしてください。",
  errIssueInvite: "招待リンクを作成できませんでした。もう一度お試しください。",
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

  // 課金ロック(参加画面 — 組織のサブスクリプションが停止中)
  billingLockTrialTitle: "無料トライアルが終了しました",
  billingLockInactiveTitle: "サブスクリプションが停止されています",
  billingLockAdminTrialDesc:
    "引き続き Hiroba を利用するには、サブスクリプションを開始してください。お支払い情報は Stripe の安全なページで入力します。登録後、数分以内に自動的に再開されます。",
  billingLockAdminInactiveDesc:
    "前回のお支払いが確認できませんでした。Stripe の安全なページでお支払い情報を更新すると、数分以内に自動的に再開されます。",
  billingLockMemberDesc: "利用を再開するには、組織の管理者にお問い合わせください。",
  billingLockSubscribe: "サブスクリプションを開始",
  billingLockUpdate: "お支払い情報を更新",
  billingLockSwitchTitle: "または、所属している別の組織で続ける:",

  // 組織切替(サインイン済みチップ — 2つ以上の組織に所属しているとき)
  orgSwitchAria: "組織を切り替え",
  errOrgSwitch: "組織を切り替えられませんでした。もう一度お試しください。",

  // Join card (connecting) / reconnect overlay
  connecting: "接続中…",
  reconnecting: "再接続中…",
  reconnectAttempt: (n: number, max: number) => `再接続中…(${n}/${max} 回目)`,
  reconnectOffline: "ネットワークの回復を待っています…",
  cancel: "キャンセル",

  // Onboarding / nudge
  onboardOr: "または",
  onboardWalk: "で移動",
  onboardClick: "(クリックで移動・席に座れます)",
  onboardCallTip: "サイドバーの「呼ぶ」で通話 · 取り込み中は着信を遮断",
  nudgeText: "近くに誰かいます — M キーで話せます",
  roomHintText: "会議室に入りました — 外には聞こえません",

  // Auto-update banner
  updateAvailable: (v: string) => `Hiroba ${v} が利用できます`,
  updateInstall: "更新して再起動",
  updateDownloading: "更新中…",
  updateLater: "後で",
  updateFailed: "更新に失敗しました。しばらくしてからもう一度お試しください。",

  // Invite deep link (hiroba://invite/<token>)
  inviteApplied: "招待リンクを受け取りました。サインインすると参加できます。",
  joinedOrg: (org: string) => `${org} に参加しました。`,
  errJoinOrg: "組織に参加できませんでした。もう一度招待を開いてください。",

  // Browser guest (web build opened from an invite link)
  guestJoinHint: "招待リンクからゲストとして参加します。名前を入れるだけで入室できます。",
  guestGetApp: "デスクトップ版を入手",
  errGuestInvite: "この招待リンクは期限切れか取り消されています。招待した人に新しいリンクをもらってください。",

  // HUD
  muted: "ミュート中",
  live: "オン",
  micTitleMuted: "クリックか M キーで話す(現在ミュート)",
  micTitleLive: "クリックか M キーでミュート",
  chatTitle: "チャット",
  chatEmpty: "まだメッセージはありません。",
  chatPlaceholder: "メッセージを入力…",
  chatSend: "送信",
  chatDelete: "削除",
  chatReact: "リアクション",
  chatToday: "今日",
  chatYesterday: "昨日",
  chatNew: "ここから未読",
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
  dndTitle:
    "取り込み中 — 着信も近くの人との会話も遮断。近づかれても通話はつながりません（離席より優先）",
  dndEnabled: "取り込み中オン — 着信も近くの会話もつながりません",
  dndDisabled: "取り込み中オフ — 着信と近くの会話を受けられます",
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
  ariaAvatarPresets: "アバターのプリセット",
  avatarPreset: (n: number) => `アバター ${n}`,
  avatarUpload: "プロフィール写真をアップロード",
  avatarRemove: "写真を削除",
  errAvatar: "この画像は使用できませんでした。別のファイルをお試しください。",

  // Space tabs
  ariaSpaces: "スペース",
  createTeam: "チームスペースを作成",
  teamName: "チーム名",
  layoutLabel: "レイアウト",
  layoutHint: "↑↓で選択・Enterで作成",
  layoutNames: { meeting: "会議室", desks: "作業部屋", lounge: "ラウンジ", cafe: "カフェ" },
  teamTitle: (name: string) => `${name}(チーム)`,
  // Built-in space display names (keyed by the server's stable space id).
  spaceLobby: "ロビー",
  spaceDev: "開発",

  // Paging / call banner
  inCallWith: (name: string) => `${name} と通話中`,
  inCallN: (n: number) => `${n}人と通話中`,
  shareScreen: "画面共有",
  shareScreenTitle: "この通話で画面を共有",
  shareScreenRoomTitle: "この部屋の全員に画面を共有",
  stopSharing: "共有停止",
  stopSharingTitle: "画面共有を停止",
  closeScreen: "画面共有を閉じる",
  enterFullscreen: "全画面表示にする",
  exitFullscreen: "全画面表示を終了",
  yourScreen: "自分の画面",
  sharedScreen: (name: string) => `${name} の画面`,
  errScreenShare: "画面共有を開始できませんでした。ブラウザ/OSの権限設定を確認してください。",
  screenPermTitle: "画面収録を許可してください",
  screenPermBody:
    "macOSでは許可がないと画面全体を共有できません。「システム設定 → プライバシーとセキュリティ → 画面収録とシステムオーディオ録音」でHirobaをオンにして、アプリを再起動してください。変更は再起動後に反映されます。",
  screenPermOpen: "システム設定を開く",
  screenPermRelaunch: "Hirobaを再起動",
  viewScreen: "画面を見る",
  viewScreenTitle: "共有画面を再表示",
  cameraOn: "カメラ",
  cameraOnTitle: "この通話でカメラをオンにする",
  cameraOff: "カメラ停止",
  cameraOffTitle: "カメラをオフにする",
  yourCamera: "自分のカメラ",
  peerCamera: (name: string) => `${name} のカメラ`,
  peerVideo: (name: string) => `${name} のビデオ`,
  selfViewTitle: "メイン表示と入れ替え",
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
  callDropped: "切断により通話が終了しました。",
};

const ES: typeof EN = {
  // Join card
  signInGoogle: "Iniciar sesión con Google",
  signInGithub: "Iniciar sesión con GitHub",
  signOutAccount: "Cerrar sesión en Hiroba",
  newOrgAction: "+ Nueva organización",
  orgSetupAnotherDesc: "Ponle nombre a la nueva organización. Sigues en las que ya tienes y puedes cambiar de una a otra cuando quieras.",
  waitingBrowser: "Esperando al navegador…",
  restoringSession: "Restaurando tu sesión…",

  // E-mail one-time code sign-in
  authOr: "o",
  fieldEmail: "Correo electrónico",
  emailPlaceholder: "tu@ejemplo.com",
  sendCode: "Enviarme un código",
  sendingCode: "Enviando…",
  fieldCode: "Código de acceso",
  codeSentTo: (email: string) => `Escribe el código de 6 dígitos que enviamos a ${email}.`,
  verifyCode: "Iniciar sesión",
  verifyingCode: "Iniciando sesión…",
  resendCode: "Enviar otro código",
  changeEmail: "Usar otra dirección",
  fieldName: "Nombre visible",
  namePlaceholder: "Tu nombre",
  fieldAvatar: "Avatar",
  fieldColor: "Tu color",
  colorClay: "Arcilla",
  colorAmber: "Ámbar",
  colorCoral: "Coral",
  colorSage: "Salvia",
  colorSky: "Cielo",
  colorLilac: "Lila",
  colorTeal: "Verde azulado",
  colorSlate: "Pizarra",
  colorCustom: "Color personalizado",
  serverSettings: "Ajustes del servidor",
  fieldServer: "Servidor",
  fieldToken: "Token de acceso (opcional)",
  tokenPlaceholder: "Déjalo vacío para entrar sin cuenta",
  fieldAuthServer: "Servidor de autenticación",
  fieldInvite: "Enlace de invitación (opcional)",
  invitePlaceholder: "Pega un enlace de invitación",
  enter: "Entrar en Hiroba",

  // Org setup (first sign-in without an invite)
  orgSetupTitle: "Ponle nombre a tu organización",
  orgSetupDesc: "Ya casi está. Ponle nombre a tu organización: las personas que invites se unirán a ella.",
  fieldOrgName: "Nombre de la organización",
  orgNamePlaceholder: "p. ej., Acme Inc",
  createOrg: "Crear organización",
  creatingOrg: "Creando…",
  backToLogin: "Volver al inicio de sesión",
  orgSetupInvitedHint: "¿Te invitaron a una organización que ya existe?",
  joinWithInvite: "Unirme con una invitación",
  joiningWithInvite: "Uniéndote…",
  errInviteCodeMissing: "Pega el enlace de invitación que recibiste.",

  // Invite step (right after the org is founded) + invite-by-e-mail
  inviteSetupTitle: "Invita a tu equipo",
  inviteSetupDesc: (org: string) =>
    `Una oficina cobra vida cuando hay gente dentro. Añade algunas direcciones y les enviaremos un enlace para unirse a ${org}.`,
  inviteSetupDescNoEmail: (org: string) =>
    `Una oficina cobra vida cuando hay gente dentro. Copia un enlace de invitación y compártelo con quienes van a estar contigo en ${org}.`,
  fieldInviteEmails: "Correos electrónicos",
  inviteEmailsPlaceholder: "aoi@example.com, ren@example.com",
  sendInvites: "Enviar invitaciones por correo",
  sendingInvites: "Enviando…",
  invitesSentTo: (list: string) => `Invitaciones enviadas a ${list}.`,
  invitesFailedFor: (list: string) => `No se pudo enviar a ${list}.`,
  copyInviteLinkInstead: "Copiar un enlace de invitación para compartirlo tú",
  inviteLinkCopied: "Enlace de invitación copiado. Compártelo con tu equipo.",
  inviteSetupEnter: "Entrar en la oficina",
  errInviteEmails: "Escribe al menos un correo electrónico.",
  errSendInvites: "No se pudieron enviar las invitaciones. Inténtalo de nuevo.",
  errInvitesTooMany: "Se enviaron demasiadas invitaciones hace poco. Espera un rato e inténtalo de nuevo.",
  errEmailInvitesUnavailable: "Este servidor no puede enviar correos. Comparte un enlace de invitación.",

  // Trial countdown (hosted; the org's subscription is trialing)
  trialDaysLeft: (n: number) =>
    n === 1 ? "Prueba gratuita: queda 1 día" : `Prueba gratuita: quedan ${n} días`,
  trialEndsToday: "La prueba gratuita termina hoy",
  trialPillTitle: "Añade un método de pago para seguir usando Hiroba después de la prueba",

  // Admin menu (gear in the sidebar header)
  adminMenuTitle: "Ajustes de administración",
  inviteMembers: "Invitar miembros",
  manageBillingTitle: "Gestionar facturación",
  invitePanel: "Invitaciones",
  closePanel: "Cerrar",
  inviteRole: "Rol de la persona invitada",
  roleMember: "Miembro",
  roleAdmin: "Administrador",
  inviteHow: "¿Cómo quieres hacérsela llegar?",
  inviteMethodMail: "Enviar por correo",
  inviteMethodMailDesc: "Hiroba les envía por correo un enlace para unirse",
  inviteMethodLink: "Compartir un enlace",
  inviteMethodLinkDesc: "Tú lo pegas en Slack o en un chat",
  inviteMailHint: "Escribe correos electrónicos y Hiroba enviará a cada uno un enlace para unirse. Separa varios con comas.",
  shareInviteLink: "Compartir un enlace de invitación",
  inviteLinkHint: "Crea un enlace para unirse y lo copia. Pégaselo a tu compañero en Slack o en un chat. Cada enlace admite a una persona.",
  createInviteLink: "Crear y copiar un enlace de invitación",
  creatingInviteLink: "Creando…",
  inviteLinkReady: "Enlace copiado. Pégaselo a tu compañero.",
  inviteLinkReadyNoClipboard: "Enlace creado. Cópialo y envíaselo a tu compañero.",
  inviteLinkHowTo: "Para unirse, abren el enlace o lo pegan en el campo de enlace de invitación de la app.",
  createAnotherInviteLink: "Crear un enlace para otra persona",
  inviteNoEmailNotice: "Este servidor no tiene correo configurado, así que las invitaciones solo van por enlace.",
  copy: "Copiar",
  copied: "¡Copiado!",
  activeInvites: "Invitaciones pendientes",
  noActiveInvites: "No hay invitaciones pendientes.",
  inviteLinkLabel: "Enlace de invitación",
  revokeInvite: "Revocar",
  inviteExpiresAt: (date: string) => `caduca el ${date}`,
  inviteSentBy: (name: string) => `enviada por ${name}`,
  inviteCreatedBy: (name: string) => `creada por ${name}`,

  // Errors
  errName: "Escribe un nombre visible.",
  errServer: "Escribe la URL del servidor.",
  errAuthUrl: "Configura la URL del servidor de autenticación (en Ajustes del servidor).",
  errConnect: "No se pudo conectar con el servidor. Revisa la URL e inténtalo de nuevo.",
  errAuthFailed: "El servidor rechazó el inicio de sesión. Vuelve a iniciar sesión e inténtalo de nuevo.",
  errOrgSuspended: "Esta organización está suspendida. Pide a un administrador que actualice la facturación.",
  errSpaceFull: "Este espacio está lleno. Prueba otro espacio o consulta a un administrador.",
  errSpaceLimit: "Esta organización alcanzó su límite de espacios.",
  errUnknownSpace: "Ese espacio ya no existe. Vuelve a entrar y elige otro.",
  errForbidden: "No tienes permiso para realizar esta acción.",
  errRejoin: "Se perdió la conexión con el servidor. Vuelve a entrar.",
  errSessionExpired: "Tu sesión caducó. Vuelve a iniciar sesión.",
  errAuthOffline:
    "No se pudo contactar con el servidor de autenticación para renovar tu sesión. Tu sesión sigue abierta: revisa tu conexión e inténtalo de nuevo.",
  errKeychain:
    "No se pudo leer tu inicio de sesión guardado en el llavero. Desbloquea el llavero de inicio de sesión (o permite el acceso a Hiroba) y reinicia, o vuelve a iniciar sesión.",
  errSessionNotSaved:
    "Sesión iniciada, pero este dispositivo no pudo guardarla en el llavero. La próxima vez que abras la app te la volverá a pedir.",
  errMicDenied: "Acceso al micrófono denegado. Revisa los permisos del navegador o del sistema.",
  errSignIn: "No se pudo iniciar sesión. Inténtalo de nuevo.",
  errEmail: "Escribe un correo electrónico válido.",
  errSendCode: "No se pudo enviar el código. Revisa la dirección e inténtalo de nuevo.",
  errCodeThrottled: (secs: number) => `Espera ${secs} s antes de pedir otro código.`,
  errCode: "El código es incorrecto o caducó. Pide uno nuevo.",
  errInvite: "La invitación no es válida, ya se usó o caducó. Pide una nueva.",
  errOrgName: "Escribe el nombre de la organización.",
  errOrgCreate: "No se pudo crear la organización. Inténtalo de nuevo.",
  errAlreadyInOrg: "Ya perteneces a una organización. Vuelve a iniciar sesión.",
  errIssueInvite: "No se pudo crear el enlace de invitación. Inténtalo de nuevo.",
  errLoadInvites: "No se pudieron cargar las invitaciones.",

  // Member management (admin)
  manageMembersTitle: "Gestionar miembros",
  removeMember: "Quitar",
  confirmRemoveMember: "¿Confirmar?",
  errLoadMembers: "No se pudieron cargar los miembros.",
  errRemoveMember: "No se pudo quitar a ese miembro. Inténtalo de nuevo.",
  openingBilling: "Abriendo la facturación…",
  billingNotEnabled: "La facturación no está habilitada en esta instalación.",
  errBillingPortal: "No se pudo abrir el portal de facturación. Inténtalo de nuevo.",

  // Billing lock (join screen; the org's subscription is paused or lapsed)
  billingLockTrialTitle: "Tu prueba gratuita terminó",
  billingLockInactiveTitle: "Tu suscripción está inactiva",
  billingLockAdminTrialDesc:
    "Para seguir usando Hiroba, inicia tu suscripción. Introducirás los datos de pago en la página segura de Stripe y Hiroba se reactivará solo en unos minutos.",
  billingLockAdminInactiveDesc:
    "No pudimos cobrar el último pago. Actualiza tus datos de pago en la página segura de Stripe y Hiroba se reactivará solo en unos minutos.",
  billingLockMemberDesc: "Pide al administrador de tu organización que actualice la suscripción.",
  billingLockSubscribe: "Iniciar suscripción",
  billingLockUpdate: "Actualizar datos de pago",
  billingLockSwitchTitle: "O continúa en otra organización a la que perteneces:",

  // Org switcher (signed-in chip; shown when the user belongs to 2+ orgs)
  orgSwitchAria: "Cambiar de organización",
  errOrgSwitch: "No se pudo cambiar de organización. Inténtalo de nuevo.",

  // Join card (connecting) / reconnect overlay
  connecting: "Conectando…",
  reconnecting: "Reconectando…",
  reconnectAttempt: (n: number, max: number) => `Reconectando… (intento ${n}/${max})`,
  reconnectOffline: "Esperando la red…",
  cancel: "Cancelar",

  // Onboarding / nudge
  onboardOr: "o",
  onboardWalk: "para moverte",
  onboardClick: "— o haz clic en el suelo o en un asiento",
  onboardCallTip: "Llama desde la barra lateral · No molestar bloquea las llamadas inesperadas",
  nudgeText: "Hay alguien cerca: pulsa M para hablar",
  roomHintText: "En la sala de reuniones: nadie de fuera puede oírte",

  // Auto-update banner
  updateAvailable: (v: string) => `Hiroba ${v} está disponible`,
  updateInstall: "Reiniciar para actualizar",
  updateDownloading: "Actualizando…",
  updateLater: "Más tarde",
  updateFailed: "No se pudo actualizar. Inténtalo de nuevo más tarde.",

  // Invite deep link (hiroba://invite/<token>)
  inviteApplied: "Enlace de invitación aplicado. Inicia sesión para unirte a la organización.",
  joinedOrg: (org: string) => `Te uniste a ${org}.`,
  errJoinOrg: "No fue posible unirte a la organización. Vuelve a abrir la invitación.",

  // Browser guest (web build opened from an invite link)
  guestJoinHint: "Entras con un enlace de invitación, sin cuenta. Escribe un nombre y listo.",
  guestGetApp: "Descargar la app",
  errGuestInvite: "Este enlace de invitación caducó o fue revocado. Pide uno nuevo a quien te lo envió.",

  // HUD
  muted: "Silenciado",
  live: "Activo",
  micTitleMuted: "Haz clic o pulsa M para hablar (micrófono silenciado)",
  micTitleLive: "Haz clic o pulsa M para silenciar",
  chatTitle: "Chat",
  chatEmpty: "Aún no hay mensajes. ¡Saluda!",
  chatPlaceholder: "Mensaje…",
  chatSend: "Enviar",
  chatDelete: "Eliminar",
  chatReact: "Reaccionar",
  chatToday: "Hoy",
  chatYesterday: "Ayer",
  chatNew: "Nuevos",
  leave: "Salir",
  leaveTitle: "Salir de la oficina",

  // Audio settings panel (gear next to the mic button)
  audioSettingsTitle: "Ajustes de audio",
  fieldMicrophone: "Micrófono",
  fieldSpeaker: "Altavoz",
  fieldLanguage: "Idioma",
  langAriaLabel: "Idioma",
  micLevelAria: "Nivel de entrada del micrófono",
  defaultDevice: "Predeterminado del sistema",

  // Sidebar / roster — status is a mutually exclusive 3-way choice
  // The status toggle is narrow: its labels stay short, the tooltips spell them out.
  active: "Activo",
  activeTitle: "Disponible. Pasa a Ausente tras 5 minutos de inactividad.",
  away: "Ausente",
  awayTitle:
    "Ausente: una señal discreta de que no estás. También se activa sola tras 5 minutos de inactividad; cualquier actividad te devuelve a Activo.",
  dnd: "Ocupado",
  dndTitle:
    "Ocupado (no molestar): bloquea las llamadas entrantes y la voz cercana; acercarse a ti no conecta (tiene prioridad sobre Ausente)",
  dndEnabled: "No molestar activado: las llamadas y la voz cercana están bloqueadas",
  dndDisabled: "No molestar desactivado: las llamadas y la voz cercana vuelven a funcionar",
  idleAwayToast: (min: number) =>
    `Ausente tras ${min} min de inactividad. Muévete o haz clic para volver a Activo`,
  youName: (name: string) => `${name} (tú)`,
  callBtn: "Llamar",
  callTitle: (name: string) => `Llamar a ${name}`,
  rosterEmpty: "Por ahora solo estás tú. Tu equipo aparecerá aquí cuando entre.",
  statusInCall: "En una llamada",
  statusDnd: "No molestar",
  statusAway: "Ausente",
  statusOffline: "Sin conexión",
  ariaMembers: "Miembros",
  ariaStatus: "Tu estado",
  ariaColor: "Color del avatar",
  ariaAvatarPresets: "Avatares predefinidos",
  avatarPreset: (n: number) => `Avatar ${n}`,
  avatarUpload: "Subir una foto de perfil",
  avatarRemove: "Quitar foto",
  errAvatar: "No se pudo usar esa imagen. Prueba con otro archivo.",

  // Space tabs
  ariaSpaces: "Espacios",
  createTeam: "Crear un espacio de equipo",
  teamName: "Nombre del equipo",
  layoutLabel: "Distribución",
  layoutHint: "↑↓ para elegir · Enter para crear",
  layoutNames: { meeting: "Reunión", desks: "Escritorios", lounge: "Salón", cafe: "Café" },
  teamTitle: (name: string) => `${name} (equipo)`,
  // Built-in space display names (keyed by the server's stable space id).
  spaceLobby: "Vestíbulo",
  spaceDev: "Desarrollo",

  // Paging / call banner
  inCallWith: (name: string) => `En llamada con ${name}`,
  inCallN: (n: number) => `En llamada con ${n} personas`,
  shareScreen: "Compartir pantalla",
  shareScreenTitle: "Comparte tu pantalla en esta llamada",
  shareScreenRoomTitle: "Comparte tu pantalla con todos en esta sala",
  stopSharing: "Dejar de compartir",
  stopSharingTitle: "Dejar de compartir la pantalla",
  closeScreen: "Cerrar la pantalla compartida",
  enterFullscreen: "Pantalla completa",
  exitFullscreen: "Salir de pantalla completa",
  yourScreen: "Tu pantalla",
  sharedScreen: (name: string) => `Pantalla de ${name}`,
  errScreenShare: "No se pudo compartir la pantalla. Revisa los permisos del navegador o del sistema.",
  screenPermTitle: "Permitir la grabación de pantalla",
  screenPermBody:
    "macOS bloquea compartir la pantalla completa hasta que lo permitas: abre Ajustes del Sistema → Privacidad y seguridad → Grabación de pantalla, activa Hiroba y vuelve a abrir la app. macOS solo aplica el cambio después de reiniciarla.",
  screenPermOpen: "Abrir Ajustes del Sistema",
  screenPermRelaunch: "Reiniciar Hiroba",
  viewScreen: "Ver pantalla",
  viewScreenTitle: "Volver a mostrar la pantalla compartida",
  cameraOn: "Activar cámara",
  cameraOnTitle: "Activa tu cámara en esta llamada",
  cameraOff: "Desactivar cámara",
  cameraOffTitle: "Desactiva tu cámara",
  yourCamera: "Tu cámara",
  peerCamera: (name: string) => `Cámara de ${name}`,
  peerVideo: (name: string) => `Video de ${name}`,
  selfViewTitle: "Intercambiar con la vista principal",
  errCameraDenied: "Acceso a la cámara denegado. Revisa los permisos del navegador o del sistema.",
  hangUp: "Colgar",
  pageCancel: "Cancelar",
  pageDecline: "Rechazar",
  pageAccept: "Contestar",
  someone: "La otra persona",
  pageCalling: (name: string) => `Llamando a ${name}…`,
  pageIncoming: (name: string) => `Llamada entrante de ${name}`,
  pageDnd: (name: string) => `${name} está en No molestar.`,
  pageBusy: (name: string) => `${name} ya está en una llamada.`,
  pageOffline: (name: string) => `${name} está sin conexión.`,
  pageDeclined: (name: string) => `${name} rechazó la llamada.`,
  pageTimeout: (name: string) => `${name} no contestó.`,
  pageMissed: (name: string) => `Tienes una llamada perdida de ${name}.`,
  callDropped: "La llamada terminó porque se cortó la conexión.",
};

// French typography: a no-break space (U+00A0) precedes : ; ! ? and pads « ».
const FR: typeof EN = {
  // Join card
  signInGoogle: "Se connecter avec Google",
  signInGithub: "Se connecter avec GitHub",
  signOutAccount: "Se déconnecter de Hiroba",
  newOrgAction: "+ Nouvelle organisation",
  orgSetupAnotherDesc: "Donnez un nom à la nouvelle organisation. Vous restez membre de vos organisations actuelles et pouvez passer de l'une à l'autre à tout moment.",
  waitingBrowser: "En attente du navigateur…",
  restoringSession: "Restauration de votre session…",

  // E-mail one-time code sign-in
  authOr: "ou",
  fieldEmail: "Adresse e-mail",
  emailPlaceholder: "vous@exemple.com",
  sendCode: "Recevoir un code par e-mail",
  sendingCode: "Envoi…",
  fieldCode: "Code de connexion",
  codeSentTo: (email: string) => `Saisissez le code à 6 chiffres envoyé à ${email}.`,
  verifyCode: "Se connecter",
  verifyingCode: "Connexion…",
  resendCode: "Renvoyer un code",
  changeEmail: "Utiliser une autre adresse",
  fieldName: "Nom affiché",
  namePlaceholder: "Votre nom",
  fieldAvatar: "Avatar",
  fieldColor: "Votre couleur",
  colorClay: "Argile",
  colorAmber: "Ambre",
  colorCoral: "Corail",
  colorSage: "Sauge",
  colorSky: "Ciel",
  colorLilac: "Lilas",
  colorTeal: "Bleu canard",
  colorSlate: "Ardoise",
  colorCustom: "Couleur personnalisée",
  serverSettings: "Paramètres du serveur",
  fieldServer: "Serveur",
  fieldToken: "Jeton d'accès (facultatif)",
  tokenPlaceholder: "Laissez vide pour le mode invité",
  fieldAuthServer: "Serveur d'authentification",
  fieldInvite: "Lien d'invitation (facultatif)",
  invitePlaceholder: "Collez un lien d'invitation",
  enter: "Entrer dans Hiroba",

  // Org setup (first sign-in without an invite)
  orgSetupTitle: "Nommez votre organisation",
  orgSetupDesc: "Vous y êtes presque. Donnez un nom à votre organisation : les personnes que vous inviterez la rejoindront.",
  fieldOrgName: "Nom de l'organisation",
  orgNamePlaceholder: "ex. : Acme Inc",
  createOrg: "Créer l'organisation",
  creatingOrg: "Création…",
  backToLogin: "Retour à la connexion",
  orgSetupInvitedHint: "Vous avez reçu une invitation pour une organisation existante ?",
  joinWithInvite: "Rejoindre avec une invitation",
  joiningWithInvite: "Adhésion en cours…",
  errInviteCodeMissing: "Collez le lien d'invitation que vous avez reçu.",

  // Invite step (right after the org is founded) + invite-by-e-mail
  inviteSetupTitle: "Invitez vos collègues",
  inviteSetupDesc: (org: string) =>
    `Un bureau prend vie quand il y a du monde dedans. Ajoutez quelques adresses et nous leur enverrons un lien pour rejoindre ${org}.`,
  inviteSetupDescNoEmail: (org: string) =>
    `Un bureau prend vie quand il y a du monde dedans. Copiez un lien d'invitation et partagez-le avec les personnes qui vous rejoindront dans ${org}.`,
  fieldInviteEmails: "Adresses e-mail",
  inviteEmailsPlaceholder: "aoi@example.com, ren@example.com",
  sendInvites: "Envoyer les invitations par e-mail",
  sendingInvites: "Envoi…",
  invitesSentTo: (list: string) => `Invitations envoyées à ${list}.`,
  invitesFailedFor: (list: string) => `Échec de l'envoi à ${list}.`,
  copyInviteLinkInstead: "Copier un lien d'invitation à partager vous-même",
  inviteLinkCopied: "Lien d'invitation copié : partagez-le avec vos collègues.",
  inviteSetupEnter: "Entrer dans le bureau",
  errInviteEmails: "Saisissez au moins une adresse e-mail.",
  errSendInvites: "Impossible d'envoyer les invitations. Veuillez réessayer.",
  errInvitesTooMany: "Trop d'invitations envoyées récemment. Patientez un moment, puis réessayez.",
  errEmailInvitesUnavailable: "Ce serveur ne peut pas envoyer d'e-mails : partagez plutôt un lien d'invitation.",

  // Trial countdown (hosted; the org's subscription is trialing)
  trialDaysLeft: (n: number) =>
    n === 1 ? "Essai gratuit : 1 jour restant" : `Essai gratuit : ${n} jours restants`,
  trialEndsToday: "L'essai gratuit se termine aujourd'hui",
  trialPillTitle: "Ajoutez un moyen de paiement pour continuer à utiliser Hiroba après l'essai",

  // Admin menu (gear in the sidebar header)
  adminMenuTitle: "Paramètres d'administration",
  inviteMembers: "Inviter des membres",
  manageBillingTitle: "Gérer la facturation",
  invitePanel: "Invitations",
  closePanel: "Fermer",
  inviteRole: "Rôle de la personne invitée",
  roleMember: "Membre",
  roleAdmin: "Administrateur",
  inviteHow: "Comment la lui transmettre ?",
  inviteMethodMail: "Envoyer par e-mail",
  inviteMethodMailDesc: "Hiroba lui envoie par e-mail un lien pour rejoindre",
  inviteMethodLink: "Partager un lien",
  inviteMethodLinkDesc: "Vous le collez vous-même dans Slack ou un chat",
  inviteMailHint: "Saisissez des adresses e-mail : Hiroba enverra à chacune un lien pour rejoindre. Séparez-les par des virgules.",
  shareInviteLink: "Partager un lien d'invitation",
  inviteLinkHint: "Crée un lien pour rejoindre et le copie. Collez-le à votre collègue dans Slack ou un chat. Un lien admet une seule personne.",
  createInviteLink: "Créer et copier un lien d'invitation",
  creatingInviteLink: "Création…",
  inviteLinkReady: "Lien copié. Collez-le à votre collègue.",
  inviteLinkReadyNoClipboard: "Lien créé. Copiez-le et envoyez-le à votre collègue.",
  inviteLinkHowTo: "Pour rejoindre, la personne ouvre le lien ou le colle dans le champ Lien d'invitation de l'application.",
  createAnotherInviteLink: "Créer un lien pour une autre personne",
  inviteNoEmailNotice: "Ce serveur n'a pas d'e-mail configuré : les invitations passent uniquement par lien.",
  copy: "Copier",
  copied: "Copié !",
  activeInvites: "Invitations en attente",
  noActiveInvites: "Aucune invitation en attente.",
  inviteLinkLabel: "Lien d'invitation",
  revokeInvite: "Révoquer",
  inviteExpiresAt: (date: string) => `expire le ${date}`,
  inviteSentBy: (name: string) => `envoyée par ${name}`,
  inviteCreatedBy: (name: string) => `créée par ${name}`,

  // Errors
  errName: "Veuillez saisir un nom affiché.",
  errServer: "Veuillez saisir l'URL du serveur.",
  errAuthUrl: "Veuillez définir l'URL du serveur d'authentification (dans Paramètres du serveur).",
  errConnect: "Impossible de se connecter au serveur. Vérifiez l'URL et réessayez.",
  errAuthFailed: "Le serveur a refusé la connexion. Reconnectez-vous et réessayez.",
  errOrgSuspended: "Cette organisation est suspendue. Demandez à un administrateur de mettre à jour la facturation.",
  errSpaceFull: "Cet espace est complet. Essayez un autre espace ou contactez un administrateur.",
  errSpaceLimit: "Cette organisation a atteint sa limite d'espaces.",
  errUnknownSpace: "Cet espace n'existe plus. Reconnectez-vous et choisissez-en un autre.",
  errForbidden: "Vous n'avez pas l'autorisation d'effectuer cette action.",
  errRejoin: "Connexion au serveur perdue. Veuillez vous reconnecter.",
  errSessionExpired: "Votre session a expiré. Veuillez vous reconnecter.",
  errAuthOffline:
    "Impossible de joindre le serveur d'authentification pour renouveler votre session. Votre session reste active : vérifiez votre connexion et réessayez.",
  errKeychain:
    "Impossible de lire votre connexion enregistrée dans le trousseau. Déverrouillez le trousseau « session » (ou autorisez l'accès à Hiroba) et redémarrez, ou reconnectez-vous.",
  errSessionNotSaved:
    "Connexion réussie, mais cet appareil n'a pas pu enregistrer la session dans le trousseau : elle vous sera redemandée au prochain lancement.",
  errMicDenied: "Accès au micro refusé. Vérifiez les autorisations du navigateur ou du système.",
  errSignIn: "Échec de la connexion. Veuillez réessayer.",
  errEmail: "Veuillez saisir une adresse e-mail valide.",
  errSendCode: "Impossible d'envoyer le code. Vérifiez l'adresse et réessayez.",
  errCodeThrottled: (secs: number) => `Veuillez patienter ${secs} s avant de demander un autre code.`,
  errCode: "Ce code est incorrect ou a expiré. Demandez-en un nouveau.",
  errInvite: "Cette invitation est invalide, déjà utilisée ou expirée. Demandez-en une nouvelle.",
  errOrgName: "Veuillez saisir un nom d'organisation.",
  errOrgCreate: "Impossible de créer l'organisation. Veuillez réessayer.",
  errAlreadyInOrg: "Vous appartenez déjà à une organisation. Veuillez vous reconnecter.",
  errIssueInvite: "Impossible de créer le lien d'invitation. Veuillez réessayer.",
  errLoadInvites: "Impossible de charger les invitations.",

  // Member management (admin)
  manageMembersTitle: "Gérer les membres",
  removeMember: "Retirer",
  confirmRemoveMember: "Confirmer ?",
  errLoadMembers: "Impossible de charger les membres.",
  errRemoveMember: "Impossible de retirer ce membre. Veuillez réessayer.",
  openingBilling: "Ouverture de la facturation…",
  billingNotEnabled: "La facturation n'est pas activée sur ce déploiement.",
  errBillingPortal: "Impossible d'ouvrir le portail de facturation. Veuillez réessayer.",

  // Billing lock (join screen; the org's subscription is paused or lapsed)
  billingLockTrialTitle: "Votre essai gratuit est terminé",
  billingLockInactiveTitle: "Votre abonnement est inactif",
  billingLockAdminTrialDesc:
    "Pour continuer à utiliser Hiroba, démarrez votre abonnement. Vous saisirez vos informations de paiement sur la page sécurisée de Stripe, et Hiroba reprendra automatiquement en quelques minutes.",
  billingLockAdminInactiveDesc:
    "Le dernier paiement n'a pas pu être encaissé. Mettez à jour vos informations de paiement sur la page sécurisée de Stripe, et Hiroba reprendra automatiquement en quelques minutes.",
  billingLockMemberDesc: "Demandez à l'administrateur de votre organisation de mettre à jour l'abonnement.",
  billingLockSubscribe: "Démarrer l'abonnement",
  billingLockUpdate: "Mettre à jour le paiement",
  billingLockSwitchTitle: "Ou continuez dans une autre organisation dont vous êtes membre :",

  // Org switcher (signed-in chip; shown when the user belongs to 2+ orgs)
  orgSwitchAria: "Changer d'organisation",
  errOrgSwitch: "Impossible de changer d'organisation. Veuillez réessayer.",

  // Join card (connecting) / reconnect overlay
  connecting: "Connexion…",
  reconnecting: "Reconnexion…",
  reconnectAttempt: (n: number, max: number) => `Reconnexion… (tentative ${n}/${max})`,
  reconnectOffline: "En attente du réseau…",
  cancel: "Annuler",

  // Onboarding / nudge
  onboardOr: "ou",
  onboardWalk: "pour vous déplacer",
  onboardClick: "— ou cliquez sur le sol ou sur un siège",
  onboardCallTip: "Appelez depuis la barre latérale · Ne pas déranger bloque les appels imprévus",
  nudgeText: "Quelqu'un est à proximité : appuyez sur M pour parler",
  roomHintText: "En salle de réunion : personne à l'extérieur ne vous entend",

  // Auto-update banner
  updateAvailable: (v: string) => `Hiroba ${v} est disponible`,
  updateInstall: "Redémarrer pour mettre à jour",
  updateDownloading: "Mise à jour…",
  updateLater: "Plus tard",
  updateFailed: "Échec de la mise à jour. Veuillez réessayer plus tard.",

  // Invite deep link (hiroba://invite/<token>)
  inviteApplied: "Lien d'invitation appliqué : connectez-vous pour rejoindre l'organisation.",
  joinedOrg: (org: string) => `Vous avez rejoint ${org}.`,
  errJoinOrg: "Impossible de rejoindre l'organisation. Essayez de rouvrir l'invitation.",

  // Browser guest (web build opened from an invite link)
  guestJoinHint: "Vous entrez via un lien d'invitation, sans compte. Saisissez un nom et c'est parti.",
  guestGetApp: "Télécharger l'app",
  errGuestInvite: "Ce lien d'invitation a expiré ou a été révoqué. Demandez-en un nouveau à la personne qui vous l'a envoyé.",

  // HUD
  muted: "Muet",
  live: "Actif",
  micTitleMuted: "Cliquez ou appuyez sur M pour parler (micro coupé)",
  micTitleLive: "Cliquez ou appuyez sur M pour couper le micro",
  chatTitle: "Discussion",
  chatEmpty: "Aucun message pour l'instant. Dites bonjour !",
  chatPlaceholder: "Message…",
  chatSend: "Envoyer",
  chatDelete: "Supprimer",
  chatReact: "Réagir",
  chatToday: "Aujourd'hui",
  chatYesterday: "Hier",
  chatNew: "Nouveaux",
  leave: "Quitter",
  leaveTitle: "Quitter le bureau",

  // Audio settings panel (gear next to the mic button)
  audioSettingsTitle: "Paramètres audio",
  fieldMicrophone: "Microphone",
  fieldSpeaker: "Haut-parleur",
  fieldLanguage: "Langue",
  langAriaLabel: "Langue",
  micLevelAria: "Niveau d'entrée du microphone",
  defaultDevice: "Par défaut du système",

  // Sidebar / roster — status is a mutually exclusive 3-way choice
  // The status toggle is narrow: its labels stay short, the tooltips spell them out.
  active: "Actif",
  activeTitle: "Disponible. Passe en Absent après 5 minutes d'inactivité.",
  away: "Absent",
  awayTitle:
    "Absent : signal discret d'inactivité. S'active aussi automatiquement après 5 minutes sans activité ; la moindre action vous remet en Actif.",
  dnd: "Occupé",
  dndTitle:
    "Occupé (ne pas déranger) : bloque les appels entrants et la voix à proximité ; s'approcher de vous ne lance pas de conversation (prioritaire sur Absent)",
  dndEnabled: "Ne pas déranger activé : appels et voix à proximité bloqués",
  dndDisabled: "Ne pas déranger désactivé : appels et voix à proximité rétablis",
  idleAwayToast: (min: number) =>
    `Absent après ${min} min d'inactivité : bougez ou cliquez pour revenir en Actif`,
  youName: (name: string) => `${name} (vous)`,
  callBtn: "Appeler",
  callTitle: (name: string) => `Appeler ${name}`,
  rosterEmpty: "Personne d'autre pour l'instant : vos collègues apparaîtront ici dès leur arrivée.",
  statusInCall: "En appel",
  statusDnd: "Ne pas déranger",
  statusAway: "Absent",
  statusOffline: "Hors ligne",
  ariaMembers: "Membres",
  ariaStatus: "Votre statut",
  ariaColor: "Couleur de l'avatar",
  ariaAvatarPresets: "Avatars prédéfinis",
  avatarPreset: (n: number) => `Avatar ${n}`,
  avatarUpload: "Importer une photo de profil",
  avatarRemove: "Supprimer la photo",
  errAvatar: "Impossible d'utiliser cette image. Essayez un autre fichier.",

  // Space tabs
  ariaSpaces: "Espaces",
  createTeam: "Créer un espace d'équipe",
  teamName: "Nom de l'équipe",
  layoutLabel: "Disposition",
  layoutHint: "↑↓ pour choisir · Entrée pour créer",
  layoutNames: { meeting: "Réunion", desks: "Bureaux", lounge: "Salon", cafe: "Café" },
  teamTitle: (name: string) => `${name} (équipe)`,
  // Built-in space display names (keyed by the server's stable space id).
  spaceLobby: "Hall",
  spaceDev: "Développement",

  // Paging / call banner — names are never preceded by "de", which would
  // need elision ("d'Aoi") the template can't know about.
  inCallWith: (name: string) => `En appel avec ${name}`,
  inCallN: (n: number) => `En appel avec ${n} personnes`,
  shareScreen: "Partager l'écran",
  shareScreenTitle: "Partager votre écran dans cet appel",
  shareScreenRoomTitle: "Partager votre écran avec tout le monde dans cette pièce",
  stopSharing: "Arrêter le partage",
  stopSharingTitle: "Arrêter le partage d'écran",
  closeScreen: "Fermer le partage d'écran",
  enterFullscreen: "Plein écran",
  exitFullscreen: "Quitter le plein écran",
  yourScreen: "Votre écran",
  sharedScreen: (name: string) => `Écran partagé par ${name}`,
  errScreenShare: "Impossible de lancer le partage d'écran. Vérifiez les autorisations du navigateur ou du système.",
  screenPermTitle: "Autoriser l'enregistrement de l'écran",
  screenPermBody:
    "macOS bloque le partage de l'écran entier tant que vous ne l'avez pas autorisé : ouvrez Réglages Système → Confidentialité et sécurité → Enregistrement de l'écran, activez Hiroba, puis relancez l'application. macOS n'applique le changement qu'après un redémarrage.",
  screenPermOpen: "Ouvrir Réglages Système",
  screenPermRelaunch: "Relancer Hiroba",
  viewScreen: "Voir l'écran",
  viewScreenTitle: "Afficher à nouveau l'écran partagé",
  cameraOn: "Activer la caméra",
  cameraOnTitle: "Activer votre caméra dans cet appel",
  cameraOff: "Désactiver la caméra",
  cameraOffTitle: "Désactiver votre caméra",
  yourCamera: "Votre caméra",
  peerCamera: (name: string) => `${name} (caméra)`,
  peerVideo: (name: string) => `${name} (vidéo)`,
  selfViewTitle: "Échanger avec la vue principale",
  errCameraDenied: "Accès à la caméra refusé. Vérifiez les autorisations du navigateur ou du système.",
  hangUp: "Raccrocher",
  pageCancel: "Annuler",
  pageDecline: "Refuser",
  pageAccept: "Répondre",
  someone: "L'autre personne",
  pageCalling: (name: string) => `Appel vers ${name}…`,
  pageIncoming: (name: string) => `${name} vous appelle`,
  pageDnd: (name: string) => `${name} est en mode Ne pas déranger.`,
  pageBusy: (name: string) => `${name} est déjà en appel.`,
  pageOffline: (name: string) => `${name} est hors ligne.`,
  pageDeclined: (name: string) => `${name} a refusé l'appel.`,
  pageTimeout: (name: string) => `${name} n'a pas répondu.`,
  pageMissed: (name: string) => `${name} a essayé de vous appeler.`,
  callDropped: "L'appel s'est terminé à cause d'une perte de connexion.",
};

const CATALOGS: Record<Locale, typeof EN> = { en: EN, ja: JA, es: ES, fr: FR };

/** The active message catalog. Reassigned by {@link setLocale}. */
export let t: typeof EN = CATALOGS[locale];

/**
 * Switch the UI language, persist the choice, and rewrite static `data-i18n*`
 * nodes. Returns `true` when the locale actually changed. Callers that hold
 * dynamic strings (roster labels, call banner, …) should re-render afterward.
 */
export function setLocale(next: Locale): boolean {
  if (!isLocale(next)) return false;
  if (next === locale) return false;
  locale = next;
  t = CATALOGS[next];
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
