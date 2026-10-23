# syntax=docker/dockerfile:1
# hiroba-server as a container image. The build context is the repository
# root, because the crate's path dependency (`hiroba-common = { path =
# "../common" }`) needs both server/ and common/ in the tree:
#
#   docker build -f server/Dockerfile -t hiroba-server .
#
# The binary is linked statically against musl, so the same build doubles as
# the portable Linux release asset (`--target binary`), and the runtime image
# needs nothing beyond CA certificates (the JWKS fetch in oidc mode).
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev build-base
WORKDIR /src
# Cache dependency compiles across source-only changes: build a dummy crate
# tree from the real manifests first, so that layer is only invalidated when
# Cargo.toml / Cargo.lock change.
COPY common/Cargo.toml ./common/
COPY server/Cargo.toml server/Cargo.lock ./server/
RUN mkdir -p common/src server/src && \
    echo "pub fn _dummy() {}" > common/src/lib.rs && \
    echo "fn main() {}" > server/src/main.rs
RUN --mount=type=cache,id=hiroba-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    cargo build --release --locked --manifest-path server/Cargo.toml
COPY common ./common
COPY server ./server
# COPY preserves context mtimes (older than the dummy build above) and cargo's
# freshness check only rebuilds on NEWER inputs — without the touch, the build
# below is a no-op and the image ships the dummy binary.
RUN --mount=type=cache,id=hiroba-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    touch common/src/lib.rs server/src/main.rs && \
    cargo build --release --locked --manifest-path server/Cargo.toml && \
    mkdir /data

# Only the binary: `docker build --target binary -o type=local,dest=out .`
# writes it to out/hiroba-server. CI publishes it as the Linux release asset.
FROM scratch AS binary
COPY --from=build /src/server/target/release/hiroba-server /hiroba-server

FROM gcr.io/distroless/static-debian12:nonroot
# The image persists to /data by default (ENV below). Ship the directory owned
# by the nonroot user so a named volume mounted there is writable; a bind
# mount keeps the host directory's ownership instead (chown it to 65532).
COPY --from=build --chown=65532:65532 /data /data
COPY --from=build /src/server/target/release/hiroba-server /usr/local/bin/hiroba-server
ENV HIROBA_DB=/data/hiroba.db
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/hiroba-server"]
