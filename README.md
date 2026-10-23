# SKYHOST — by SYRIX VISION COMPANY

SKYHOST is a self-hostable platform for deploying applications: connect a repository, let **SmartDeploy** analyse
it, press **Deploy**, and get a live HTTPS URL. Teams, databases, previews, logs, metrics, billing and an
administration console are included.

```
GitHub / GitLab / Bitbucket / Git URL / ZIP / Docker image
        │
        ▼
SmartDeploy analysis ──► BuildKit build (secrets mounted, never baked) ──► tests ──► image
        │                                                                             │
        ▼                                                                             ▼
Smart Error Analyzer ◄── failure                  blue/green release ── health check ── Traefik ── https://app-xxxx.apps.example.com
```

## Features

- **SmartDeploy**: detects Node.js (Next.js, Nuxt, Remix, Astro, NestJS, Express, Vite…), Python (Django, FastAPI,
  Flask), Go, Rust, PHP/Laravel, Java/Spring, static sites, Dockerfiles, monorepos and docker-compose files;
  proposes ports, commands, variables and databases, with a confidence level and an explanation.
- **Zero-downtime deploys**: blue/green releases with health checks, automatic rollback when a deploy fails,
  one-click rollback, canary releases, preview environments for pull requests.
- **Smart Error Analyzer + Auto Fix**: explains failed builds and runtime crashes and proposes a fix (a setting,
  a variable, or a pull request), never applied silently.
- **Managed databases**: PostgreSQL, MariaDB, MongoDB and Redis with credentials rotation, verified backups,
  restore, a read-only data browser and optional public access.
- **Object storage** buckets (S3 API), volumes, cron jobs, one-off jobs, a secure in-container shell.
- **Teams**: roles (owner, admin, developer, member, viewer) with per-team permission overrides, invitations,
  audit log, API keys with scopes, 2FA, sessions management, GDPR export and deletion.
- **Observability**: live build and runtime logs, metrics, uptime checks, alerts, public status pages, automatic
  screenshots of every release.
- **Billing**: plans and quotas, Stripe (cards), PayPal, Mobile Money (Flutterwave), prepaid credits, invoices
  (PDF), spend caps, referral program with fraud checks.
- **Dashboard** in English and French, dark mode by default and light mode, plus a **CLI** (`skyhost`).

## Quick start (single server)

Requirements: a Linux server with Docker Engine 25+, the Compose and Buildx plugins, 4 GB of RAM, ports 80 and
443 open, and DNS records for the dashboard host and a wildcard for applications.

```bash
git clone https://github.com/syrixpierre-creator/skyhost.git && cd skyhost
sudo ./scripts/install.sh --install-gvisor \
  --domain app.example.com --apps-domain apps.example.com --email admin@example.com
```

The installer generates every secret into `.env` (mode 600), checks the container sandbox (gVisor), builds the
images and starts the stack. **The first account created becomes the platform administrator.**

Day-to-day operations:

```bash
./skyhost status     # services and health
./skyhost logs api   # follow logs
./skyhost doctor     # configuration and health checks
./skyhost backup     # PostgreSQL dump + object storage + .env
./skyhost update     # backup, rebuild, migrate, restart
```

See [docs/installation.md](docs/installation.md) and [docs/production.md](docs/production.md).

## CLI

```bash
node apps/cli/dist/skyhost.js login --api-url https://app.example.com   # browser approval (device flow)
skyhost init            # create a project from the current directory and deploy it
skyhost deploy          # upload and deploy, streaming the logs
skyhost logs -f         # runtime logs
skyhost env set KEY=value --secret
skyhost rollback
skyhost shell -c "node --version"
skyhost db create postgres
```

In CI, set `SKYHOST_API_URL`, `SKYHOST_TOKEN` (an API key with the `deploy` scope) and `SKYHOST_TEAM_ID`.

## Repository layout

| Path | Content |
| --- | --- |
| `apps/api` | Fastify API (REST under `/api/v1`, OpenAPI at `/api/docs`, WebSockets, webhooks, Traefik provider) |
| `apps/worker` | BullMQ workers: build, deploy/release, scheduler, screenshots, notifications |
| `apps/web` | React dashboard (Vite, Tailwind, TanStack Query) |
| `apps/cli` | `skyhost` command line interface |
| `packages/analyzer` | SmartDeploy detection, build plans, error analyzer |
| `packages/engine` | Docker/BuildKit builds, hardened runtime, databases, buckets, Traefik configuration |
| `packages/core` | Configuration, queues, billing, quotas, git providers, notifications |
| `packages/db` | Drizzle schema, SQL migrations, seed data |
| `packages/shared` | RBAC, validation schemas, encryption, SSRF protection |
| `infra`, `docker-compose.yml` | Images and the single-server deployment |

## Development

```bash
pnpm install
service postgresql start && service redis-server start   # or run them in containers
cp .env.example .env.development   # adjust DATABASE_URL, REDIS_URL, generate keys
pnpm dev:api & pnpm dev:worker & pnpm dev:web
```

Tests: `pnpm test` (unit + integration), `pnpm test:e2e` (real Docker, Traefik and Playwright),
`pnpm test:web` (dashboard smoke tests). See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

[Architecture](docs/architecture.md) · [Installation](docs/installation.md) · [Configuration](docs/configuration.md) ·
[Production](docs/production.md) · [Deployments](docs/deployment.md) · [Databases](docs/databases.md) ·
[Git providers](docs/providers.md) · [Billing](docs/billing.md) · [Plans](docs/plans.md) · [Referral program](docs/referral.md) ·
[Security](docs/security.md) · [API](docs/api.md) · [Security policy](SECURITY.md)

## License

Apache-2.0. © SYRIX VISION COMPANY.
