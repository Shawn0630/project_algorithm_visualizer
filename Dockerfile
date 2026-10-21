# Algorithm Visualizer - single-image build.
#
#   docker compose up --build
#
# The image contains the built web app, the server, and the bundled
# algorithms/ content as the seed: on first start the server imports
# that content into its SQLite database (server/data/visualizer.db).
# All user data (the database, AI call log) lives on the compose
# volume, so rebuilding/upgrading the image never loses imported
# problems or saved code.

# ---------- Stage 1: build the web app ----------
FROM node:20-bookworm-slim AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
# webpack 4 on Node 17+ needs the legacy OpenSSL provider.
ENV NODE_OPTIONS=--openssl-legacy-provider
RUN npx react-scripts build

# ---------- Stage 2: server dependencies ----------
# The full (non-slim) image ships the node-gyp toolchain, so the
# better-sqlite3 native module builds even if its prebuilt binary
# cannot be downloaded.
FROM node:20-bookworm AS server-deps
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm install --no-audit --no-fund

# ---------- Stage 3: runtime ----------
FROM node:20-bookworm-slim
# python3 is for the Python tracer / Python test runs inside the
# container. Java pads need a JDK and C++ pads need Docker on the
# host, so those two keep reporting their "not available" message
# in this image; the native install covers them.
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
COPY --from=server-deps /server/node_modules ./node_modules
COPY server/ ./
COPY --from=web-build /web/build ./public/frontend-built
COPY algorithms/ ./seed-content/algorithms/
ENV NODE_ENV=production \
    HTTP_PORT=8088 \
    HTTPS_PORT=8443 \
    CREDENTIALS_ENABLED=0 \
    WEBHOOK_ENABLED=0 \
    GITHUB_CLIENT_ID=docker \
    GITHUB_CLIENT_SECRET=docker \
    SEED_ALGORITHMS_DIR=/app/server/seed-content/algorithms
EXPOSE 8088
VOLUME ["/app/server/data"]
CMD ["npm", "start"]
