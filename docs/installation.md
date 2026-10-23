# Installation

## Requirements

- Linux x86_64 or arm64 server, 4 GB RAM minimum (8 GB recommended), 40 GB disk.
- Docker Engine 25+ with the Compose and Buildx plugins.
- Ports 80 and 443 reachable from the Internet (Let's Encrypt HTTP challenge).
- DNS: an `A`/`AAAA` record for the dashboard (`skyhost.tech`) and a wildcard record for applications
  (`*.skyhost.tech`) pointing to the server.
- gVisor (`runsc`) registered with Docker. The installer can install it on Debian/Ubuntu (`--install-gvisor`).

## Install

```bash
git clone https://github.com/syrixpierre-creator/skyhost.git
cd skyhost
sudo ./scripts/install.sh --install-gvisor \
  --domain skyhost.tech \
  --apps-domain skyhost.tech \
  --email syrixcompany@gmail.com
```

What the installer does, in order:

1. Checks Docker, Compose, Buildx and OpenSSL.
2. Creates `.env` from `.env.example` (mode `600`) if it does not exist, and fills **only empty** secrets:
   the encryption keyring, the internal token, the session secret and database passwords. Running it again never
   changes an existing value.
3. Writes the domains and the ACME email given on the command line (or asks for them interactively).
4. Verifies that gVisor is registered with Docker; refuses to continue without it unless `--allow-runc` is given.
5. Builds the images (`--pull` uses published images instead) and starts the stack, then waits for the API
   health check.

Open the dashboard and create an account: **the first account becomes the platform administrator.**

Options: `--http` (no TLS, private networks only), `--observability` (Prometheus, Loki, Promtail, Grafana on
`127.0.0.1:3000`), `--no-start` (only prepare `.env`).

## After installation

1. Configure email (`SMTP_URL`). Without SMTP no email is delivered (verification, invitations, password
   resets, alerts). To test emails locally, start Mailpit (`docker compose --profile mail up -d mailpit`, UI on
   `127.0.0.1:8025`) and set `SMTP_URL=smtp://mailpit:1025`.
2. Configure at least one git provider (see [providers.md](providers.md)).
3. Configure payments if you sell plans (see [billing.md](billing.md)); they stay disabled until
   `SKYHOST_PAYMENTS_ENABLED=true`.
4. Run `./skyhost doctor` and fix anything it reports.
5. Schedule `./skyhost backup` (for example daily with cron) and copy the backups off the server.

## Local evaluation without a domain

```bash
./scripts/install.sh --domain app.skyhost.localhost --apps-domain apps.skyhost.localhost --http --allow-runc
echo "127.0.0.1 app.skyhost.localhost" | sudo tee -a /etc/hosts
```

`runc` gives weaker isolation: do not deploy code you do not trust on such an installation.

## Behind a TLS-intercepting proxy

Image builds can trust an extra CA: `docker build --secret id=build_ca,src=/path/ca.pem …`. For application
builds, give the build worker a BuildKit image or configuration that trusts it (`SKYHOST_BUILDKIT_IMAGE`,
`SKYHOST_BUILDKITD_CONFIG`).
