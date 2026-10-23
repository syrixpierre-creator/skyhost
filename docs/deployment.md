# Deployments

## Sources

| Source | How |
| --- | --- |
| GitHub, GitLab, Bitbucket | Connect the provider, pick a repository and a branch. Pushes deploy automatically; pull requests create preview environments when enabled. |
| Public Git URL | Any `https://` repository. Private hosts and local paths are refused (SSRF protection). |
| ZIP archive | Upload in the dashboard, `skyhost deploy`, or `POST /api/v1/services/:id/deploy-zip`. |
| Docker image | Any public image, or a private one with registry credentials (stored encrypted). |
| Template | A ready-made stack (Templates page). |

## Templates

Templates deploy starters from the `templates/` folder of this repository (Next.js + PostgreSQL, Express + Redis,
a WhatsApp bot, a Vite static site) or public images (WordPress, n8n). Set `SKYHOST_TEMPLATES_REPO` to a fork to
customise them.

## SmartDeploy

The analyzer reads the repository (never executes it) and proposes: the runtime and framework, install, build
and start commands, the port, a health-check path, required environment variables (from `.env.example`, code
and framework conventions), databases it needs (from dependencies and docker-compose), the services of a
monorepo, and a confidence level with the reasons. Every value can be changed before deploying.

When the repository has a Dockerfile it is used as is; otherwise SKYHOST generates one (multi-stage, non-root
user, exec-form commands, static sites served by nginx on port 8080).

## Variables

Variables are encrypted. Secret variables are hidden in the dashboard and in logs (redacted). They are available
at build time through a BuildKit secret mount (never written into an image layer) and at runtime as environment
variables. References such as `${{db.DATABASE_URL}}` or `${{api.PORT}}` are resolved at deploy time. The editor
works as a table or as JSON, and variables can be imported/exported as `.env` files, copied between
environments, or shared through team variable groups.

## Releases

- **Blue/green**: the new version must pass its health check before receiving traffic; the old one is drained.
- **Failure**: the previous version keeps serving; the diagnosis explains what happened and may propose an Auto
  Fix (a setting, a variable, or a pull request with a code change — never committed silently).
- **Rollback**: any previous successful version, from the dashboard or `skyhost rollback`.
- **Canary**: send a percentage of traffic to a new version, then promote or abort.
- **Sleep**: on plans that allow it, idle services sleep and wake on the first request.
- **Deploy freeze**: team admins can block deployments during a period.
- **Deploy hooks**: Service → Settings → Deploy hooks creates a secret URL; a `POST` to it deploys the service in
  the chosen environment (CI pipelines, CMS publish buttons). The URL is shown once and can be revoked.
- **Maintenance page**: Service → Settings → Maintenance page answers visitors with HTTP 503 and your message
  while the application keeps running. It applies on save, without a redeploy.
- **Platform maintenance**: administrators (Admin → Settings) can show a banner to every user and pause new
  deployments; rollbacks stay allowed and running services are not affected. "Put the site in maintenance" also
  closes the dashboard: users and visitors see a maintenance page on sign in, sign up and every page (the API
  answers 503), while administrators keep full access. Hosted apps, webhooks and deploy hooks keep working.

## Domains

Each service gets `https://<service>-<id>.<base-domain>`. Custom domains are verified through DNS (TXT record),
then served with a Let's Encrypt certificate. Redirects, password protection, IP allow-lists and rate limits are
configured per service.

## Logs, metrics, screenshots

Build and deploy logs are kept with the deployment (download available). Runtime logs stream live (secrets
redacted). CPU, memory and network metrics are collected per service. A screenshot of each release is
captured automatically and can be shared with an expiring link.
