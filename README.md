# ALIGNED Business Platform

Multi-tenant SaaS where ALIGNED's clients manage product/service catalogs,
business info, and FAQs. ALIGNED's WhatsApp chatbots read from this platform
via a low-latency, cached API.

## Quick start (dev)

```bash
# 1. Install
nvm use
corepack enable
pnpm install

# 2. Bring up Postgres, Redis, PgBouncer, Mailhog
pnpm docker:up

# 3. Database
cp .env.example .env
pnpm db:migrate
pnpm db:seed

# 4. Run everything (api on :4000, web on :3000, worker)
pnpm dev
```

Mailhog UI: http://localhost:8025
API docs: http://localhost:4000/docs
Portal: http://localhost:3000

## Production

- **Portal:** https://alignbot.aligned-tech.com
- **API:** https://api.aligned-tech.com
- **API docs:** https://api.aligned-tech.com/docs (all routes) · https://api.aligned-tech.com/docs/chatbot (read-only API)

### Accounts

> WARNING: these are live production credentials. Rotate before making this repo public or granting external access.

**ALIGNED super-admin** (controls every tenant, `/aligned-admin` access):

- Email: `admin@aligned-tech.com`
- Password: `Tayseer123!Aligned`

**Demo client** (admin of its own `demo-client` org, no super-admin rights — use this to test the client experience):

- Email: `demo@aligned-tech.com`
- Password: `DemoClient123!`

## Repo layout

See [CLAUDE.md](./CLAUDE.md) for the full plan, status, and architecture decisions.

```
apps/api      Fastify REST API
apps/worker   BullMQ workers (imports, syncs, webhook delivery)
apps/web      Next.js 15 client portal + ALIGNED admin
packages/db   Prisma schema, migrations, RLS, seed
packages/shared  Zod schemas + types shared by api and web
packages/config  ESLint, Prettier, tsconfig bases
infra         Caddy, PgBouncer, ops scripts
```
