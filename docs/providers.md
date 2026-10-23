# Git providers

All callback and webhook URLs below use your dashboard origin, e.g. `https://app.example.com`.

## GitHub (recommended: GitHub App)

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Homepage URL: your dashboard. Callback URL: `https://app.example.com/api/v1/git/github/callback`.
   Setup URL (optional): same as the callback, "Redirect on update" checked.
3. Webhook URL: `https://app.example.com/api/v1/webhooks/github`, with a random secret.
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
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, callback `https://app.example.com/api/v1/auth/oauth/github/callback`.

## GitLab

Create an application (User Settings → Applications, or an instance-wide application) with scopes `api`,
`read_user`, `read_repository` and redirect URIs:

- `https://app.example.com/api/v1/git/gitlab/callback` (repository access)
- `https://app.example.com/api/v1/auth/oauth/gitlab/callback` (sign-in)

Set `GITLAB_URL` (self-managed instances), `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` and
`GITLAB_WEBHOOK_SECRET`. SKYHOST creates the project webhook
(`https://app.example.com/api/v1/webhooks/gitlab`) when you connect a repository.

## Bitbucket

Create an OAuth consumer (Workspace settings → OAuth consumers) with Repositories: Read/Write, Pull requests:
Read/Write, Webhooks: Read/Write, callback `https://app.example.com/api/v1/git/bitbucket/callback`. Set
`BITBUCKET_CLIENT_ID`, `BITBUCKET_CLIENT_SECRET` and `BITBUCKET_WEBHOOK_SECRET`; the webhook
(`/api/v1/webhooks/bitbucket`) is created automatically.

## Security

Webhook signatures are verified (HMAC for GitHub and Bitbucket, token for GitLab) and replays are ignored.
Provider tokens are stored encrypted. Users only see repositories their installation or account can access.
