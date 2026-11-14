# Floors monorepo builder — produces all service binaries.
# Build from repo root: docker build -f deploy/Dockerfile .
#
# At runtime, set SERVICE env to pick which service to start:
#   docker run -e SERVICE=api floors-services

FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ── install deps ──────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared-server/package.json packages/shared-server/
COPY packages/types/package.json packages/types/
COPY packages/wallet/package.json packages/wallet/
COPY packages/intents/package.json packages/intents/
COPY packages/money/package.json packages/money/
COPY packages/pricing/package.json packages/pricing/
COPY packages/registry-schema/package.json packages/registry-schema/
COPY services/api/package.json services/api/
COPY services/relayer/package.json services/relayer/
COPY services/risk/package.json services/risk/
COPY services/registry/package.json services/registry/
COPY services/indexer/package.json services/indexer/
RUN pnpm install --frozen-lockfile --ignore-scripts 2>/dev/null || pnpm install --no-frozen-lockfile --ignore-scripts

# ── build all packages + services ────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/
COPY services/ services/
RUN npx turbo run build --filter='@floors/*'

# ── runtime image ────────────────────────────────────────────────────────
FROM node:22-slim
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

COPY --from=build /app/ ./

ENV NODE_ENV=testnet
EXPOSE 3000

# SERVICE is set per-container in docker-compose
CMD ["sh", "-c", "node services/${SERVICE}/dist/index.js"]
