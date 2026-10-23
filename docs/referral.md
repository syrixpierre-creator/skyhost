# Referral program

Every user has a referral link `https://skyhost.tech/r/<code>`. Settings are edited in Admin → Settings
(`referral`). Defaults:

| Setting | Default |
| --- | --- |
| Reward | 20 % of each payment of the referred team for 6 months (`percent`, `recurringMonths`), or a fixed amount (`fixedCents`, 5 USD) |
| Referee bonus | 5 USD of credits for the referred team at its first payment |
| Refund window | 14 days: rewards stay pending, then become approved |
| Minimum payout | 20 USD |
| Maximum rewards | 50 per referrer per month |
| Payout methods | team credits, Stripe Connect, PayPal |

## Fraud protection

Rewards are only created from payments confirmed by provider webhooks. A referral is flagged and its rewards held
when signals match: the same device, IP address, email identity or payment card as the referrer, or a referrer
above the monthly limit. Rewards also wait until the payment is settled. Flagged referrals are reviewed in Admin → Referrals (approve or reject). Refunds
and disputes cancel the related rewards.

## Payouts

Users request a payout from the Referrals page once the available balance reaches the minimum: instantly as team
credits, or as an external payout (Stripe Connect or PayPal) that an administrator sends and marks as paid.
