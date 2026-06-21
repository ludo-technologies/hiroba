# Hiroba — one-command local launch.
#
#   make             # = make dev : build+run the server, then launch the desktop app
#   make dev         # same as above
#   make server      # run only the WebSocket server (foreground)
#   make client      # run only the desktop app (assumes a server is already up)
#   make bundle      # produce the release .app / .dmg
#   make site        # serve the landing site (site/) at http://127.0.0.1:8000
#   make smoke       # run the protocol smoke test against a running server
#   make auth-smoke  # run the auth/multi-tenant smoke (starts a JWT-mode server)
#   make test        # unit tests: server (cargo), client (npm)
#
# `make dev` starts hiroba-server in the background, launches the Tauri desktop
# app in the foreground, and stops the server automatically when the app exits.

SHELL := /bin/bash
.DEFAULT_GOAL := dev

SERVER_MANIFEST := server/Cargo.toml
SERVER_BIN := server/target/release/hiroba-server
HIROBA_ADDR ?= 127.0.0.1:8787

.PHONY: dev server client build-server bundle site smoke auth-smoke test

dev: build-server
	@echo "▶ starting hiroba-server on $(HIROBA_ADDR) (background)…"
	@HIROBA_ADDR=$(HIROBA_ADDR) $(SERVER_BIN) & \
	SERVER_PID=$$!; \
	trap "echo; echo '■ stopping hiroba-server (pid '$$SERVER_PID')…'; kill $$SERVER_PID 2>/dev/null" EXIT INT TERM; \
	sleep 0.5; \
	echo "▶ launching desktop app (Tauri)…"; \
	cd client && npm run tauri dev

build-server:
	@cargo build --release --manifest-path $(SERVER_MANIFEST)

server: build-server
	@HIROBA_ADDR=$(HIROBA_ADDR) $(SERVER_BIN)

client:
	@cd client && npm run tauri dev

bundle:
	@cd client && npm run tauri build

# Landing site: dependency-free static site under site/.
SITE_PORT ?= 8000
site:
	@echo "▶ serving site/ at http://127.0.0.1:$(SITE_PORT)"
	@python3 -m http.server -d site $(SITE_PORT)

smoke:
	@HIROBA_WS=ws://$(HIROBA_ADDR)/ws node server/tests/smoke.mjs

# Auth + multi-tenant smoke: spin up a JWT-mode server on a scratch port, run the
# token/tenant verification checks, then stop it. Exercises the server's own
# token verification — no external login backend required.
AUTH_ADDR ?= 127.0.0.1:8798
auth-smoke: build-server
	@HIROBA_ADDR=$(AUTH_ADDR) HIROBA_AUTH=jwt HIROBA_JWT_SECRET=testsecret $(SERVER_BIN) & \
	SERVER_PID=$$!; \
	trap "kill $$SERVER_PID 2>/dev/null" EXIT INT TERM; \
	sleep 0.5; \
	HIROBA_WS=ws://$(AUTH_ADDR)/ws HIROBA_JWT_SECRET=testsecret node server/tests/auth.mjs

# Fast, network-free unit suites.
test:
	@echo "▶ server unit tests (cargo)…"; cargo test --manifest-path $(SERVER_MANIFEST)
	@echo "▶ client unit tests (npm)…"; cd client && npm test
