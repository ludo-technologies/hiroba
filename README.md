<div align="center">

# Hiroba

**A presence-first, ultra-light 2D virtual office.**

*Built to be left running all day and forgotten — not a meeting tool.*

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

---

Existing virtual-office tools grew into "meeting-tool replacements" — video,
screen share, rooms, recording, integrations — and got **heavy**. Hiroba goes the
other way. It keeps only the core of *being somewhere together*:

1. **You're here** — your avatar is in a space (a lobby or a small team room).
2. **You can see who's around** — an always-visible org roster shows who's where
   and what they're doing (in this space / in a call / away / DND).
3. **You can move**, and switch spaces with a tab.
4. **Talk by being near** — proximity spatial voice in the lobby; a team room is
   effectively one small group call. **Or call anyone with one click** — a
   cross-space 1:1 "barge-in" that goes live instantly, wherever they are.
5. **It's light enough to forget** — idle CPU ≈ 0%, memory in the tens of MB.

No always-on video, no recording, no SFU. Just an org floor of small spaces,
points that move around, and voice that fades in as you get close. During a
1:1 page call you can optionally share your screen to that peer only — not a
meeting-room feature.

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

The server only moves *control* data: the org roster, per-space positions,
proximity decisions, and the WebRTC handshake. **Audio never flows through the
server** — peers connect directly (P2P mesh). A team room or lobby of ≤5 is
comfortable on a mesh. State is split into two scopes — an **org roster**
sent to everyone, and **per-space** position/proximity/audio sent only to those
in that space. The wire format is specified in [`PROTOCOL.md`](PROTOCOL.md).

- **Server** (`server/`) — Rust, axum, tokio. Single static binary. Holds no
  media, so it stays tiny and idle-cheap.
- **Client** (`client/`) — Tauri (Rust shell + OS WebView) with a vanilla
  TypeScript + Canvas 2D frontend. Uses the OS WebView's built-in WebRTC, so the
  binary is far smaller and lighter than an Electron app.

## Quick start (development)

Prerequisites: **Rust** (stable), **Node** 18+, and the
[Tauri v2 system dependencies](https://tauri.app/start/prerequisites/) for your OS.

```bash
# 1. Start the server (listens on 0.0.0.0:8787 by default)
cd server
cargo run                      # or: HIROBA_ADDR=0.0.0.0:9000 cargo run

# 2. Start the client (in another terminal)
cd client
npm install
npm run tauri:dev   # dev identifier (org.hiroba.app.dev) keeps WebView
                    # storage isolated from an installed release build
```

In the client's join screen, enter a display name, pick an avatar color, and
point it at your server (`ws://127.0.0.1:8787/ws` for local dev). Open a second
client instance to see two avatars; walk them together in the lobby to hear
spatial voice fade in, or switch both to the same team tab for a group call.
**You start muted** — click the mic button to go live.

Controls: **WASD / arrow keys** to move; the **tabs** (top) switch spaces; the
**sidebar** lists the org — hover a member and hit **Call** to page them.

## Building release artifacts

```bash
# Server: a single optimized binary at server/target/release/hiroba-server
cd server && cargo build --release

# Client: native installers/bundles under client/src-tauri/target/release/bundle/
# The server URLs to bake in are required — the build fails without them
# (there is intentionally no loopback fallback in release bundles).
cd client && npm install
VITE_HIROBA_SERVER="wss://hiroba.example/ws" \
VITE_HIROBA_AUTH_SERVER="https://auth.hiroba.example" \
npm run tauri build
```

## Self-hosting

The server is a single binary with no required external services (no media
server; optional SQLite via `HIROBA_DB`). See
**[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)** for deployment, configuration,
firewall/NAT notes, and when you might need a TURN server.

A managed hosted edition (OAuth sign-in, invites, billing) is offered separately
and is not part of this repository.

## Landing page

The marketing site (landing + pricing) lives in [`site/`](site/) as a
dependency-free static site. Preview it locally with `make site`.

## License

[Apache-2.0](LICENSE). Includes a patent grant.

**Brand assets are not covered by Apache-2.0.** The "Hiroba" name, logo, app
icons (`app-icon.png`, `app-icon-macos.png`), site favicon, and brand assets
under `site/` are excluded from the Apache-2.0 license grant. They may not be
used to brand a fork or a derived service without permission. Everything else
— code, docs, protocol — is Apache-2.0.
