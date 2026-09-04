<div align="center">

[English](README.md) | [日本語](README.ja.md)

# Hiroba

**リモートチームのための、軽量なオープンソースのバーチャルオフィス。**

誰がいるか分かる。近づけば、すぐ話せる。

[![Latest release](https://img.shields.io/github/v/release/ludo-technologies/hiroba?label=release)](https://github.com/ludo-technologies/hiroba/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<img src="docs/hiroba-demo.gif" width="900" alt="Hirobaでアバターが同僚のもとへ歩いていき、音声会話を始める様子">

[**Hirobaをダウンロード**](https://github.com/ludo-technologies/hiroba/releases/latest) · [Webサイト](https://hirobaoffice.com/) · [ブログ](https://hirobaoffice.com/blog/) · [セルフホストガイド](docs/SELF_HOSTING.md) · [プロトコル](PROTOCOL.md)

</div>

## なぜHirobaなのか

リモートチームには、予定された会議のためのツールはすでに十分あります。失われているのは、会話が始まる前の小さな瞬間です。誰かがいることに気づき、近づいて「ちょっといい？」と声をかける。Hirobaは会議ツールを置き換えることなく、その瞬間を取り戻します。

- **一目で分かるプレゼンス** — アクティブ、離席、取り込み中、通話中が分かります。
- **気軽に始まる会話** — 近づけば空間音声で話せます。メンバー一覧から直接呼び出すこともできます。
- **軽さを前提とした設計** — 一日中開いたままにできるネイティブTauriクライアントです。Electron製の会議スイートではありません。
- **オープンでセルフホスト可能** — Rust製サーバーを自分で運用できます。席数制限や機能制限はありません。マネージドホスト版も利用できます。

## インストール

macOS（Apple Silicon／Intel）：

```bash
brew tap ludo-technologies/hiroba
brew trust ludo-technologies/hiroba
brew install --cask hiroba
```

Homebrew 6以降は、公式以外のtapのcaskを信頼するまで読み込みません。それ以前のバージョンでは`brew trust`の行は不要です。

Windows：

```powershell
winget install LudoTechnologies.Hiroba
```

[最新リリース](https://github.com/ludo-technologies/hiroba/releases/latest)からインストーラーを直接ダウンロードすることもできます。Hirobaはアプリ自身が更新されるため、インストールは最初の1回だけです。

## 使い方

1. 組織のフロアに参加すると、全員の居場所が分かります。
2. ロビーを歩き回るか、少人数のチームスペースに切り替えます。
3. 誰かに近づけば話せます。ワンクリックで任意のメンバーを呼び出すこともできます。
4. Hirobaを起動したままにしておけば、チームが必要なときにいつでもフロアがあります。

音声はWebRTCによるピアツーピア通信です。常時接続のビデオ、録画、メディアサーバーはありません。1対1の通話では、その相手に画面を共有できます。

## アーキテクチャ

```
        ┌──────────────────────────────┐        WebRTC P2P (Opus)
        │  Rust signaling/state server │      ┌───────────────────────┐
        │  axum + tokio + WebSocket    │      ▼                       ▼
        │  • org roster / presence     │   ┌──────┐  audio only   ┌──────┐
        │  • per-space position relay  │   │client│◀────mesh─────▶│client│
        │  • per-space proximity       │   │Tauri │               │Tauri │
        │  • WebRTC signaling relay    │   └──────┘               └──────┘
        │  • paging (cross-space 1:1)  │       ▲                     ▲
        │  NEVER touches media         │       │  WebSocket (control)│
        └──────────────┬───────────────┘       └─────────────────────┘
                       └──────────────────────────────────────────────┘
```

サーバーが中継するのは制御データだけで、音声はピア同士が直接やり取りします。通信形式は[`PROTOCOL.md`](PROTOCOL.md)に記載しています。

- **サーバー**（`server/`）— Rust、axum、tokio。必須の外部サービスがない、単一の静的バイナリです。
- **クライアント**（`client/`）— RustシェルとOS WebViewからなるTauriに、Vanilla TypeScriptとCanvas 2Dのフロントエンド。WebRTCはWebView内蔵のものを使います。

## 開発

必要なもの：**Rust**（stable）、**Node.js 18以降**、利用するOS向けの[Tauri v2システム依存パッケージ](https://tauri.app/start/prerequisites/)。

```bash
# サーバー（デフォルトでは0.0.0.0:8787で待ち受け。HIROBA_ADDRで変更可）
cd server && cargo run

# クライアント（別のターミナルで）
cd client && npm install && npm run tauri:dev
```

参加画面でサーバーに`ws://127.0.0.1:8787/ws`を指定します。2つ目のクライアントを開くと2人のアバターを確認でき、互いに近づけると空間音声が次第に聞こえます。参加時はミュート状態なので、マイクボタンをクリックすると発話できます。移動は**WASDキーまたは矢印キー**、スペースの切り替えは**タブ**、メンバーの呼び出しはサイドバーの**Call**です。

リリースビルド：

```bash
# サーバーバイナリ：server/target/release/hiroba-server
cd server && cargo build --release

# クライアントバンドル：client/src-tauri/target/release/bundle/
# 2つのサーバーURLは必須です。指定しない場合、ビルドは失敗します。
cd client && npm install
VITE_HIROBA_SERVER="wss://hiroba.example/ws" \
VITE_HIROBA_AUTH_SERVER="https://auth.hiroba.example" \
npm run tauri build
```

タグを打つとCIがこれらをビルドし、GitHub Releases、Homebrew tap、wingetへ公開します。詳しくは[docs/PACKAGING.md](docs/PACKAGING.md)をご覧ください。

## セルフホスト

サーバーにメディアサーバーもデータベースも必要ありません（`HIROBA_DB`を指定するとSQLiteを任意で利用できます）。デプロイ、設定、ファイアウォール／NAT、TURNサーバーが必要になる条件については、[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)を参照してください。

OAuthログイン、招待、課金を含むマネージドホスト版は別途提供しており、このリポジトリには含まれていません。

## アップデート確認

公式ビルドは、起動直後と、アプリを開いている間は4時間ごとに`update.hirobaoffice.com`へ新バージョンの有無を確認します。アップデート本体のダウンロード元はGitHub Releasesです。このリクエストから、1日1端末につき1行だけ記録します。プラットフォーム、アーキテクチャ、インストール済みバージョン、そしてCloudflareがIPから判定した国です。端末は、IPとユーザーエージェントをその日の日付でソルトしたハッシュとして記録するため、日をまたいで同一端末を追跡することはできません。記録は90日で削除されます。

これ以外のテレメトリはありません。組織、フロア、メンバー、通話、アプリの使用状況は一切収集せず、サーバーにも解析SDKは入っていません。セルフホスト用のビルドでは確認自体を無効にできます。[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#auto-update)を参照してください。

## ライセンス

[Apache-2.0](LICENSE)。特許権の許諾を含みます。

**ブランド資産はApache-2.0の対象外です。** 「Hiroba」の名称、ロゴ、アプリアイコン（`app-icon.png`、`app-icon-macos.png`）は、Apache-2.0によるライセンス許諾に含まれません。許可なくフォークや派生サービスのブランドとして使用することはできません。それ以外のコード、ドキュメント、プロトコルはApache-2.0です。
