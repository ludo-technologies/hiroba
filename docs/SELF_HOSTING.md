# Self-hosting Hiroba

Hiroba is built **self-host first** (NFR-10). The server is a single static binary
that holds no media and needs no database, no SFU, and no external services. A
small VM, a Raspberry Pi, or a spare box is plenty for a team of ~10.

## 1. What you are running

Only the **server** is self-hosted. It:

- accepts WebSocket connections at `GET /ws`,
- holds one org (tenant) with a lobby plus team spaces, and an org-wide roster,
- relays per-space positions (~12 Hz), presence/status (join/leave/away/DND/
  in-call), proximity decisions, cross-space paging, and the WebRTC signaling
  handshake,
- exposes `GET /health` → `ok` for liveness checks.

It runs as a **single configured org in guest mode** by default: anyone who
connects joins that org with the name/color they pick (no accounts, no database).
That is the recommended self-host setup and the rest of this guide assumes it.

The same binary also supports the hosted-profile pieces when you want them, all
off by default and all DB-less:

- **OAuth/OIDC auth** — set `HIROBA_AUTH=jwt` (shared-secret) or `oidc` (verify
  tokens against a provider's JWKS). See [§6](#6-authentication-optional).
- **Multi-tenant** — once auth is on, a verified token's `org` claim selects (or
  creates) its tenant; tenants are fully isolated. Guest mode is single-org.
