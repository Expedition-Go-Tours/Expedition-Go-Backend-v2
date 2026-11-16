# syntax=docker/dockerfile:1.7
#
# Two applications, one build definition.
#
#   docker build --target platform-api -t platform-api .
#   docker build --target stays-api    -t stays-api    .
#
# Each target installs the same dependency tree (the two apps share one
# package.json and one Prisma schema) but starts only its own bootstrap. That is
# deliberate: the split is about *deployment* independence, not about
# duplicating node_modules or a second schema.
#
# There is no `prisma db push` here and no migration at startup. Schema changes
# are applied once, by a separate coordinated job (`prisma migrate deploy`), and
# never by an API container racing another API container.

ARG NODE_IMAGE=node:22-slim

# ─────────────────────────────────────────────────────────────────────────────
# base — OS packages needed by Prisma's query engine and by signal handling
# ─────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# openssl: Prisma engine runtime dependency on slim images.
# ca-certificates: outbound TLS (Stripe, PayPal, Resend, Cloudinary).
# tini: PID 1 that forwards SIGTERM to node, so `docker stop` triggers the
# graceful shutdown path instead of a 10-second SIGKILL.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# ─────────────────────────────────────────────────────────────────────────────
# deps — deterministic install + Prisma Client generation
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS deps

# The schema must exist before `npm ci` because the package's postinstall runs
# `prisma generate`.
COPY package.json package-lock.json ./
COPY prisma ./prisma

RUN npm ci --omit=dev

# Explicit, so a missing or broken postinstall hook fails the build instead of
# shipping an image whose client does not match the schema.
RUN npx prisma generate

# ─────────────────────────────────────────────────────────────────────────────
# runtime — application source, non-root user
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS runtime

ARG GIT_SHA=unknown
ARG RELEASE_VERSION=dev

LABEL org.opencontainers.image.source="https://github.com/Expedition-Go-Tours/Expedition-Go-Backend-v2" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${RELEASE_VERSION}" \
      org.opencontainers.image.title="travio-api" \
      org.opencontainers.image.description="Travio Africa API"

ENV RELEASE_COMMIT=${GIT_SHA} \
    RELEASE_VERSION=${RELEASE_VERSION}

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
# `.dockerignore` keeps .env, .git, tests, docs and local artefacts out.
COPY . .

# The `node` user ships with the official image (uid 1000). Running as it means
# a container escape starts from an unprivileged uid with no write access to
# /app, not from root on the host.
RUN chown -R node:node /app
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
EXPOSE 5000

# ─────────────────────────────────────────────────────────────────────────────
# platform-api — Tours, bookings, payments, admin, workers, schedulers
# ─────────────────────────────────────────────────────────────────────────────
FROM runtime AS platform-api

ENV SERVICE_NAME=platform-api \
    HOST=127.0.0.1 \
    PORT=5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "apps/platform-api/server.js"]

# ─────────────────────────────────────────────────────────────────────────────
# stays-api — accommodation vertical only. No Socket.IO, no workers, no
# schedulers, no migration. Port 5100 on loopback.
# ─────────────────────────────────────────────────────────────────────────────
FROM runtime AS stays-api

ENV SERVICE_NAME=stays-api \
    HOST=127.0.0.1 \
    STAYS_PORT=5100

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.STAYS_PORT||5100)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "apps/stays-api/server.js"]
