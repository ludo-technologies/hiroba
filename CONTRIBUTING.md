# Contributing to Hiroba

Thanks for taking the time. Bug reports, self-hosting notes, and pull requests
are all welcome.

## Reporting a bug

Open an [issue](https://github.com/ludo-technologies/hiroba/issues) with:

- OS and version, and the Hiroba version (the release tag you installed)
- what you did, what happened, and what you expected
- for voice or screen-share problems: whether both peers are on the same
  network, and whether a TURN server is configured

For questions and ideas, use
[Discussions](https://github.com/ludo-technologies/hiroba/discussions).

## Setting up

Prerequisites: Rust (stable), Node 18+, and the
[Tauri v2 system dependencies](https://tauri.app/start/prerequisites/) for
your OS.

```bash
make           # builds the server, starts it, and launches the desktop app
```

Or run the two halves separately:

```bash
cd server && cargo run                          # ws://127.0.0.1:8787/ws
cd client && npm install && npm run tauri:dev   # in another terminal
```

Point the join screen at `ws://127.0.0.1:8787/ws`. Open a second client to test
proximity voice.

## Before you open a pull request

```bash
make test        # server: cargo test, client: tsc + node --test
make smoke       # protocol smoke test against a running server
cargo fmt --manifest-path server/Cargo.toml
cargo clippy --manifest-path server/Cargo.toml
```

Keep pull requests focused on one change. If a change touches the wire format,
update [`PROTOCOL.md`](PROTOCOL.md) in the same PR.

Commit messages follow the `type(scope): summary` form used in the history, for
example `fix(client): keep screen share sharp under bandwidth pressure`. Types
in use: `feat`, `fix`, `docs`, `chore`, `ci`. Scopes: `client`, `server`, `ci`.

## Layout

- `server/` Rust signaling and state server (axum, tokio). Relays control
  messages only. Never touches media.
- `client/` Tauri desktop app. Vanilla TypeScript + Canvas 2D frontend in
  `client/src`, Rust shell in `client/src-tauri`.
- `common/` Rust crate with types shared by server and client.
- `docs/` self-hosting and packaging guides.

## License

By contributing you agree that your contributions are licensed under
[Apache-2.0](LICENSE). The Hiroba name, logo, and app icons are not covered by
that license; see the README.
