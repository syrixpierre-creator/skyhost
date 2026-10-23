# Configuration

All configuration comes from environment variables, normally from `.env` (see `.env.example`, which documents
every variable). The API validates its configuration at start and refuses to boot when a required value is
missing or unsafe.

## Required

| Variable | Description |
| --- | --- |
| `DATABASE_URL`, `REDIS_URL` | Set by `docker-compose.yml` from `POSTGRES_PASSWORD` / `REDIS_PASSWORD`. |
| `SKYHOST_MASTER_KEYS` | Encryption keyring `id:base64(32 bytes)[,id:key…]`. The first key encrypts; all keys decrypt. |
| `SKYHOST_INTERNAL_TOKEN` | Shared secret between Traefik, the workers and the API's `/internal` endpoints. |
| `SKYHOST_SESSION_SECRET` | Session signing secret. |
| `SKYHOST_DASHBOARD_URL` | Public dashboard URL. The API is served on the same origin under `/api`. |
| `SKYHOST_API_URL` | Public API base URL (normally the same as the dashboard). |
| `SKYHOST_BASE_DOMAIN` | Wildcard domain for applications: `<service>-<id>.<base>`, previews `pr-<n>-<service>-<id>.<base>`. |

## Domains and TLS

`SKYHOST_PUBLIC_SCHEME`, `SKYHOST_TLS`, `ACME_EMAIL`, `SKYHOST_CERT_RESOLVER` (HTTP challenge, per host) and
`SKYHOST_WILDCARD_CERT_RESOLVER` (optional DNS-challenge resolver for the wildcard). `SKYHOST_PUBLIC_IPV4/IPV6`
are shown in the custom-domain instructions. `SKYHOST_COOKIE_DOMAIN` is only needed when the dashboard spans
several hosts.

Cookies are marked `Secure` whenever the dashboard URL uses HTTPS.

## Builds and runtime

| Variable | Default | Description |
| --- | --- | --- |
| `SKYHOST_CONTAINER_RUNTIME` | `runsc` | OCI runtime for customer containers. |
| `SKYHOST_BUILD_RUNTIME` | runtime | Runtime of build sandboxes. |
| `SKYHOST_BUILD_TIMEOUT` | `1800` | Seconds before a build is stopped. |
| `SKYHOST_BUILD_MEMORY_MB`, `SKYHOST_BUILD_CPUS` | `4096`, `2` | Build limits. |
| `SKYHOST_BUILD_CONCURRENCY` | `2` | Parallel builds per build worker. |
| `SKYHOST_BUILDX_BUILDER` | (compose: `skyhost`) | Named BuildKit builder (docker-container driver), created on first use. |
| `SKYHOST_BUILDKIT_IMAGE`, `SKYHOST_BUILDKITD_CONFIG` | | Pin BuildKit, registry mirrors, private CA. |
| `SKYHOST_REGISTRY` | | Push images to a registry (multi-node). |
| `SKYHOST_PROXY_SWITCH_DELAY_MS` | | Delay between switching traffic and stopping the previous version. |
| `SKYHOST_NOFILE_LIMIT` | `65536` | Open files limit of containers (`0` keeps the daemon default). |
| `SKYHOST_PIDS_LIMIT` | `512` | Processes per container. |
| `SKYHOST_DATABASE_PUBLIC_HOST` | `db.<base>` | Host name for databases with public access. |
| `SKYHOST_DB_PUBLIC_PORT_MIN/MAX` | | Port range for public database access. |
| `SKYHOST_BUCKET_IMAGE` | `versity/versitygw:v1.0.16` | S3 server image used for customer buckets. |

## Storage

`STORAGE_DRIVER=fs` (default) stores encrypted objects under `STORAGE_FS_ROOT` (the `objects` volume).
`STORAGE_DRIVER=s3` requires `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` and optionally `S3_BUCKET`,
`S3_REGION`. Objects are encrypted before upload in both cases.

## Email, git providers, payments

See `SMTP_URL`, `MAIL_FROM`, `SKYHOST_REQUIRE_EMAIL_VERIFICATION` (only enforced when `SMTP_URL` is set: without
email delivery nobody could verify); `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`/
`GOOGLE_CLIENT_SECRET`, `GITLAB_CLIENT_ID`/`GITLAB_CLIENT_SECRET` for sign-in; [providers.md](providers.md);
[billing.md](billing.md). Every optional integration can be left empty: the dashboard shows it as
"Not available yet".

## Rotating the encryption key

1. Generate a key: `openssl rand -base64 32`.
2. Prepend it: `SKYHOST_MASTER_KEYS=k2:<new>,k1:<old>` and restart (`./skyhost up`). New data uses `k2`; old
   data stays readable with `k1`.
3. Keep `k1` until every value has been rewritten (for example after rotating database credentials and
   re-saving variables). Never remove a key that still protects data.
