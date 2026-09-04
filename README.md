<div align="center">

[English](README.md) | [日本語](README.ja.md)

# Hiroba

**A lightweight, open-source virtual office for remote teams.**

See who's around. Walk over. Start talking.

[![Latest release](https://img.shields.io/github/v/release/ludo-technologies/hiroba?label=release)](https://github.com/ludo-technologies/hiroba/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<img src="docs/hiroba-demo.gif" width="900" alt="An avatar walks over to a teammate and starts a voice conversation in Hiroba">

[**Download Hiroba**](https://github.com/ludo-technologies/hiroba/releases/latest) · [Website](https://hirobaoffice.com/) · [Blog](https://hirobaoffice.com/blog/) · [Self-hosting guide](docs/SELF_HOSTING.md) · [Protocol](PROTOCOL.md)

</div>

## Why Hiroba

Remote teams have plenty of tools for scheduled meetings. What they lose is the
small moment before a conversation: seeing that someone is around, walking over,
and asking, "Got a sec?" Hiroba brings that moment back without trying to
replace your meeting software.

- **Presence at a glance** — see who is active, away, busy, or already in a call.
- **Conversation without ceremony** — walk over for spatial voice, or page
  someone directly from the roster.
- **Light by design** — a native Tauri client built to stay open all day, not an
  Electron meeting suite.
- **Open and self-hostable** — run the Rust server yourself with no seat limits
  or feature gating, or use the managed hosted edition.

## Install

macOS (Apple Silicon or Intel):

```bash
brew tap ludo-technologies/hiroba
brew trust ludo-technologies/hiroba
brew install --cask hiroba
```

Homebrew 6 refuses to load a cask from a third-party tap until you trust it; on
older versions the `brew trust` line is unnecessary.

Windows:

```powershell
winget install LudoTechnologies.Hiroba
```

Or download the installer from the
[latest release](https://github.com/ludo-technologies/hiroba/releases/latest).
Hiroba updates itself in place, so you only install once.

## How It Works

1. Join your organization's floor and see where everyone is.
2. Move through the lobby or switch to a small team space.
3. Walk near someone to talk, or call any teammate with one click.
4. Leave Hiroba running so the floor is there when your team needs it.

Voice is peer-to-peer over WebRTC. There is no always-on video, recording, or
media server. During a 1:1 call you can share your screen with that peer.

## Architecture

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

The server relays control data only; audio goes directly between peers. The
wire format is specified in [`PROTOCOL.md`](PROTOCOL.md).

- **Server** (`server/`) — Rust, axum, tokio. A single static binary with no
  required external services.
- **Client** (`client/`) — Tauri (Rust shell + OS WebView) with a vanilla
  TypeScript + Canvas 2D frontend, using the WebView's built-in WebRTC.

## Development

Prerequisites: **Rust** (stable), **Node** 18+, and the
[Tauri v2 system dependencies](https://tauri.app/start/prerequisites/) for your OS.

```bash
# Server (listens on 0.0.0.0:8787 by default; override with HIROBA_ADDR)
cd server && cargo run

# Client, in another terminal
cd client && npm install && npm run tauri:dev
```

In the join screen, point the client at `ws://127.0.0.1:8787/ws`. Open a second
client to see two avatars; walk them together to hear spatial voice fade in.
You start muted — click the mic button to go live. Move with **WASD / arrow
keys**, switch spaces with the **tabs**, and page a teammate with **Call** in
the sidebar.

Release builds:

```bash
# Server binary: server/target/release/hiroba-server
cd server && cargo build --release

# Client bundles: client/src-tauri/target/release/bundle/
# Both server URLs are required; the build fails without them.
cd client && npm install
VITE_HIROBA_SERVER="wss://hiroba.example/ws" \
VITE_HIROBA_AUTH_SERVER="https://auth.hiroba.example" \
npm run tauri build
```

Tagged releases build these on CI and publish them to GitHub Releases, the
Homebrew tap, and winget — see [docs/PACKAGING.md](docs/PACKAGING.md).

## Self-Hosting

The server needs no media server and no database (SQLite is optional via
`HIROBA_DB`). See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for deployment,
configuration, firewall/NAT notes, and when you might need a TURN server.

A managed hosted edition (OAuth sign-in, invites, billing) is offered separately
and is not part of this repository.

## Update Checks

Official builds check `update.hirobaoffice.com` for a new version shortly after
launch and every four hours while open; the update itself downloads from GitHub
Releases. From those requests we keep one row per device per day: platform,
architecture, installed version, and the country Cloudflare derives from the
IP. The device is a hash of IP and user agent salted with the date, so rows
cannot be linked across days, and they are deleted after 90 days.

There is no other telemetry: nothing about your org, floor, teammates, calls,
or usage is collected, and the server ships no analytics SDK. Self-hosted
builds can disable the check entirely — see
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#auto-update).

## License

[Apache-2.0](LICENSE). Includes a patent grant.

**Brand assets are not covered by Apache-2.0.** The "Hiroba" name, logo, and
app icons (`app-icon.png`, `app-icon-macos.png`) are excluded from the
Apache-2.0 license grant. They may not be used to brand a fork or a derived
service without permission. Everything else — code, docs, protocol — is
Apache-2.0.
