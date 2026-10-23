# Git providers

All callback and webhook URLs below use your dashboard origin, e.g. `https://skyhost.tech`.

## GitHub (recommended: GitHub App)

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Homepage URL: your dashboard. Callback URL: `https://skyhost.tech/api/v1/git/github/callback`.
   Setup URL (optional): same as the callback, "Redirect on update" checked.
3. Webhook URL: `https://skyhost.tech/api/v1/webhooks/github`, with a random secret.
4. Repository permissions: Contents (read & write, for Auto Fix pull requests), Metadata (read),
   Pull requests (read & write), Commit statuses (read & write), Deployments (read & write).
   Subscribe to events: Push, Pull request, Installation, Installation repositories.
5. Generate a private key and set in `.env`:

```
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=your-app-slug
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----
GITHUB_WEBHOOK_SECRET=<the webhook secret>
```

"Continue with GitHub" sign-in uses an OAuth App (or the App's client credentials):
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, callback `https://skyhost.tech/api/v1/auth/oauth/github/callback`.

## Google sign-in

"Continue with Google" needs an OAuth client (Google Cloud console → APIs & Services → Credentials → OAuth
client ID, type "Web application") with the authorized redirect URI
`https://skyhost.tech/api/v1/auth/oauth/google/callback`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
A Google account is linked to an existing SKYHOST account only when Google reports its email as verified.

## Unconfigured providers

Nothing breaks when a provider is not configured: `GET /api/v1/capabilities` reports it as unavailable, and the
dashboard shows its button or tab with a "Not available yet" label instead of an error. A sign-in link to an
unconfigured provider sends the user back to the sign-in page with a message. A provider needs both its client ID
and its secret to be considered configured.

## GitLab

Create an application (User Settings → Applications, or an instance-wide application) with scopes `api`,
`read_user`, `read_repository` and redirect URIs:

- `https://skyhost.tech/api/v1/git/gitlab/callback` (repository access)
- `https://skyhost.tech/api/v1/auth/oauth/gitlab/callback` (sign-in)

Set `GITLAB_URL` (self-managed instances), `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` and
`GITLAB_WEBHOOK_SECRET`. SKYHOST creates the project webhook
(`https://skyhost.tech/api/v1/webhooks/gitlab`) when you connect a repository.

## Bitbucket

Create an OAuth consumer (Workspace settings → OAuth consumers) with Repositories: Read/Write, Pull requests:
Read/Write, Webhooks: Read/Write, callback `https://skyhost.tech/api/v1/git/bitbucket/callback`. Set
`BITBUCKET_CLIENT_ID`, `BITBUCKET_CLIENT_SECRET` and `BITBUCKET_WEBHOOK_SECRET`; the webhook
(`/api/v1/webhooks/bitbucket`) is created automatically.

## Security

Webhook signatures are verified (HMAC for GitHub and Bitbucket, token for GitLab) and replays are ignored.
Provider tokens are stored encrypted. Users only see repositories their installation or account can access.
