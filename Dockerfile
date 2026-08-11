FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Prisma engine needs OpenSSL; node:22-slim ships without it
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install deps with prisma/ schema present so the postinstall
# "prisma generate" step has what it needs.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

COPY . .

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:5000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Matches the previous Render startCommand: sync schema, backfill the legacy
# wishlist column into WishlistItem, then boot.
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node server.js"]
