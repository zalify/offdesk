# Stage 1: Build Rust server
# Keep builder and runtime on the same Debian suite so the linked glibc
# version never drifts past what the runtime image provides.
FROM rust:1-slim-bookworm AS builder
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
RUN cargo build --release --bin offdesk-hub

# Stage 2: Production (client-only Hub, no public web UI)
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/offdesk-hub /usr/local/bin/

ENV DATABASE_PATH=/app/data/offdesk.db
EXPOSE 4317

CMD ["offdesk-hub"]
