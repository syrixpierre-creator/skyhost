# API

The REST API is served under `/api/v1`. The OpenAPI document and an interactive explorer are available at
`/api/docs` on your installation.

## Authentication

- **Dashboard**: session cookie plus the `X-CSRF-Token` header (value of the `sh_csrf` cookie) on
  non-GET requests.
- **Automation**: `Authorization: Bearer sky_<prefix>_<secret>`. Create keys in Account → API keys or Team
  settings → API keys. Scopes: `read`, `deploy`, `write`, `admin`.

Errors use one shape: `{"error": {"code": "not_found", "message": "Project not found", "details": …}}`.

## Common calls

```bash
API=https://app.example.com/api/v1
KEY=sky_xxxxxxxx_yyyyyyyy

# Teams and projects
curl -H "Authorization: Bearer $KEY" $API/teams
curl -H "Authorization: Bearer $KEY" $API/teams/$TEAM/projects

# Deploy the latest commit of a service, then follow the logs
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"environmentId":"'$ENV'"}' $API/services/$SERVICE/deploy
curl -H "Authorization: Bearer $KEY" "$API/deployments/$DEPLOYMENT/logs?after=0"

# Deploy a ZIP archive
curl -X POST -H "Authorization: Bearer $KEY" -F file=@app.zip "$API/services/$SERVICE/deploy-zip?environmentId=$ENV"

# Variables
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"serviceId":"'$SERVICE'","variables":[{"key":"GREETING","value":"hello","secret":false}]}' \
  $API/environments/$ENV/variables

# Roll back
curl -X POST -H "Authorization: Bearer $KEY" $API/deployments/$PREVIOUS/rollback
```

## Realtime

`GET /api/v1/ws` (WebSocket): send `{"op":"subscribe","channel":"deployment:<id>"}`; channels exist for
deployments, services, projects, teams, users and databases. Runtime logs: `/api/v1/services/:id/logs/stream`.
Shell: `/api/v1/services/:id/shell` (send `{"cmd":"…"}`).

## Outgoing webhooks

Projects can register webhooks for events such as `deployment.succeeded`, `deployment.failed`,
`service.crashed`, `domain.verified` or `database.backup.failed`. Each delivery is signed with HMAC-SHA256 in the
`X-Skyhost-Signature` header, retried with backoff, and listed with its response in the dashboard.

## Rate limits

Requests are rate limited per IP and per key (`429` with `Retry-After`). Authentication endpoints have stricter
limits.