- **TURN credential issuance** — `GET /ice` mints short-lived coturn credentials.
  See [§5](#configuring-ice--turn-servers-on-the-client).

Invites, persistence, billing, and admin roles remain future.

**Audio never reaches your server** — clients connect peer-to-peer (WebRTC mesh).
Your server's job is light-weight control traffic only, so resource use stays tiny
even with everyone connected all day.

Each user runs the **desktop client** themselves and points it at your server URL.

## 2. Build the server binary

```bash
git clone <your-fork-or-this-repo> hiroba
cd hiroba/server
cargo build --release
# => target/release/hiroba-server   (a single self-contained binary)
```

Copy `target/release/hiroba-server` to your host. That one file is the entire
deployment.

## 3. Run it

```bash
# Defaults to 0.0.0.0:8787
./hiroba-server

# Choose a different bind address / port:
HIROBA_ADDR=0.0.0.0:9000 ./hiroba-server
```

Verify it's up:

```bash
curl http://YOUR_HOST:8787/health      # -> ok
```

### Run as a systemd service (Linux)

```ini
# /etc/systemd/system/hiroba.service
[Unit]
Description=Hiroba presence server
After=network.target

[Service]
ExecStart=/opt/hiroba/hiroba-server
Environment=HIROBA_ADDR=0.0.0.0:8787
Restart=on-failure
DynamicUser=yes
# It needs no disk, no privileges beyond binding its port.

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hiroba
```

## 4. Configuration

| Variable          | Default        | Meaning                                       |
|-------------------|----------------|-----------------------------------------------|
| `HIROBA_ADDR`     | `0.0.0.0:8787` | Address:port the server binds to.             |
| `HIROBA_ORG`      | `ludo`         | Default/guest org (tenant) id. Also the fallback tenant for tokens with no `org` claim. |
| `HIROBA_ORG_NAME` | `Ludo`         | Org display name shown atop the roster.       |
| `HIROBA_DB`       | *(unset → in-memory)* | Path to a SQLite file persisting orgs + space catalogs across restarts (created on first boot). Unset keeps the fully DB-less profile; spaces created at runtime are then lost on restart. |
| `HIROBA_CORS_ALLOW_ORIGINS` | *(unset → any)* | Comma-separated CORS origin allow-list for the HTTP endpoints (`/ice`, `/health`). See below. |
| `RUST_LOG`        | `info`         | Log verbosity (`error`/`warn`/`info`/…).      |

Auth and TURN add a few more (all optional, default off) — see [§6](#6-authentication-optional)
and [§5](#configuring-ice--turn-servers-on-the-client).

### CORS

By default the server answers cross-origin requests from anywhere, which is
right for desktop-only and dev setups. If you also serve a **web** build of the
client, you can pin the allowed origins:

```bash
HIROBA_CORS_ALLOW_ORIGINS="https://hiroba.example,tauri://localhost,http://tauri.localhost"
```

Two things to know before turning this on:

- **Always include the Tauri webview origins** — `tauri://localhost`
  (macOS/Linux) and `http://tauri.localhost` (Windows). The WebSocket itself is
  not CORS-gated, but the desktop client's `GET /ice` fetch is: leave these out
  and desktop clients silently lose TURN credentials (calls still work where
  STUN suffices, then fail behind symmetric NAT).
- The list is **fail-closed**: an entry that doesn't parse as an origin aborts
  startup with an error instead of being silently dropped — so a typo can't
  leave you running open while believing you're restricted.

### Pointing distribution builds at your servers (client)

The desktop client's join form defaults to `ws://127.0.0.1:8787/ws` and
`http://127.0.0.1:8788`. When you build the app for your users, bake your URLs
in at build time so nobody has to open *Advanced* on first run:

```bash
cd client
VITE_HIROBA_SERVER="wss://hiroba.example/ws" \
VITE_HIROBA_AUTH_SERVER="https://auth.hiroba.example" \
npm run tauri build
```

A user's own *Advanced* override (saved in the app) still wins over the baked-in
default.

> **Note on the webview CSP**: the app ships a CSP that restricts scripts to the
> bundle (`script-src 'self'`), but `connect-src` deliberately allows any
> `ws:`/`wss:`/`http:`/`https:` host — the server URL is user-configurable, so
> the connect targets cannot be enumerated at build time. Script injection is
> the boundary being defended; network egress is not constrained.

Space parameters (world size, `nearRadius`, tick rate, capacity) are
server-authoritative and sent to clients in the `welcome` message — see
[`PROTOCOL.md`](../PROTOCOL.md). The server seeds a lobby plus one team space;
users create more team spaces from the client (the `+` tab).

## 5. Networking

### Server port

Open the chosen TCP port (default **8787**) to your users. For internet exposure,
put the server behind a TLS-terminating reverse proxy and have clients use
`wss://`:

```nginx
# nginx: terminate TLS and proxy the WebSocket
location /ws {
    proxy_pass         http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade    $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host       $host;
    proxy_read_timeout 1h;          # presence connections are long-lived
}
location /health { proxy_pass http://127.0.0.1:8787; }
```

Clients then connect to `wss://your.domain/ws`.

### Peer-to-peer audio (the important part)

Voice is direct between clients over WebRTC. To traverse NAT, clients use a public
**STUN** server by default (`stun:stun.l.google.com:19302`). STUN is enough for
most home/office networks.

**Symmetric NAT / locked-down networks** can't be traversed by STUN alone and need
a **TURN** server, which *relays* the media. Self-host defaults to STUN only — add
TURN only if some of your users genuinely can't connect. When you do, self-host
[coturn](https://github.com/coturn/coturn) and either let the server hand out
short-lived credentials (recommended, below) or inject a fixed list on the client.
Note that when TURN is used, that media *does* pass through the TURN relay (the
only exception to "audio never touches a server").

### Configuring ICE / TURN servers on the client

TURN credentials are delivered to the client **out of band** — never over the
signaling WebSocket. The client resolves its ICE list in this order
(`client/src/config.ts::resolveIceServers`):

1. `window.__HIROBA_CONFIG__.iceServers` — an operator override baked into the
   client (below). Use this to pin a fixed list.
2. The server's **`GET /ice`** endpoint — fetched over HTTP(S). When you configure
   TURN on the server it returns STUN **plus** TURN entries carrying freshly
   minted, short-lived credentials. This is the recommended path: no long-lived
   secret ever lives in the client. `/ice` follows the same auth boundary as the
   WebSocket: in JWT/OIDC mode it requires `Authorization: Bearer <token>` (else
   `401`); in guest mode it is open. The client sends the join token automatically.
3. Public STUN — the default when nothing else is set.

A malformed override or a failed/garbled `/ice` response is ignored and the client
keeps STUN, so it can never be stranded with no servers at all.

**Recommended: let the server mint credentials.** Run coturn with a
`static-auth-secret` and give the Hiroba server the same secret. The server then
issues the coturn REST-API ephemeral credential
(`username = "<unix-expiry>:<user>"`, `credential = base64(HMAC-SHA1(secret, username))`)
on every `GET /ice` — no per-user state, no database.

```bash
# Hiroba server: enable TURN issuance
HIROBA_TURN_URL="turn:turn.your.domain:3478,turns:turn.your.domain:5349" \
HIROBA_TURN_SECRET="the-same-static-auth-secret" \
HIROBA_TURN_TTL=3600 \
HIROBA_STUN_URL="stun:stun.l.google.com:19302" \
./hiroba-server
```

```ini
# coturn (turnserver.conf): match the secret above
use-auth-secret
static-auth-secret=the-same-static-auth-secret
realm=turn.your.domain
```

| Variable            | Default                          | Meaning                                              |
|---------------------|----------------------------------|------------------------------------------------------|
| `HIROBA_TURN_URL`   | _(unset → no TURN)_              | Comma-separated `turn:`/`turns:` URLs.               |
| `HIROBA_TURN_SECRET`| _(unset → no TURN)_              | coturn `static-auth-secret`. Both must be set to enable TURN. |
| `HIROBA_TURN_TTL`   | `3600`                           | Credential lifetime, seconds.                        |
| `HIROBA_TURN_USER`  | `hiroba`                         | Tag embedded in the ephemeral username.              |
| `HIROBA_STUN_URL`   | `stun:stun.l.google.com:19302`   | STUN URL returned by `/ice` (and the client default).|

**Alternative: a fixed client-side list.** Set the global before the app loads —
e.g. uncomment the block in `client/index.html` — then rebuild
(`npm run tauri build`). This wins over `/ice`:

```html
<script>
  window.__HIROBA_CONFIG__ = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "turn:turn.your.domain:3478", username: "user", credential: "secret" }
    ]
  };
</script>
```

## 6. Authentication (optional)

By default (`HIROBA_AUTH=guest`) the server accepts anyone into the single
configured org — no tokens, no accounts. To require verified logins, set
`HIROBA_AUTH` and have your login edge pass a JWT as the `hello.token` (the join
form's *token* field, or your own shell). The server **verifies** the token; it
does not run the OAuth dance itself — that belongs at your edge (Auth0, Clerk,
Google, or a self-hosted OIDC provider).

| Variable               | Mode      | Meaning                                                        |
|------------------------|-----------|----------------------------------------------------------------|
| `HIROBA_AUTH`          | all       | `guest` (default) · `jwt` (HS256 shared secret) · `oidc` (RS256 via JWKS). |
| `HIROBA_JWT_SECRET`    | `jwt`     | Shared secret the edge signs tokens with (HS256). Required for `jwt`. |
| `HIROBA_JWKS_URL`      | `oidc`    | Provider JWKS endpoint (RS256). Required for `oidc`.            |
| `HIROBA_JWT_ISSUER`    | jwt/oidc  | Optional expected `iss` claim.                                 |
| `HIROBA_JWT_AUDIENCE`  | jwt/oidc  | Optional expected `aud` claim.                                 |

Claims consumed: `org` (tenant id — falls back to `HIROBA_ORG` if absent),
`org_name`, `sub`, `name`, `color`, plus standard `exp` (always validated) and the
optional `iss`/`aud`. A token's `org` claim selects (or lazily creates) its
tenant, and tenants are **fully isolated** — one org never sees another's roster,
positions, or signaling (NFR-12). A `hello` may still override `name`/`color`.

Tenants are held **in memory** and persist for the server's lifetime; the
signaling server itself has no database, so they reset on restart. Persistence
of presence state is future.

### Bringing a login edge

The server verifies tokens but does not run the OAuth dance — pair it with any
OIDC provider (Auth0, Clerk, Google, Keycloak, …). Point `HIROBA_JWKS_URL` at
the provider's JWKS and have your edge mint a JWT carrying the `org` / `sub`
claims described above; the desktop client passes it as `hello.token`:

```bash
HIROBA_AUTH=oidc HIROBA_JWKS_URL=https://your-provider/.well-known/jwks.json \
HIROBA_JWT_ISSUER=https://your-provider HIROBA_JWT_AUDIENCE=hiroba \
make server
```

A turnkey login backend — Google / GitHub sign-in with invites, orgs, and admin
roles, so there's no provider to wire up yourself — is part of Hiroba's hosted
edition and is not included in this repository.

## 7. Resource expectations

The server is designed to be boring and cheap: it does a little work per tick
(~12 Hz) **only for spaces that have someone in them** — empty spaces are skipped
entirely, so an idle floor costs almost nothing. Work scales with the number of
connected peers, not the number of spaces. For an org of a few small team spaces
plus a ~10-person lobby, expect negligible CPU and a small, flat memory footprint.
These are the NFR-01/02/06 targets.

## 8. Scaling limits

Hiroba is **presence-first, not a meeting tool** — it deliberately omits video,
screen share, recording, and an SFU. The intended ceiling is
**≤5 per team space and ~10 in the lobby**, with a few dozen people per org. A
WebRTC mesh is comfortable in that range; each client holds at most a handful of
P2P links.

Past ~10–15 people in one space the mesh becomes the bottleneck (each client
maintaining many P2P links — "the mesh cliff"). That is **out of scope by design**:
if you consistently need denser crowds or video, Hiroba is the wrong tool, not a
tool to be scaled up. Keep spaces small and the experience stays light.
