# ──────────────────────────────────────────────────
# Shén Zhèn Airdrop — Production Dockerfile
# Builds bot + mini-app only (admin is separate).
# ──────────────────────────────────────────────────

FROM node:20-alpine AS builder

# Build tools for native deps (bcryptjs)
RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy workspace config (tsconfig.base.json is critical — all packages extend it)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./

# Copy only the packages we need (NOT admin)
COPY packages/core/package.json packages/core/
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
COPY apps/bot/package.json apps/bot/
COPY apps/mini-app/package.json apps/mini-app/

# Install deps
RUN pnpm install --no-frozen-lockfile

# Copy ALL source code for the packages we need
COPY packages/ packages/
COPY apps/bot/ apps/bot/
COPY apps/mini-app/ apps/mini-app/

# ─── Build in dependency order ─────────────────────
# 1. Generate Prisma client (database needs this before tsc)
RUN cd packages/database && npx prisma generate

# 2. Build shared (no deps on other workspace packages)
RUN pnpm --filter @shen-zhen/shared build

# 3. Build database (depends on prisma client, no workspace deps)
RUN pnpm --filter @shen-zhen/database build

# 4. Build core (depends on shared + database)
RUN pnpm --filter @shen-zhen/core build

# 5. Build mini-app (Vite, outputs static files)
RUN pnpm --filter @shen-zhen/mini-app build

# 6. Build bot (depends on everything)
RUN pnpm --filter @shen-zhen/bot build

# ─── Production Stage ───────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Copy the entire built workspace
COPY --from=builder /app /app

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "apps/bot/dist/index.js"]
