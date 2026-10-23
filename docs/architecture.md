# Architecture

```
                 ┌────────────── Internet ──────────────┐
                 ▼                                      ▼
        skyhost.tech                       *.skyhost.tech, custom domains
                 │                                      │
                 └──────────► Traefik (80/443, ACME) ◄──┘
                               │   ▲  dynamic config every 2 s (HTTP provider, internal token)
              dashboard host   │   │
                 ┌─────────────┘   │
                 ▼                 │
          web (nginx, SPA) ── /api ─► api (Fastify) ──► PostgreSQL, Redis
                                       │  ▲
                        BullMQ queues  ▼  │  Redis pub/sub (realtime)
      worker-build ── worker-deploy ── worker-scheduler ── worker-screenshot
            │              │
            └── Docker API (socket proxy, internal network only)
                     │
      team networks ─┴─ customer containers (gVisor), databases, buckets
```

## Components

| Component | Role |
| --- | --- |
| **api** | REST API (`/api/v1`), OpenAPI (`/api/docs`), WebSockets (realtime events, log streams, shell), inbound webhooks (git providers, payments), Traefik HTTP provider and forward-auth gate under `/internal` (token protected). Runs migrations at start. |
| **web** | The dashboard (React SPA) served by nginx, which proxies `/api` to the API on the same origin, so session cookies and CSRF tokens need no CORS. |
| **worker-build** | Clones or extracts the source, runs SmartDeploy, generates the Dockerfile when none exists, builds with BuildKit (variables mounted as a build secret, never stored in layers), runs tests. |
| **worker-deploy** | Releases: starts the new containers, waits for the health check, switches traffic, drains the previous version; database provisioning, backups (each backup is restored into a temporary container to verify it), jobs, notifications and outgoing webhooks. |
| **worker-scheduler** | Cron jobs, backups schedule, metrics collection, crash detection, sleeping idle services, uptime checks, domain verification and certificates, billing grace periods, dunning, spend caps, retention, worker heartbeats. |
| **worker-screenshot** | Chromium (Playwright) screenshots of each release; the browser can only reach the platform proxy and public addresses. |
| **Traefik** | Edge proxy. Its routes come from the API (`buildProxyConfig`): one router per service and environment, custom domains with Let's Encrypt, canary weights, sleeping services routed to the waker, password protection and IP rules through forward-auth. |
| **docker-api** | A filtering proxy in front of the Docker socket, reachable only by the API and the workers on an internal network. Traefik and customer containers never see the socket. |

## Deployment pipeline

1. A trigger (push webhook, dashboard, CLI, API, template, rollback) creates a `deployments` row after checking
   the deploy freeze, the spend cap, quotas and email verification, then enqueues a build.
2. The build worker clones (`file://` and symlinks refused, size limits) or extracts the ZIP (path traversal,
   symlinks and ZIP bombs rejected), analyses the repository and builds the image.
3. The release queue starts the new version without public aliases, waits for the health check, attaches the
   aliases, marks it live, updates Traefik, waits `SKYHOST_PROXY_SWITCH_DELAY_MS` and stops the previous version.
4. Any failure keeps the previous version live. The Smart Error Analyzer stores a diagnosis with the logs.

Phases and log lines are published on Redis channels (`sh:rt:deployment:<id>`) and streamed to the dashboard
and the CLI.

## Tenancy and isolation

- Every team has its own Docker network; services of a team resolve each other as `<service>.internal`.
- Customer containers run with `CapDrop: ALL` plus a minimal set, `no-new-privileges`, pids/memory/CPU limits and
  the `runsc` (gVisor) runtime. `runc` is accepted only when the operator explicitly allows it.
- API access is checked per team, project, service and environment; resources of other teams answer `404`.
- Secrets (variables, database passwords, provider tokens, TOTP secrets) are encrypted with AES-256-GCM using a
  keyring from `SKYHOST_MASTER_KEYS`, with additional authenticated data binding each value to its owner.

## Data

PostgreSQL holds the state (≈60 tables, SQL migrations in `packages/db/migrations`). Redis holds queues, rate
limits, realtime channels and short-lived counters. Objects (uploads, backups, screenshots, log archives) are
encrypted and stored on the `objects` volume or in an S3-compatible service.
