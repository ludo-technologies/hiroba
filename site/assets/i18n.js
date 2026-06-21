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

  const mailEarlyAccess =
    locale === 'ja'
      ? 'mailto:contact@ludo-tech.org?subject=%5BHiroba%5D%20%E6%97%A9%E6%9C%9F%E3%82%A2%E3%82%AF%E3%82%BB%E3%82%B9%E5%B8%8C%E6%9C%9B&body=%E7%B5%84%E7%B9%94%E5%90%8D%EF%BC%9A%0A%E4%BA%BA%E6%95%B0%EF%BC%9A%0A%E3%81%B2%E3%81%A8%E3%81%93%E3%81%A8%EF%BC%9A'
      : 'mailto:contact@ludo-tech.org?subject=%5BHiroba%5D%20Early%20access%20request&body=Organization%3A%0AHeadcount%3A%0ANotes%3A%0A';

  const EN = {
    // Shared <head>
    indexDocTitle: 'Hiroba — Featherweight virtual office',
    indexMetaDescription:
      'Hiroba is a featherweight virtual office you can leave running all day. See who\u2019s around at a glance and reach out with one click. Open source (Apache-2.0) + hosted.',
    indexOgTitle: 'Hiroba — Featherweight virtual office',
    indexOgDescription:
      'Not a meeting tool — a presence space. Idle CPU near 0%, tens of MB of RAM. Voice stays off the server via P2P.',

    pricingDocTitle: 'Pricing — Hiroba',
    pricingMetaDescription:
      'Hiroba pricing. OSS self-host is free and unlimited. Hosted is simple per-seat billing (early-access pricing).',
    pricingOgTitle: 'Pricing — Hiroba',
    pricingOgDescription: 'Self-host is free. Hosted is simple per-seat billing.',

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
      'See who\u2019s around at a glance. Walk your avatar over or page someone with one click \u2014 it feels like tapping the desk next to you. Idle CPU near 0%, tens of MB of RAM, light enough to forget it\u2019s running all day so everyone can stay on the floor. That\u2019s Hiroba.',
    ctaCreateOrg: 'Create an organization',
    ctaSelfHost: 'Start with self-host',
    heroProofCpu: 'Idle CPU near 0%',
    heroProofMem: 'Tens of MB RAM',
    heroProofOss: 'OSS \u00b7 Apache-2.0',
    mockAriaLabel:
      'Hiroba UI preview: member roster on the left, 2D space on the right. Avatars wander; voice links when they get close.',
    mockMuted: 'Muted',
    mockNoCall: 'On call: none',
    mockCaption:
      '\u2191 Live demo. Click tabs to switch spaces \u2014 same as the product: plain Canvas 2D.',

    // Index — problem
    problemSecNo: 'Why',
    problemTitle: 'Virtual offices got<br />too heavy.',
    problemLede:
      'Video, screen share, recording, integrations \u2014 the more features pile on, the harder it is to leave running. A presence tool needs atmosphere and lightness, not advanced meeting features.',
    problemThemTitle: 'Traditional all-in-one tools',
    problemThem1: 'Traffic (even voice-first) <b>~1 GB/day</b>',
    problemThem2: 'Heavy video & screen share <b>3\u20135 GB/day</b>',
    problemThem3: 'Idle memory <b>hundreds of MB+</b>',
    problemThem4: 'Positioning <b>meeting-tool replacement</b>',
    problemUsTitle: 'Hiroba',
    problemUs1: 'Traffic <b>voice only, low bandwidth</b>',
    problemUs2: 'Idle CPU <b>near 0%</b>',
    problemUs3: 'Idle memory <b>tens of MB</b>',
    problemUs4: 'Positioning <b>always-on presence tool</b>',

    // Index — values
    valuesSecNo: 'Features',
    valuesTitle: 'What Hiroba does.',
    valuesLede:
      'The minimum for a virtual office \u2014 presence, atmosphere, and voice. No video meetings, screen share, or recording by design; keep your existing meeting tool for that.',
    feature1Title: 'Show up as an avatar',
    feature1Desc:
      'Drop your avatar on the floor in the morning. That\u2019s \u201ccoming in.\u201d Remote work gets a place to be.',
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
      'Idle CPU near 0%, tens of MB of RAM. Eight hours open and your machine barely notices.',

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
    statMemV: 'Tens<small>MB</small>',
    statMemK: 'Resident memory',
    statMemNote: 'An order of magnitude below typical browser SPAs',
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
    hostedTag: 'Hosted',
    hostedTitle: 'Hosted',
    hostedDesc:
      'We operate the infra. Sign in, create an org, share invite links. Non-technical teams can start fast.',
    hostedLi1: 'OAuth sign-in (Google / GitHub, etc.)',
    hostedLi2: 'Org creation, invite links, member management',
    hostedLi3: 'TURN included for \u201calmost always connects\u201d reachability',
    hostedLi4: 'Per-seat billing (see pricing)',
    hostedCta: 'Join early access',
    ossWayTag: 'Open Source',
    ossWayTitle: 'OSS self-host',
    ossWayDesc:
      'Run the single-binary server yourself. DB-less, guest entry \u2014 works on an internal network in minutes.',
    ossWayLi1: 'Apache-2.0 (with patent grant)',
    ossWayLi2: 'Single binary, no external deps (no DB)',
    ossWayLi3: 'Guest / simple join; OAuth optional',
    ossWayLi4: 'Setup guide and protocol spec published',
    ossWayCta: 'View on GitHub',
    invitedTitle: 'Got an invite link?',
    invitedDesc:
      'Install the desktop app and open the invite link to join your org\u2019s floor. Sign in with your Google or GitHub account.',
    invitedCta: 'Download the app',

    // Index — CTA band
    indexCtaTitle: 'Ready to try a virtual office<br />for your team?',
    indexCtaDesc:
      'Light enough to leave on without getting in the way. Self-host works today.',
    indexCtaPricing: 'See pricing',

    // Pricing — hero
    pricingEyebrow: 'Pricing',
    pricingHeroTitle: 'Pricing stays light too.',
    pricingHeroLede:
      'Self-host is free forever. Hosted is simple per-seat billing.',
    pricingNotice:
      'Hosted Standard is billed per seat via Stripe at <strong>\u00a5300/seat/month</strong> (excl. tax).',

    // Pricing — plans
    planSelfTitle: 'Self-host',
    planSelfFor: 'For technical teams who want to run it themselves',
    planSelfPriceSmall: 'free forever',
    planSelfNote: 'Apache-2.0 open source. No seat or org limits.',
    planSelfLi1: 'Full feature set',
    planSelfLi2: 'Single binary, DB-less startup',
    planSelfLi3: 'Guest / simple join (OAuth optional)',
    planSelfLi4: 'You operate server & TURN',
    planSelfLi5: 'Community-based support',
    planSelfCta: 'Start on GitHub',
    planHostedBadge: 'Recommended',
    planHostedTitle: 'Hosted Standard',
    planHostedFor: 'For teams who want to start without ops',
    planHostedPriceSmall: '/seat/month (launch price, excl. tax)',
    planHostedNote:
      'Stripe billing. 30-day free trial (no card). Change seats monthly.',
    planHostedLi1: 'OAuth sign-in (Google / GitHub, etc.)',
    planHostedLi2: 'Org creation, invite links, member management',
    planHostedLi3: 'TURN included (\u201calmost always connects\u201d, even on corp networks)',
    planHostedLi4: 'We handle infra and updates',
    planHostedLi5: 'Email support',
    planHostedCta: 'Join early access',

    // Pricing — compare
    compareSecNo: 'Compare',
    compareTitle: 'Hosted vs self-host',
    compareLede: 'Same codebase. The difference is who runs it.',
    cmpHosted: 'Hosted',
    cmpSelfHost: 'OSS self-host',
    cmpRowPresence: 'Presence, spaces, voice circles, paging',
    cmpAllIncluded: '\u2713 All included',
    cmpRowLogin: 'Sign-in',
    cmpLoginHosted: 'OAuth (Google / GitHub, etc.)',
    cmpLoginSelf: 'Guest / simple join (OAuth optional)',
    cmpRowOrg: 'Joining an org',
    cmpOrgHosted: 'Invite links (issued by admins)',
    cmpOrgSelf: 'Share server URL, etc. \u2014 flexible',
    cmpRowTurn: 'NAT traversal (TURN)',
    cmpTurnHosted: '\u2713 Included. \u201cAlmost always connects\u201d',
    cmpTurnSelf: '\u25b3 Public STUN by default; run coturn if needed',
    cmpRowPersist: 'Data persistence',
    cmpPersistHosted: '\u2713 Orgs, members, invites stored',
    cmpPersistSelf: '\u25b3 DB-less OK (config / env vars)',
    cmpRowOps: 'Server ops & updates',
    cmpOpsHosted: '\u2713 Handled for you',
    cmpOpsSelf: 'You (single binary makes it simple)',
    cmpRowCost: 'Cost',
    cmpCostHosted: '\u00a5300/seat/month (excl. tax)',
    cmpCostSelf: 'Free (infra cost only)',

    // Pricing — FAQ
    faqSecNo: 'FAQ',
    faqTitle: 'Common questions',
    faq1Q: 'Is it really that light?',
    faq1A:
      'Lightness is a core product value. Design targets (NFR) call for near-0% idle CPU, tens of MB resident memory, and voice-only low bandwidth. The client is Tauri + Canvas 2D (not Electron); the server never relays audio (P2P). Numbers are targets \u2014 we\u2019ll publish measurements as we verify.',
    faq2Q: 'When will you add video or screen share?',
    faq2A:
      'We won\u2019t. That\u2019s a design choice, not a backlog item. Meeting features trade off against always-on lightness, so Hiroba focuses on presence and voice \u2014 \u201cbefore the meeting.\u201d When it\u2019s meeting time, use your usual tool.',
    faq3Q: 'Where does audio go?',
    faq3A:
      'Usually direct P2P between participants \u2014 not through the server. The server only handles position, presence, and signaling. If P2P can\u2019t establish (NAT), hosted uses encrypted TURN relay.',
    faq4Q: 'Feature gap between self-host and hosted?',
    faq4A:
      'Core experience (presence, spaces, voice circles, paging) is identical. Hosted bundles OAuth, org management, invites, TURN, and persistence with zero config. Self-host enables and operates those yourself. Both build from the same codebase via profile flags.',
    faq5Q: 'How does billing work?',
    faq5A:
      'Payments and invoices run through Stripe at \u00a5300/seat/month (excl. tax), based on registered org members.',

    // Pricing — CTA band
    pricingCtaTitle: 'Start with one floor.',
    pricingCtaDesc: 'Hosted: create an org. Self-host: run it today.',

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

    mailEarlyAccess,
  };

  const JA = {
    indexDocTitle: 'Hiroba — 超軽量バーチャルオフィス',
    indexMetaDescription:
      'Hirobaは、一日中つけっぱなしにできる超軽量のバーチャルオフィス。メンバーの在席がひと目で分かり、ワンクリックで声をかけられる。OSS（Apache-2.0）＋ ホスト型。',
    indexOgTitle: 'Hiroba — 超軽量バーチャルオフィス',
    indexOgDescription:
      '会議ツールではなく在席空間。アイドルCPUほぼ0%、メモリ数十MB。音声はサーバーを通らないP2P。',

    pricingDocTitle: '料金 — Hiroba',
    pricingMetaDescription:
      'Hirobaの料金。OSS self-hostは無料・無制限。ホスト型はシンプルなシート課金（早期アクセス価格）。',
    pricingOgTitle: '料金 — Hiroba',
    pricingOgDescription: 'self-hostは無料。ホスト型はシンプルなシート課金。',

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
      '<span class="nowrap"><em>超軽量</em></span><br /><span class="nowrap">バーチャルオフィス。</span>',
    heroLede:
      'チームの在席がひと目で分かり、アバターを近づけるか、ワンクリックの呼びかけで、隣の席にいる感覚ですぐ話せる。そしてアイドル時CPUほぼ0%・メモリ数十MB——一日中つけっぱなしでも忘れるほど軽いから、みんながフロアに“居続けられる”。それが Hiroba です。',
    ctaCreateOrg: '組織をつくる',
    ctaSelfHost: 'self-host で始める',
    heroProofCpu: 'アイドルCPU ほぼ0%',
    heroProofMem: 'メモリ 数十MB',
    heroProofOss: 'OSS · Apache-2.0',
    mockAriaLabel:
      'Hirobaの画面イメージ。左に組織メンバーの一覧、右に選択中スペースの2D空間。アバターが歩き回り、近づくと声がつながる。',
    mockMuted: 'ミュート中',
    mockNoCall: '通話中: なし',
    mockCaption:
      '↑ 動いています。タブを押すとスペースが切り替わります — 製品と同じ、ただの Canvas 2D。',

    problemSecNo: 'Why',
    problemTitle: 'バーチャルオフィスは、<br />重くなりすぎた。',
    problemLede:
      'ビデオ・画面共有・録画・連携——便利になるほど、常駐させるには重いツールになっていく。一日中つなぎっぱなしにする「在席ツール」に必要なのは、高度な会議機能ではなく、気配と軽さです。',
    problemThemTitle: '従来の多機能型ツール',
    problemThem1: '通信量（音声中心でも）<b>約1GB/日</b>',
    problemThem2: 'ビデオ・画面共有を多用すると<b>3〜5GB/日</b>',
    problemThem3: '常駐時のメモリ<b>数百MB〜</b>',
    problemThem4: '位置づけ<b>会議ツールの代替</b>',
    problemUsTitle: 'Hiroba',
    problemUs1: '通信量<b>音声のみ・低帯域</b>',
    problemUs2: 'アイドル時CPU<b>ほぼ0%</b>',
    problemUs3: '常駐時のメモリ<b>数十MB台</b>',
    problemUs4: '位置づけ<b>常駐前提の在席ツール</b>',

    valuesSecNo: 'Features',
    valuesTitle: 'Hiroba でできること。',
    valuesLede:
      'バーチャルオフィスに必要な最小限——在席・気配・声だけを備えています。ビデオ会議・画面共有・録画は、軽さのためにあえて非搭載。会議はいまお使いのツールのままで。',
    feature1Title: 'アバターで出社する',
    feature1Desc: '朝、フロアに自分のアバターを置く。それが出社。リモートでも「居場所」ができる。',
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
      'アイドル時CPUほぼ0%・メモリ数十MB。8時間常駐させても、PCの邪魔をしない。',

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
    statMemV: '数十<small>MB</small>',
    statMemK: '常駐メモリ',
    statMemNote: 'ブラウザSPA比で一桁以上の削減',
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
    hostedTag: 'Hosted',
    hostedTitle: 'ホスト型',
    hostedDesc:
      'インフラはこちらで運用。ログインして組織をつくり、招待リンクを配るだけ。非技術チームでもすぐ使えます。',
    hostedLi1: 'OAuthログイン（Google / GitHub など）',
    hostedLi2: '組織の作成・招待リンク・メンバー管理',
    hostedLi3: 'TURN込みで「ほぼ必ず繋がる」接続性',
    hostedLi4: 'シート課金（料金ページ参照）',
    hostedCta: '早期アクセスに登録',
    ossWayTag: 'Open Source',
    ossWayTitle: 'OSS self-host',
    ossWayDesc:
      '単一バイナリのサーバーを自前で起動。DBレス・ゲスト入室で、社内ネットワークでも数分で動きます。',
    ossWayLi1: 'Apache-2.0（特許条項つき）',
    ossWayLi2: '単一バイナリ・外部依存なし（DB不要）',
    ossWayLi3: 'ゲスト/簡易入室、OAuthは任意で有効化',
    ossWayLi4: 'セットアップ手順・プロトコル仕様を公開',
    ossWayCta: 'GitHubで見る',
    invitedTitle: '招待リンクを受け取った方へ',
    invitedDesc:
      'デスクトップアプリをインストールして、届いた招待リンクを開くだけで組織のフロアに参加できます。アカウントはお使いのGoogle / GitHubアカウントでそのまま。',
    invitedCta: 'アプリをダウンロード',

    indexCtaTitle: 'チームのバーチャルオフィス、<br />試してみませんか。',
    indexCtaDesc:
      'つけっぱなしでも邪魔にならない軽さです。self-host なら今日から動かせます。',
    indexCtaPricing: '料金を見る',

    pricingEyebrow: 'Pricing',
    pricingHeroTitle: '料金も、軽く。',
    pricingHeroLede:
      'self-host はずっと無料。ホスト型は、席の数だけのシンプルなシート課金です。',
    pricingNotice:
      'ホスト型 Standard は Stripe のシート課金で提供します。価格は<strong>¥300／席／月</strong>（税別）です。',

    planSelfTitle: 'Self-host',
    planSelfFor: '自分たちで運用したい技術チームに',
    planSelfPriceSmall: '　ずっと無料',
    planSelfNote: 'Apache-2.0 のオープンソース。席数・組織数の制限なし。',
    planSelfLi1: '機能はすべて利用可能',
    planSelfLi2: '単一バイナリ・DBレスで起動',
    planSelfLi3: 'ゲスト/簡易入室（OAuthは任意で有効化）',
    planSelfLi4: 'サーバー・TURNの運用は自前',
    planSelfLi5: 'サポートはコミュニティベース',
    planSelfCta: 'GitHubで始める',
    planHostedBadge: 'おすすめ',
    planHostedTitle: 'ホスト型 Standard',
    planHostedFor: '運用せずに、すぐ使い始めたいチームに',
    planHostedPriceSmall: '／席／月（ローンチ価格・税別）',
    planHostedNote:
      'Stripe 決済。30日間の無料トライアル（カード不要）。席数は月単位で変更可能。',
    planHostedLi1: 'OAuthログイン（Google / GitHub など）',
    planHostedLi2: '組織の作成・招待リンク・メンバー管理',
    planHostedLi3: 'TURN込みの接続性（企業NW内でも“ほぼ必ず繋がる”）',
    planHostedLi4: 'インフラ運用・アップデートはおまかせ',
    planHostedLi5: 'メールサポート',
    planHostedCta: '早期アクセスに登録',

    compareSecNo: 'Compare',
    compareTitle: 'ホスト型と self-host の違い',
    compareLede: 'どちらも同じコードベース。違うのは「誰が運用するか」です。',
    cmpHosted: 'ホスト型',
    cmpSelfHost: 'OSS self-host',
    cmpRowPresence: '在席・スペース・声の輪・呼びかけ',
    cmpAllIncluded: '✓ すべて利用可',
    cmpRowLogin: 'ログイン',
    cmpLoginHosted: 'OAuth（Google / GitHub など）',
    cmpLoginSelf: 'ゲスト/簡易入室（OAuthは任意）',
    cmpRowOrg: '組織への参加',
    cmpOrgHosted: '招待リンク（管理者が発行）',
    cmpOrgSelf: 'サーバーURLの共有 など自由',
    cmpRowTurn: 'NAT越え（TURN）',
    cmpTurnHosted: '✓ 込み。“ほぼ必ず繋がる”を保証',
    cmpTurnSelf: '△ 公開STUNが既定。必要なら自前でcoturn',
    cmpRowPersist: 'データの永続化',
    cmpPersistHosted: '✓ 組織・メンバー・招待を保存',
    cmpPersistSelf: '△ DBレス可（設定ファイル/環境変数）',
    cmpRowOps: 'サーバー運用・アップデート',
    cmpOpsHosted: '✓ おまかせ',
    cmpOpsSelf: '自前（単一バイナリで簡単）',
    cmpRowCost: '費用',
    cmpCostHosted: '¥300／席／月（税別）',
    cmpCostSelf: '無料（インフラ実費のみ）',

    faqSecNo: 'FAQ',
    faqTitle: 'よくある質問',
    faq1Q: '本当に軽いんですか？',
    faq1A:
      '軽さを製品の中核価値として設計しています。アイドル時CPUほぼ0%・常駐メモリ数十MB・音声のみの低帯域を設計目標（NFR）に置き、クライアントはElectronではなくTauri＋Canvas 2D、サーバーは音声データを一切中継しないP2P構成です。数値は目標値であり、実測の検証結果を順次公開します。',
    faq2Q: 'ビデオ通話や画面共有はいつ追加されますか？',
    faq2A:
      '追加しません。これは未実装ではなく設計判断です。会議ツールの機能は常駐の軽さと引き換えになるため、Hirobaは「会議の手前」——在席・気配・声——に専念します。会議になったら、いつもお使いの会議ツールをご利用ください。',
    faq3Q: '音声データはどこを通りますか？',
    faq3A:
      '原則、participantsの間をWebRTCのP2Pで直接流れ、サーバーを通過しません。サーバーが扱うのは位置・在席・シグナリングといった制御データのみです。NAT環境によりP2Pが確立できない場合のみ、ホスト型ではTURNリレーを経由します（音声は暗号化されています）。',
    faq4Q: 'self-host とホスト型で機能差はありますか？',
    faq4A:
      'コア体験（在席・スペース・声の輪・呼びかけ）は同一です。ホスト型はOAuthログイン・組織管理・招待・TURN・永続化が「設定不要で付いてくる」のに対し、self-hostではそれらを任意で有効化・自前運用します。同じコードベースからプロファイル切替で両方をビルドしています。',
    faq5Q: '支払い方法・請求はどうなりますか？',
    faq5A:
      '支払いと請求管理は Stripe で行います。価格は ¥300／席／月（税別）で、席数は組織の登録メンバー数に基づきます。',

    pricingCtaTitle: 'まずは、フロアをひとつ。',
    pricingCtaDesc: 'ホスト型は組織作成から。self-host なら今日から動かせます。',

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

    mailEarlyAccess,
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
      const v = text(el.dataset.i18nHref);
      if (v !== null) el.setAttribute('href', v);
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