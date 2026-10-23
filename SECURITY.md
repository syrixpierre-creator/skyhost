# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **"Report a vulnerability"** button (Security tab of
this repository). Do not open a public issue.

Include the affected version or commit, the steps to reproduce, and the impact you observed. We acknowledge
reports within 3 business days and keep you informed until a fix is released. We will credit you in the release
notes unless you prefer otherwise.

Abuse of a site hosted on a SKYHOST installation (phishing, malware, spam) is not a vulnerability: use the
installation's `/report-abuse` page.

## Supported versions

Security fixes are made on the `main` branch and included in the next release. Run `./skyhost update` to apply
them.

## Scope

In scope: the API, workers, dashboard, CLI, installer and the default Docker Compose deployment. Out of scope:
vulnerabilities that require a compromised server or `.env`, third-party services (Stripe, PayPal, Flutterwave,
git providers), denial of service by volume, and installations running customer code with `runc` instead of
gVisor, which the installer flags as unsafe for untrusted code.

## Hardening summary

See [docs/security.md](docs/security.md) for the security model: Argon2id passwords, TOTP 2FA, hashed sessions and
API keys, CSRF protection, role-based access with tenant isolation, AES-256-GCM secrets with a rotatable keyring,
log redaction, SSRF protection, sandboxed (gVisor) and capability-restricted containers, a filtered Docker API,
verified webhooks and an audit log.
