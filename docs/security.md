# Security model

## Accounts

- Passwords hashed with Argon2id; login rate limits and temporary lockout after repeated failures.
- TOTP two-factor authentication with single-use recovery codes; teams can require 2FA.
- Sessions in an `HttpOnly`, `SameSite=Lax` cookie (Secure over HTTPS), stored hashed; CSRF tokens on every
  state-changing request; sessions can be listed and revoked; a password change signs out other devices.
- API keys `sky_<prefix>_<secret>`, stored hashed, scoped (`read`, `deploy`, `write`, `admin`), optionally
  limited to a project or service, with expiry, rotation and last-use tracking. A key never exceeds its
  creator's role.
- Support impersonation requires a reason, lasts one hour, is shown as a banner, notified to the user and
  audited on both sides; administrators cannot be impersonated.

## Authorization

Roles: owner, admin, developer, member, viewer, with per-team permission overrides and per-project access.
Every route checks the permission on the resource's team; resources of other teams answer `404` so their
existence is not revealed.

## Secrets

AES-256-GCM with a keyring (`SKYHOST_MASTER_KEYS`), authenticated data binding each ciphertext to its scope (a
variable cannot be swapped into another service). Secrets are redacted from build logs, runtime logs, shell
output and error messages. Build-time variables use BuildKit secret mounts.

## Workloads

- gVisor (`runsc`) sandbox, all capabilities dropped except a minimal set, `no-new-privileges`, CPU, memory and
  pids limits, read-only Docker socket never mounted into customer containers.
- One network per team; the control plane is on separate networks.
- Builds clone with symlinks disabled and size limits; ZIP uploads reject path traversal, symlinks, absolute
  paths and compression bombs.
- The shell runs an allow-list of commands inside the service container, records every command, and closes after
  10 minutes of inactivity.

## Network-facing features

Outgoing requests (webhooks, screenshots, git URLs, uptime checks) are checked against private, loopback,
link-local and metadata address ranges, after DNS resolution (SSRF protection). The screenshot browser can only
reach the platform proxy. Inbound webhooks verify signatures and ignore replays.

## Abuse

Public abuse reports (`/report-abuse`), automatic detection and suspension of crypto-mining processes,
suspension of teams or users by administrators, with every decision recorded.

## Audit

Security-relevant actions (logins, 2FA, keys, members, roles, variables, deploys, billing, admin actions) are
written to the audit log, visible to team admins (Team settings → Audit log, `GET /api/v1/teams/:teamId/audit-logs`).
