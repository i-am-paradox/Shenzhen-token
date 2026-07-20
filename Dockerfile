# ──────────────────────────────────────────────────
# Shén Zhèn Airdrop — Production Dockerfile
# Multi-stage build: builds all packages, then runs
# the bot server which also serves the mini-app static files.
# ──────────────────────────────────────────────────

# Stage 1: Build
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy repository content
COPY . .

# Install all dependencies
RUN pnpm install --no-frozen-lockfile

# Generate Prisma client
RUN cd packages/database && npx prisma generate

# Build packages & apps
RUN pnpm --filter @shen-zhen/shared build 2>/dev/null || true
RUN pnpm --filter @shen-zhen/core build 2>/dev/null || true
RUN pnpm --filter @shen-zhen/mini-app build
RUN pnpm --filter @shen-zhen/bot build

# Stage 2: Production runtime
FROM node:20-alpine AS runner

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy built workspace
COPY --from=builder /app ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health || exit 1

# Run the server
CMD ["node", "apps/bot/dist/index.js"]
