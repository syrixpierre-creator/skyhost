# Plans and quotas

Plans are stored in the database and edited in Admin → Plans (prices, limits, features, provider price ids,
trial days, visibility). The seed creates:

| Plan | Price / month | Projects | Services | Databases | vCPU | RAM | Storage | Members | Previews |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Free | 0 | 1 | 2 | 1 | 1 | 1 GB | 2 GB | 1 | 0 |
| Starter | $5 | 5 | 5 | 2 | 3 | 3 GB | 10 GB | 3 | 2 |
| Pro | $15 | 20 | 20 | 5 | 8 | 16 GB | 50 GB | 10 | 10 |
| Business | $30 | 100 | 100 | 20 | 32 | 64 GB | 200 GB | 50 | 50 |
| Enterprise | contact sales | 1000 | 1000 | 200 | 64 | 256 GB | 1 TB | 1000 | 500 |

Other limits: build minutes, bandwidth, deployments per day, volumes, buckets and bucket storage, cron jobs,
screenshots, log and backup retention. Features (sleep, canary, previews, WAF, access protection, public database access, uptime monitoring, object storage…) are booleans.

## Enforcement

- Creating a resource checks the quota first and returns a clear message with the current usage.
- Deploys check the plan, the spend cap and the deploy freeze.
- A downgrade is refused while usage exceeds the target plan, listing what to reduce; nothing is deleted
  automatically.
- Usage is visible in Billing; the scheduler warns teams when they reach 80 % of a limit.
