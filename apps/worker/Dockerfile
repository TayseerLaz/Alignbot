FROM node:20-alpine AS deps
RUN apk add --no-cache openssl libc6-compat
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY pnpm-workspace.yaml package.json .npmrc ./
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

FROM deps AS build
WORKDIR /repo
RUN pnpm --filter @aligned/db exec prisma generate
RUN pnpm --filter @aligned/shared build
RUN pnpm --filter @aligned/db build
RUN pnpm --filter @aligned/worker build
RUN pnpm --filter @aligned/worker deploy /out --prod --legacy

FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl libc6-compat tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
EXPOSE 9100
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
