# Running in production

## Checklist

- [ ] gVisor (`runsc`) registered with Docker and `SKYHOST_CONTAINER_RUNTIME=runsc`.
- [ ] HTTPS: `SKYHOST_PUBLIC_SCHEME=https`, `SKYHOST_TLS=true`, a real `ACME_EMAIL`, DNS records in place.
- [ ] `.env` is `chmod 600`, owned by root, and backed up somewhere safe: **without `SKYHOST_MASTER_KEYS`,
      encrypted variables, credentials and backups cannot be recovered.**
- [ ] SMTP configured, email verification enabled.
- [ ] A git provider configured with its webhook secret.
- [ ] Payments: sandbox tested end to end, then live keys and webhook secrets; `SKYHOST_PAYMENTS_ENABLED=true`.
- [ ] `./skyhost backup` scheduled and copied off-site; a restore rehearsed on another machine.
- [ ] Firewall: only 22, 80 and 443 open (plus the public database port range if you offer it).
- [ ] `./skyhost doctor` passes.
- [ ] Observability profile enabled, Grafana reachable through an SSH tunnel only.

## Updates

```bash
./skyhost update
```

The command pulls the repository, takes a backup, rebuilds the images and restarts the stack. Database
migrations run when the API starts; running deployments are not interrupted because customer containers are
independent of the control plane.

## Backups

`./skyhost backup` writes `backups/<timestamp>/` with a PostgreSQL dump, an archive of the object storage
(customer database backups, uploads, screenshots) and a copy of `.env`. Customer databases are additionally
backed up on their own schedule by the platform, and every backup is verified by restoring it into a
temporary container.

Restore on a fresh server: install SKYHOST, copy the backup directory, then `./skyhost restore backups/<timestamp>`.
Restore the original `.env` first so the encryption keys match.

### Off-site copies

With `OFFSITE_S3_*` set (Cloudflare R2, Backblaze B2, AWS S3…), every customer database backup is also copied
off the server, and the scheduler uploads a daily dump of the SKYHOST database (`platform/skyhost-<date>.dump`).
Copies older than `OFFSITE_RETENTION_DAYS` (14) are deleted. Admin → Overview shows the last copy and any error,
and administrators get an email when a copy fails. Copies are encrypted with `SKYHOST_MASTER_KEYS`: keep a copy
of `.env` in a password manager. For Cloudflare R2 use the endpoint `https://<account>.r2.cloudflarestorage.com`
and `OFFSITE_S3_REGION=auto`.

## Capacity

One build at a time needs about 2 CPUs and 4 GB RAM (`SKYHOST_BUILD_*`). Plan limits (CPU, memory, storage)
are enforced per team; keep the sum of what you sell below the server capacity or add nodes.

## Multiple nodes

Run additional `worker-build` / `worker-deploy` containers on other Docker hosts, pointing at the same
PostgreSQL and Redis, with a shared registry (`--profile registry`, `SKYHOST_REGISTRY`) so built images are
available everywhere. Each node registers a heartbeat visible in Admin → Overview.

## Monitoring

Admin → Overview shows the server's disk, memory, load and any SKYHOST container that is stopped or unhealthy.
Every 5 minutes the scheduler checks them and emails administrators (at most every 6 hours per alert) when the disk
passes 85% (critical at 95%), memory 90%, the load 3 per CPU, or a component is down.


With `--profile observability`, Prometheus scrapes `/internal/metrics` (deployments by status, instances by
state, teams, failing uptime checks) and Traefik metrics; Loki collects the control-plane container logs;
Grafana is provisioned with both data sources. The public platform status page is `/status`.
