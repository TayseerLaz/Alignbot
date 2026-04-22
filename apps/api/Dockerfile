# Multi-stage Dockerfile for the Fastify API.
# Build stage installs all deps + Prisma client, then prunes to prod-only.
FROM node:20-alpine AS deps
RUN apk add --no-cache openssl libc6-compat
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline

# ---------- build ----------
FROM deps AS build
WORKDIR /repo
RUN pnpm --filter @aligned/db exec prisma generate
RUN pnpm --filter @aligned/shared build
RUN pnpm --filter @aligned/db build
RUN pnpm --filter @aligned/api build
RUN pnpm --filter @aligned/api deploy /out --prod --legacy

# ---------- runtime ----------
FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl libc6-compat tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
COPY --from=build /repo/packages/db/prisma ./packages/db/prisma
EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
