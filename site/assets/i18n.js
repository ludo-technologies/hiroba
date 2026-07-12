/**
 * i18n.js — UI strings for the Hiroba marketing site (EN / JA).
 *
 * Locale is picked at boot from `?lang=` (if valid), else `navigator.language`
 * (ja → Japanese, anything else → English). Static DOM nodes opt in via
 * `data-i18n` (textContent), `data-i18n-html` (innerHTML), `data-i18n-href`,
 * `data-i18n-title`, `data-i18n-arialabel`, and `data-i18n-meta` (content).
 */
(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const langParam = params.get('lang');
  const locale =
    langParam === 'ja' || langParam === 'en'
      ? langParam
      : typeof navigator !== 'undefined' && /^ja\b/i.test(navigator.language ?? '')
        ? 'ja'
        : 'en';

  // Legacy href for any remaining scroll-to-download links.
  const ctaDownloadHref = '#download';

  const EN = {
    // Shared <head>
    indexDocTitle: 'Hiroba — Featherweight virtual office',
    indexMetaDescription:
      'Hiroba is a featherweight virtual office you can leave running all day. See who\u2019s around at a glance and reach out with one click. Open source (Apache-2.0) + hosted.',
    indexOgTitle: 'Hiroba — Featherweight virtual office',
    indexOgDescription:
      'Not a meeting tool — a presence space. Idle CPU near 0%, light on memory. Voice stays off the server via P2P.',

    pricingDocTitle: 'Pricing — Hiroba',
    pricingMetaDescription:
      'Hiroba Hosted: $2/seat/month with a 30-day free trial that starts automatically. Enterprise on request.',
    pricingOgTitle: 'Pricing — Hiroba',
    pricingOgDescription:
      'Hosted from $2/seat/month. 30-day free trial \u2014 no card. Enterprise on request.',

    // Shared chrome
    navAriaLabel: 'Main',
    navFeatures: 'Features',
    navHow: 'How it works',
    navLight: 'Lightweight',
    navPricing: 'Pricing',
    navStart: 'Get started',
    langAriaLabel: 'Language',

    footerTag:
      'A featherweight virtual office for your team. Built open source (Apache-2.0) and also offered as a hosted, zero-ops option.',
    footerProduct: 'Product',
    footerDownload: 'Download',
    footerOpenSource: 'Open Source',
    footerSelfHostGuide: 'Self-host guide',
    footerProtocol: 'Protocol spec',
    footerContact: 'Contact',
    footerLegal1:
      'Source code is published under the Apache License 2.0. The \u201cHiroba\u201d name, logo, and other brand assets are not covered by Apache-2.0.',
    footerLegal2: '\u00a9 2026 Ludo Technologies',

    // Index — hero
    heroVert: 'Plaza',
    heroEyebrow: '\u201cGot a sec?\u201d still works remotely',
    heroTitle:
      '<span class="nowrap"><em>Featherweight</em></span><br /><span class="nowrap">virtual office.</span>',
    heroLede:
      'See who\u2019s around at a glance. Walk over to them or page someone with one click \u2014 it feels like tapping the desk next to you. Idle CPU near 0%, light on memory, light enough to forget it\u2019s running all day so everyone can stay on the floor. That\u2019s Hiroba.',
    heroProofCpu: 'Idle CPU near 0%',
    heroProofMem: 'Light on memory',
    heroProofOss: 'OSS \u00b7 Apache-2.0',
    mockAriaLabel:
      'Hiroba UI preview: member roster on the left, a furnished office floor on the right. Avatars walk between desks and lounges; voice ripples when people talk nearby.',
    mockMuted: 'Muted',
    mockNoCall: 'On call: none',

    // Index — problem
    problemSecNo: 'Why',
    problemTitle: 'The office sense of presence,<br />now remote.',
    problemLede:
      "Who's sitting nearby, whether you can speak up right now \u2014 things the office made obvious go invisible when remote. Getting them back doesn't take advanced meeting features; it takes a tool light enough to leave running all day.",

    // Index — values
    valuesSecNo: 'Features',
    valuesTitle: 'What Hiroba does.',
    valuesLede:
      'The minimum for a virtual office \u2014 presence, atmosphere, and voice. No video meetings, screen share, or recording by design; keep your existing meeting tool for that.',
    feature1Title: 'Take a seat on the floor',
    feature1Desc:
      'Take a seat on the floor in the morning. That\u2019s \u201ccoming in.\u201d Remote work gets a place of your own.',
    feature2Title: 'See who\u2019s where',
    feature2Desc:
      'A persistent roster shows who\u2019s here, away, on a call, or do-not-disturb \u2014 at a glance.',
    feature3Title: 'Walk the floor',
    feature3Desc:
      'Move around a top-down 2D floor. \u201cWalk over and say hi\u201d happens inside the screen.',
    feature4Title: 'Voice when you\u2019re close',
    feature4Desc:
      'Team rooms are group calls by default. Page anyone with one click, even across spaces.',
    feature5Title: 'Light enough to leave on',
    feature5Desc:
      'Idle CPU near 0%, light on memory. Eight hours open and your machine barely notices.',

    // Index — how
    howSecNo: 'How',
    howTitle: 'One floor: lobby plus team rooms.',
    howLede:
      'Each org gets one virtual floor with a shared lobby and small team rooms. No maze to learn.',
    floorOrgLabel: 'ORGANIZATION (your floor)',
    roomLobbyTitle: 'Lobby \u2014 shared open floor',
    roomLobbyHint: 'Voice fades in as you approach',
    roomATitle: 'Team A (~5 people)',
    roomAHint: 'Effectively a group call',
    roomBTitle: 'Team B (~5 people)',
    roomBHint: 'Hop in via tabs',
    pageArc: 'Paging = instant 1:1 across spaces. One click reaches them wherever they are',
    howPoint1Title: 'Lobby is for atmosphere',
    howPoint1Desc:
      'An open floor with proximity voice. Walk closer and audio fades in \u2014 where casual chats happen.',
    howPoint2Title: 'Teams are small voice circles',
    howPoint2Desc:
      'Team spaces (~5 people) stay connected like a group call. Switch tabs to join or leave the circle.',
    howPoint3Title: 'Paging is a tap on the shoulder',
    howPoint3Desc:
      'Pick someone from the roster to page \u2014 instant 1:1 voice across spaces. DND is respected. One click to hang up.',
    howPoint4Title: 'Voice never hits the server',
    howPoint4Desc:
      'Audio goes peer-to-peer over WebRTC; the server only relays position and presence. That\u2019s why it stays light.',

    // Index — numbers
    numbersSecNo: 'Light',
    numbersTitle: 'Why we optimize for lightness.',
    numbersLede:
      'A presence tool assumes eight hours of uptime. If it\u2019s heavy, people close it and you\u2019re left with an empty office. Lightness isn\u2019t marketing \u2014 it\u2019s what makes a virtual office work.',
    statCpuK: 'Idle CPU',
    statCpuNote: 'Near zero when still and silent',
    statMemV: 'Light',
    statMemK: 'Resident memory',
    statMemNote: 'Designed to stay small, even left running all day',
    statLatencyK: 'Voice latency',
    statLatencyNote: 'Direct P2P \u2014 feels natural',
    statBootV: 'Seconds<small> to boot</small>',
    statBootK: 'Startup time',
    statBootNote: 'Tauri client \u2014 smaller and lighter than Electron',
    statsDisclaimer:
      'Figures are design targets (NFR-01\u201305). We\u2019ll publish measured results as verification continues.',

    // Index — OSS
    ossSecNo: 'Open Source',
    ossTitle: 'It\u2019s open source.',
    ossLede:
      'Server and client are Apache-2.0. Read the code, verify the claims, run your own server.',
    ossTermComment: '# Single binary, no DB. That\u2019s all it takes to spin up a floor.',
    ossPoint1:
      '<b>Single binary, no DB</b>Rust server with no external deps. Self-host on a corporate LAN in minutes.',
    ossPoint2:
      '<b>Voice stays off the server</b>The server handles position and presence only. Audio is WebRTC peer-to-peer.',
    ossPoint3:
      '<b>Specs in the open</b>Wire protocol (PROTOCOL.md), requirements, and implementation status live in the repo.',
    ossPoint4:
      '<b>Self-host is first-class</b>Same codebase as hosted. Free, unlimited seats, no feature gating.',
    ossCta: 'View code on GitHub',

    // Index — start
    startSecNo: 'Start',
    startTitle: 'Two ways in.',
    startLede:
      'Hosted (we run it) or OSS self-host (you run it). Two distributions from one codebase.',
    wayRecommended: 'Recommended',
    hostedTag: 'Hosted',
    hostedTitle: 'Hosted',
    hostedDesc:
      'We operate the infra. Sign in with Google or GitHub, create an org — a 30-day trial starts automatically.',
    hostedLi1: 'Google & GitHub sign-in (SSO)',
    hostedLi2: 'Org creation, invite links, member management',
    hostedLi3: 'Stays connected on corporate networks',
    hostedLi4: 'Per-seat billing (see pricing)',
    hostedCta: 'Start 30-day free trial',
    ossWayTag: 'Open Source',
    ossWayTitle: 'OSS self-host',
    ossWayDesc:
      'Run the single-binary server yourself. DB-less, guest entry \u2014 works on an internal network in minutes.',
    ossWayLi1: 'Apache-2.0 (with patent grant)',
    ossWayLi2: 'Single binary, no external deps (no DB)',
    ossWayLi3: 'Guest / simple join; OAuth optional',
    ossWayLi4: 'Setup guide and protocol spec published',
    ossWayCta: 'View on GitHub',
    invitedCta: 'Download the app',
    downloadCtaMac: 'Download for macOS',
    downloadCtaWin: 'Download for Windows',
    downloadMacArm: 'macOS (Apple Silicon)',
    downloadMacIntel: 'macOS (Intel)',
    downloadMacUniversal: 'macOS',
    downloadWin: 'Windows',
    downloadMoreSep: ' \u00b7 ',
    downloadChooseMac: 'Choose your Mac version below',

    // Index — CTA band
    indexCtaTitle: 'Ready to try a virtual office<br />for your team?',
    indexCtaDesc:
      'Light enough to leave on without getting in the way. Self-host works today.',
    indexCtaPricing: 'See pricing',

    // Pricing — hero
    pricingEyebrow: 'Pricing',
    pricingHeroTitle: 'Easy to get started.',
    pricingHeroLede:
      'Sign in, create an org \u2014 a 30-day free trial starts automatically. No card required.',

    // Pricing — plans
    planHostedBadge: 'Recommended',
    planHostedTitle: 'Hosted Standard',
    planHostedFor: 'For teams that want a floor without running servers',
    planHostedPrice: '$2',
    planHostedPriceSmall: '/seat/month',
    planHostedNote:
      '30-day free trial starts automatically when you create an org. No card. Change seats monthly via Stripe.',
    planHostedLi1: 'Google & GitHub sign-in (SSO)',
    planHostedLi2: 'Org creation, invite links, member management',
    planHostedLi3: 'TURN included \u2014 stable on corporate networks',
    planHostedLi4: 'We handle infra and updates',
    planHostedLi5: 'Email support',
    planHostedCta: 'Start 30-day free trial',
    planEntTitle: 'Enterprise',
    planEntFor: 'For larger teams that need quotes, invoices, or a rollout plan',
    planEntPrice: 'Custom',
    planEntNote:
      'Everything in Standard, plus commercial terms that fit procurement.',
    planEntLi1: 'Everything in Hosted Standard',
    planEntLi2: 'Deployment support for your corporate network (by consultation)',
    planEntLi3: 'Invoice / custom billing on request',
    planEntLi4: 'Onboarding & rollout consultation',
    planEntLi5: 'Direct contact with the team',
    planEntCta: 'Contact us',
    selfHostStrip:
      '<strong>Prefer to run it yourself?</strong> The core is open source (Apache-2.0). You operate the server, TURN, and updates.',
    selfHostCta: 'Self-host guide',

    // Pricing — compare
    compareSecNo: 'Compare',
    compareTitle: 'Standard vs Enterprise',
    compareLede: 'Same product floor. The difference is how you buy and roll out.',
    cmpHosted: 'Hosted Standard',
    cmpEnt: 'Enterprise',
    cmpRowPresence: 'Presence, spaces, voice, paging',
    cmpAllIncluded: '\u2713 Included',
    cmpRowLogin: 'Sign-in',
    cmpLoginHosted: 'Google & GitHub SSO',
    cmpLoginEnt: 'Google & GitHub SSO',
    cmpRowOrg: 'Org & invites',
    cmpOrgHosted: 'Self-serve invite links',
    cmpOrgEnt: 'Self-serve + rollout help',
    cmpRowTurn: 'Corporate networks',
    cmpTurnHosted: '\u2713 TURN included',
    cmpRowTrial: 'Trial',
    cmpTrialHosted: '\u2713 30 days, starts automatically',
    cmpTrialEnt: 'Discussed per engagement',
    cmpRowBilling: 'Billing',
    cmpBillingHosted: 'Stripe \u00b7 per seat \u00b7 monthly',
    cmpBillingEnt: 'Invoice / custom terms',
    cmpRowSupport: 'Support',
    cmpSupportHosted: 'Email',
    cmpSupportEnt: 'Direct contact + onboarding',
    cmpRowCost: 'Price',
    cmpCostHosted: '$2/seat/month',
    cmpCostEnt: 'Custom',

    // Pricing — FAQ
    faqSecNo: 'FAQ',
    faqTitle: 'Common questions',
    faq1Q: 'How does the free trial work?',
    faq1A:
      'Download the app, sign in with Google or GitHub, and create an org. The 30-day trial starts automatically \u2014 no credit card. After the trial, Hosted Standard is $2/seat/month via Stripe.',
    faq2Q: 'Is it really that light?',
    faq2A:
      'Lightness is a core product value. Design targets call for near-0% idle CPU, a small resident footprint, and voice-only low bandwidth. The client is Tauri + Canvas 2D (not Electron); the server never relays audio (P2P).',
    faq3Q: 'When will you add video or screen share?',
    faq3A:
      'We won\u2019t. That\u2019s a design choice, not a backlog item. Meeting features trade off against always-on lightness, so Hiroba focuses on presence and voice. Use your usual meeting tool when it\u2019s meeting time.',
    faq4Q: 'Can I self-host instead?',
    faq4A:
      'Yes. The core is Apache-2.0 open source. You run the server (and TURN if needed) yourself \u2014 no seat fee. Hosted adds Google/GitHub sign-in, invites, managed infra, and the automatic trial. See the self-host guide on GitHub.',
    faq5Q: 'How does billing work on Standard?',
    faq5A:
      'Payments and invoices run through Stripe at $2/seat/month, based on registered org members. Seats can change monthly. Enterprise can arrange invoice or custom terms.',

    // Pricing — CTA band
    pricingCtaTitle: 'Start with one floor.',
    pricingCtaDesc: 'Sign in, create an org \u2014 your trial starts on its own.',

    // Demo (site.js)
    demoSpaceLobby: 'Lobby',
    demoSpaceDev: 'Dev',
    demoSpaceDesign: 'Design',
    demoMemberSelf: 'You',
    demoMemberRen: 'Ren Takahashi',
    demoMemberYuu: 'Yuu Aoki',
    demoMemberKan: 'Kan Sato',
    demoMemberHina: 'Hina Tanaka',
    demoMemberMiu: 'Miu Miura',
    demoStatusAway: 'Away',
    demoStatusDnd: 'DND',
    demoStatusCall: 'On call',
    demoPageChip: 'Page',

    // Index — download
    downloadSecNo: 'Download',
    downloadTitle: 'Download the desktop app.',
    downloadLede:
      'Builds for macOS and Windows, served from GitHub Releases. macOS builds are signed and notarized.',

    ctaDownloadHref,
  };

  const JA = {
    indexDocTitle: 'Hiroba — 超軽量バーチャルオフィス',
    indexMetaDescription:
      'Hirobaは、一日中つけっぱなしにできる超軽量のバーチャルオフィス。メンバーの在席がひと目で分かり、ワンクリックで声をかけられる。OSS（Apache-2.0）＋ ホスト型。',
    indexOgTitle: 'Hiroba — 超軽量バーチャルオフィス',
    indexOgDescription:
      '会議ツールではなく在席空間。アイドルCPUほぼ0%、省メモリ。音声はサーバーを通らないP2P。',

    pricingDocTitle: '料金 — Hiroba',
    pricingMetaDescription:
      'Hirobaホスト型：¥300／席／月。組織作成で30日トライアルが自動開始。Enterpriseはお問い合わせ。',
    pricingOgTitle: '料金 — Hiroba',
    pricingOgDescription:
      'ホスト型は¥300／席／月。30日無料トライアル（カード不要）。Enterpriseはお問い合わせ。',

    navAriaLabel: 'メイン',
    navFeatures: '特徴',
    navHow: '仕組み',
    navLight: '軽さ',
    navPricing: '料金',
    navStart: 'はじめる',
    langAriaLabel: '言語',

    footerTag:
      '忘れるほど軽い、チームのためのバーチャルオフィス。オープンソース（Apache-2.0）で開発され、運用不要のホスト型としても提供されます。',
    footerProduct: 'Product',
    footerDownload: 'ダウンロード',
    footerOpenSource: 'Open Source',
    footerSelfHostGuide: 'self-host ガイド',
    footerProtocol: 'プロトコル仕様',
    footerContact: 'お問い合わせ',
    footerLegal1:
      'ソースコードは Apache License 2.0 で公開されています。「Hiroba」の名称・ロゴ等のブランド素材は Apache-2.0 ライセンスの対象外です。',
    footerLegal2: '© 2026 Ludo Technologies',

    heroVert: '広場',
    heroEyebrow: '「ちょっといい？」が、リモートでも言える',
    heroTitle:
      '<span class="nowrap"><em>超軽量</em></span><br /><span class="nowrap">バーチャル</span><span class="nowrap">オフィス。</span>',
    heroLede:
      'チームの在席がひと目で分かり、相手に歩み寄るか、ワンクリックの呼びかけで、隣の席にいる感覚ですぐ話せる。そしてアイドル時CPUほぼ0%・省メモリ。一日中つけっぱなしでも忘れるほど軽いから、みんながフロアに“居続けられる”。それが Hiroba です。',
    heroProofCpu: 'アイドルCPU ほぼ0%',
    heroProofMem: 'メモリ常駐は控えめ',
    heroProofOss: 'OSS · Apache-2.0',
    mockAriaLabel:
      'Hirobaの画面イメージ。左に組織メンバーの一覧、右に家具の並ぶオフィスフロア。アバターがデスクやラウンジの間を歩き、近くで話すと声の波紋が広がる。',
    mockMuted: 'ミュート中',
    mockNoCall: '通話中: なし',

    problemSecNo: 'Why',
    problemTitle: 'オフィスにあった気配を、<br />リモートにも。',
    problemLede:
      '隣に誰がいて、いま話しかけていいか。出社していれば分かったことが、リモートでは見えなくなった。取り戻すのに必要なのは、高度な会議機能ではなく、一日中つなぎっぱなしにできる軽さです。',

    valuesSecNo: 'Features',
    valuesTitle: 'Hiroba でできること。',
    valuesLede:
      'バーチャルオフィスに必要な最小限、在席・気配・声だけを備えています。ビデオ会議・画面共有・録画は、軽さのためにあえて非搭載。会議はいまお使いのツールのままで。',
    feature1Title: 'フロアに席を取る',
    feature1Desc: '朝、フロアに席を取る。それが出社。リモートでも自分の「居場所」ができる。',
    feature2Title: '誰がどこにいるか見える',
    feature2Desc:
      '常設のメンバー一覧で、在席・離席・通話中・取り込み中が常にひと目で分かる。',
    feature3Title: 'フロアを歩き回れる',
    feature3Desc:
      '2Dの見下ろしフロアを移動できる。「ちょっと席まで行って話しかける」が画面の中でできる。',
    feature4Title: '近づけば、声がつながる',
    feature4Desc:
      'チームの部屋は入るだけでグループ通話。離れた相手にもワンクリックで「呼びかけ」。',
    feature5Title: 'つけっぱなしでも軽い',
    feature5Desc:
      'アイドル時CPUほぼ0%・省メモリ。8時間常駐させても、PCの邪魔をしない。',

    howSecNo: 'How',
    howTitle: 'オフィスの中身は、ロビーとチームの部屋。',
    howLede:
      '組織にひとつの仮想フロア。中に全員のロビーと、チームごとの小部屋があるだけ。迷う構造はありません。',
    floorOrgLabel: 'ORGANIZATION（組織のフロア）',
    roomLobbyTitle: 'ロビー — 組織共通のオープンフロア',
    roomLobbyHint: '近づくと声がフェードイン',
    roomATitle: 'チーム A（〜5人）',
    roomAHint: '実質グループ通話',
    roomBTitle: 'チーム B（〜5人）',
    roomBHint: 'タブで出入り',
    pageArc: '呼びかけ＝スペースを跨ぐ即時1:1。相手がどこに居ても、ワンクリックで声が届く',
    howPoint1Title: 'ロビーは「気配」の場所',
    howPoint1Desc:
      '近接音声のオープンフロア。歩み寄ると声がフェードインする。雑談やすれ違いが生まれる場所です。',
    howPoint2Title: 'チームは「小さな声の輪」',
    howPoint2Desc:
      '5人前後のチームスペースは全員が常時つながる実質グループ通話。タブひとつで輪に出入りできます。',
    howPoint3Title: '呼びかけは「肩を叩く」',
    howPoint3Desc:
      '一覧から相手を選んで呼びかけると、スペースを跨いで即時1:1の声がつながる。取り込み中（DND）はきちんと遮断。ワンクリックで切断。',
    howPoint4Title: '声はサーバーを通らない',
    howPoint4Desc:
      '音声はWebRTCのP2Pメッシュで直接つながり、サーバーは位置と在席の中継だけ。だから軽く、運用も単純です。',

    numbersSecNo: 'Light',
    numbersTitle: 'なぜ、ここまで軽くするのか。',
    numbersLede:
      '在席ツールは8時間つけっぱなしが前提。動作が重ければ各自が閉じてしまい、誰もいないオフィスだけが残ります。軽さは売り文句ではなく、バーチャルオフィスが“オフィスとして機能する”ための前提条件です。',
    statCpuK: 'アイドル時CPU',
    statCpuNote: '移動・発話なしのとき、ほぼゼロ',
    statMemV: '軽量',
    statMemK: '常駐メモリ',
    statMemNote: '一日中つけても常駐を小さく保つ設計',
    statLatencyK: '音声遅延',
    statLatencyNote: 'P2P直結。体感で違和感のない範囲',
    statBootV: '数秒<small>で起動</small>',
    statBootK: '起動時間',
    statBootNote: 'Tauri製。Electronより小さく軽く',
    statsDisclaimer:
      '数値は設計目標値（要件定義 NFR-01〜05）。実測の継続検証とともに更新します。',

    ossSecNo: 'Open Source',
    ossTitle: 'オープンソースです。',
    ossLede:
      'サーバーもクライアントも、すべて Apache-2.0 で公開。中身を読んで確かめられて、自分のサーバーでも動かせます。',
    ossTermComment: '# 単一バイナリ・DB不要。これだけでフロアが立ち上がります',
    ossPoint1:
      '<b>単一バイナリ・DBレス</b>Rust製サーバーは外部依存なし。社内ネットワークでも数分で self-host できます。',
    ossPoint2:
      '<b>音声はサーバーを通らない</b>サーバーが扱うのは位置と在席の制御データだけ。音声はWebRTCのP2Pで直接つながります。',
    ossPoint3:
      '<b>仕様まで公開</b>ワイヤープロトコル（PROTOCOL.md）や要件・実装状況のドキュメントも、すべてリポジトリにあります。',
    ossPoint4:
      '<b>self-host は一級市民</b>ホスト型と同じコードベース。無料・席数無制限で、機能の出し惜しみはありません。',
    ossCta: 'GitHub でコードを見る',

    startSecNo: 'Start',
    startTitle: '始め方は、ふたつ。',
    startLede:
      '運用おまかせのホスト型と、自前で立てるOSS。同じコードベースから生まれる二つの配布です。',
    wayRecommended: 'おすすめ',
    hostedTag: 'Hosted',
    hostedTitle: 'ホスト型',
    hostedDesc:
      'インフラはこちらで運用。Google または GitHub でサインインし、組織を作ると30日トライアルが自動で始まります。',
    hostedLi1: 'Google / GitHub サインイン（SSO）',
    hostedLi2: '組織の作成・招待リンク・メンバー管理',
    hostedLi3: '企業ネットワークでも、安定してつながる',
    hostedLi4: 'シート課金（料金ページ参照）',
    hostedCta: '30日無料トライアルを始める',
    ossWayTag: 'Open Source',
    ossWayTitle: 'OSS self-host',
    ossWayDesc:
      '単一バイナリのサーバーを自前で起動。DBレス・ゲスト入室で、社内ネットワークでも数分で動きます。',
    ossWayLi1: 'Apache-2.0（特許条項つき）',
    ossWayLi2: '単一バイナリ・外部依存なし（DB不要）',
    ossWayLi3: 'ゲスト/簡易入室、OAuthは任意で有効化',
    ossWayLi4: 'セットアップ手順・プロトコル仕様を公開',
    ossWayCta: 'GitHubで見る',
    invitedCta: 'アプリをダウンロード',
    downloadCtaMac: 'macOS 版をダウンロード',
    downloadCtaWin: 'Windows 版をダウンロード',
    downloadMacArm: 'macOS（Apple Silicon）',
    downloadMacIntel: 'macOS（Intel）',
    downloadMacUniversal: 'macOS',
    downloadWin: 'Windows',
    downloadMoreSep: ' · ',
    downloadChooseMac: 'お使いの Mac に合わせて選んでください',

    indexCtaTitle: 'チームのバーチャルオフィス、<br />試してみませんか。',
    indexCtaDesc:
      'つけっぱなしでも邪魔にならない軽さです。self-host なら今日から動かせます。',
    indexCtaPricing: '料金を見る',

    pricingEyebrow: 'Pricing',
    pricingHeroTitle: '簡単に始められます！',
    pricingHeroLede:
      'サインインして組織を作ると、30日間の無料トライアルが自動で始まります。カード登録は不要です。',

    planHostedBadge: 'おすすめ',
    planHostedTitle: 'ホスト型 Standard',
    planHostedFor: 'サーバ運用なしでフロアを持ちたいチームに',
    planHostedPrice: '¥300',
    planHostedPriceSmall: '／席／月（税別）',
    planHostedNote:
      '組織を作った瞬間から30日トライアルが自動開始。カード不要。席数は Stripe で月単位に変更可能。',
    planHostedLi1: 'Google / GitHub サインイン（SSO）',
    planHostedLi2: '組織作成・招待リンク・メンバー管理',
    planHostedLi3: 'TURN 込み — 企業ネットワークでも安定',
    planHostedLi4: 'インフラ運用・アップデートはおまかせ',
    planHostedLi5: 'メールサポート',
    planHostedCta: '30日無料トライアルを始める',
    planEntTitle: 'Enterprise',
    planEntFor: '見積・請求書・導入計画が必要な規模のチームに',
    planEntPrice: 'カスタム',
    planEntNote:
      'Standard のすべてに加え、調達に合わせた契約条件を相談できます。',
    planEntLi1: 'ホスト型 Standard のすべて',
    planEntLi2: '貴社のネットワーク環境での導入支援サービス（要相談）',
    planEntLi3: '請求書払い・個別請求（要相談）',
    planEntLi4: 'オンボーディング・導入相談',
    planEntLi5: 'チームへの直接コンタクト',
    planEntCta: 'お問い合わせ',
    selfHostStrip:
      '<strong>自分で動かしたい？</strong> コアはオープンソース（Apache-2.0）。サーバ・TURN・更新の運用は自前です。',
    selfHostCta: 'self-host ガイド',

    compareSecNo: 'Compare',
    compareTitle: 'Standard と Enterprise',
    compareLede: 'フロアの体験は同じ。違うのは買い方と導入の進め方です。',
    cmpHosted: 'ホスト型 Standard',
    cmpEnt: 'Enterprise',
    cmpRowPresence: '在席・スペース・声・呼びかけ',
    cmpAllIncluded: '✓ 含む',
    cmpRowLogin: 'サインイン',
    cmpLoginHosted: 'Google / GitHub SSO',
    cmpLoginEnt: 'Google / GitHub SSO',
    cmpRowOrg: '組織・招待',
    cmpOrgHosted: 'セルフサーブの招待リンク',
    cmpOrgEnt: 'セルフサーブ ＋ 導入支援',
    cmpRowTurn: '企業ネットワーク',
    cmpTurnHosted: '✓ TURN 込み',
    cmpRowTrial: 'トライアル',
    cmpTrialHosted: '✓ 30日・自動開始',
    cmpTrialEnt: '案件ごとに相談',
    cmpRowBilling: '請求',
    cmpBillingHosted: 'Stripe · シート · 月次',
    cmpBillingEnt: '請求書 / 個別条件',
    cmpRowSupport: 'サポート',
    cmpSupportHosted: 'メール',
    cmpSupportEnt: '直接コンタクト ＋ 導入支援',
    cmpRowCost: '価格',
    cmpCostHosted: '¥300／席／月（税別）',
    cmpCostEnt: 'カスタム',

    faqSecNo: 'FAQ',
    faqTitle: 'よくある質問',
    faq1Q: '無料トライアルはどう始まりますか？',
    faq1A:
      'アプリをダウンロードし、Google または GitHub でサインインして組織を作成してください。30日トライアルは自動で始まり、クレジットカードは不要です。終了後はホスト型 Standard が ¥300／席／月（税別・Stripe）です。',
    faq2Q: '本当に軽いんですか？',
    faq2A:
      '軽さを製品の中核価値として設計しています。アイドル時CPUほぼ0%・小さな常駐フットプリント・音声のみの低帯域を目標に、クライアントは Electron ではなく Tauri＋Canvas 2D、サーバーは音声を中継しない P2P 構成です。',
    faq3Q: 'ビデオ通話や画面共有はいつ追加されますか？',
    faq3A:
      '追加しません。未実装ではなく設計判断です。会議機能は常駐の軽さと引き換えになるため、Hiroba は在席・気配・声に専念します。会議になったら、いつもの会議ツールをご利用ください。',
    faq4Q: 'self-host はできますか？',
    faq4A:
      'できます。コアは Apache-2.0 のオープンソースです。サーバ（必要なら TURN）は自前運用で、席課金はありません。ホスト型は Google/GitHub サインイン・招待・マネージド基盤・自動トライアルが付きます。詳しくは GitHub の self-host ガイドへ。',
    faq5Q: 'Standard の支払い・請求はどうなりますか？',
    faq5A:
      'Stripe で ¥300／席／月（税別）。席数は組織の登録メンバー数に基づき、月単位で変更できます。Enterprise は請求書払いなど個別条件を相談できます。',

    pricingCtaTitle: 'まずは、フロアをひとつ。',
    pricingCtaDesc: 'サインインして組織を作るだけ。トライアルは自動で始まります。',

    demoSpaceLobby: 'ロビー',
    demoSpaceDev: '開発',
    demoSpaceDesign: 'デザイン',
    demoMemberSelf: '自分',
    demoMemberRen: '高橋 蓮',
    demoMemberYuu: '青木 悠',
    demoMemberKan: '佐藤 環',
    demoMemberHina: '田中 陽菜',
    demoMemberMiu: '三浦 美羽',
    demoStatusAway: '離席',
    demoStatusDnd: 'DND',
    demoStatusCall: '通話中',
    demoPageChip: '呼びかけ',

    // Index — download
    downloadSecNo: 'Download',
    downloadTitle:
      '<span class="nowrap">デスクトップアプリを</span><span class="nowrap">ダウンロード。</span>',
    downloadLede:
      'macOS / Windows 向けのビルドを GitHub Releases で配布しています。macOS 版は署名・公証済みです。',

    ctaDownloadHref,
  };

  const t = locale === 'ja' ? JA : EN;

  function text(key) {
    const v = t[key];
    return typeof v === 'string' ? v : null;
  }

  function applyStaticI18n() {
    document.documentElement.lang = locale;

    const page = document.body.dataset.page;
    if (page === 'index') {
      document.title = t.indexDocTitle;
      setMeta('description', t.indexMetaDescription);
      setMetaProperty('og:title', t.indexOgTitle);
      setMetaProperty('og:description', t.indexOgDescription);
    } else if (page === 'pricing') {
      document.title = t.pricingDocTitle;
      setMeta('description', t.pricingMetaDescription);
      setMetaProperty('og:title', t.pricingOgTitle);
      setMetaProperty('og:description', t.pricingOgDescription);
    }

    for (const el of document.querySelectorAll('[data-i18n]')) {
      const v = text(el.dataset.i18n);
      if (v !== null) el.textContent = v;
    }
    for (const el of document.querySelectorAll('[data-i18n-html]')) {
      const v = text(el.dataset.i18nHtml);
      if (v !== null) el.innerHTML = v;
    }
    for (const el of document.querySelectorAll('[data-i18n-href]')) {
      if (el.hasAttribute('data-download')) continue;
      const v = text(el.dataset.i18nHref);
      if (v !== null) el.setAttribute('href', v);
    }
    for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
      const v = text(el.dataset.i18nPlaceholder);
      if (v !== null) el.setAttribute('placeholder', v);
    }
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
      const v = text(el.dataset.i18nTitle);
      if (v !== null) el.title = v;
    }
    for (const el of document.querySelectorAll('[data-i18n-arialabel]')) {
      const v = text(el.dataset.i18nArialabel);
      if (v !== null) el.setAttribute('aria-label', v);
    }
    for (const el of document.querySelectorAll('[data-i18n-meta]')) {
      const v = text(el.dataset.i18nMeta);
      if (v !== null) el.setAttribute('content', v);
    }

    if (langParam === 'ja' || langParam === 'en') {
      for (const el of document.querySelectorAll('a[href]')) {
        const href = el.getAttribute('href');
        if (!href || /^(https?:|mailto:|#)/.test(href) || href.includes('lang=')) continue;
        const url = new URL(href, window.location.href);
        url.searchParams.set('lang', langParam);
        el.setAttribute('href', url.pathname + url.search + url.hash);
      }
    }
  }

  function setMeta(name, content) {
    const el = document.querySelector(`meta[name="${name}"]`);
    if (el) el.setAttribute('content', content);
  }

  function setMetaProperty(prop, content) {
    const el = document.querySelector(`meta[property="${prop}"]`);
    if (el) el.setAttribute('content', content);
  }

  function initLangSwitch() {
    const sw = document.querySelector('.lang-switch');
    if (!sw) return;
    sw.setAttribute('aria-label', t.langAriaLabel);
    for (const a of sw.querySelectorAll('[data-lang]')) {
      const target = a.dataset.lang;
      const url = new URL(window.location.href);
      url.searchParams.set('lang', target);
      a.href = url.pathname + url.search + url.hash;
      a.classList.toggle('active', target === locale);
      if (target === locale) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    }
  }

  applyStaticI18n();
  initLangSwitch();

  window.HirobaSiteI18n = { locale, t, applyStaticI18n };
})();