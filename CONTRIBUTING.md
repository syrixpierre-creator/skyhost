# Contributing

Thank you for helping improve SKYHOST.

## Setup

Requirements: Node.js 22, pnpm 10 (`corepack enable`), PostgreSQL 16+, Redis 7, Docker with Buildx (for the
engine and end-to-end tests).

```bash
pnpm install
createdb skyhost && createdb skyhost_test     # user/password used by the tests: skyhost/skyhost
pnpm dev:api      # http://localhost:4000
pnpm dev:worker
pnpm dev:web      # http://localhost:5173 (proxies /api to the API)
```

The API needs a configuration in the environment: start from `.env.example` and set `DATABASE_URL`, `REDIS_URL`,
`SKYHOST_MASTER_KEYS` (`k1:$(openssl rand -base64 32)`), `SKYHOST_INTERNAL_TOKEN`, `SKYHOST_SESSION_SECRET`,
`SKYHOST_DASHBOARD_URL=http://localhost:5173`, `SKYHOST_API_URL=http://localhost:5173` and, on a laptop without
gVisor, `SKYHOST_CONTAINER_RUNTIME=runc`.

## Tests

| Command | What it runs |
| --- | --- |
| `pnpm typecheck` | TypeScript in every package |
| `pnpm test` | Unit tests (shared, analyzer with its fixture corpus, engine, CLI) and API integration tests against PostgreSQL and Redis |
| `pnpm --filter @skyhost/engine test` | Includes Docker tests (builds, hardened runtime, databases backup/restore, buckets) when Docker is available |
| `pnpm test:e2e` | Full platform: real Docker builds, Traefik routing, databases, zero-downtime releases, rollbacks, screenshots, API keys and the CLI binary |
| `pnpm test:web` | Dashboard smoke tests with Playwright against the real API and the production build |

New features need tests at the level where they can break: unit tests for pure logic, integration tests for API
behaviour and permissions (including cross-team access returning 404), end-to-end tests for anything that touches
Docker or the proxy.

## Rules

- Never simulate a feature: if it cannot work without a provider or credentials, say so in the UI and the docs.
- Secrets never reach logs, error messages, images or the repository. Use the encryption helpers and the
  redactor.
- Validate every input with zod, check permissions with the `authz` helpers, and audit security-relevant actions.
- UI: one accent colour (`--color-accent`), dark mode by default and light mode, no gradients or glow.
  User-facing strings belong in `apps/web/src/locales` (English and French). Navigation, authentication and
  shared components are translated; several dashboard pages still contain English-only text and need migrating.
- Database changes: update `packages/db/src/schema.ts`, then run `pnpm db:generate` to create the next migration
  and its journal entry in `packages/db/migrations`. Never edit a migration that has been released.

## Pull requests

Keep pull requests focused, describe the behaviour change and how you tested it, and make sure `pnpm typecheck`
and `pnpm test` pass.
