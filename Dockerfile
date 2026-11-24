# Stage 1: Build Expo Web frontend
# Note: Tauri Android remote-HTTPS mode and desktop OAuth login both navigate to
# the Hub origin, so the production Hub image continues serving the web bundle.
FROM node:22-slim AS frontend
ARG BUILD_ID
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared packages/shared
COPY packages/app packages/app
COPY scripts/stamp-build.mjs scripts/stamp-build.mjs
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Stamp ?v=BUILD_ID through index.html AND every nested chunk reference —
# chunk filenames are not reliably content-addressed across builds while
# being served immutable, so unstamped nested refs pin clients to old code.
RUN node scripts/stamp-build.mjs packages/app/dist "${BUILD_ID:-$(date +%s)}"

# Stage 2: Build Rust server
# Keep builder and runtime on the same Debian suite so the linked glibc
# version never drifts past what the runtime image provides.
FROM rust:1-slim-bookworm AS builder
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
RUN cargo build --release --bin offdesk-hub

# Stage 3: Production
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/offdesk-hub /usr/local/bin/
COPY --from=frontend /app/packages/app/dist /app/web

ENV OFFDESK_STATIC_DIR=/app/web
ENV DATABASE_PATH=/app/data/offdesk.db
EXPOSE 4317

CMD ["offdesk-hub"]
