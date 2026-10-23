# Billing and payments

Payments are disabled until `SKYHOST_PAYMENTS_ENABLED=true`. Subscriptions and credits are activated **only by
verified provider webhooks**, never by the browser returning from a checkout page. Every webhook is stored once
(idempotency by provider event id) and processed in order.

## Stripe (cards)

1. Create products and monthly prices for your plans, then copy each price id into Admin → Plans
   (`stripePriceId`).
2. `.env`: `STRIPE_SECRET_KEY=sk_test_…` (use test keys first; live keys are refused outside production).
3. Webhook endpoint: `https://skyhost.tech/api/v1/webhooks/stripe` with the events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.succeeded`,
   `charge.refunded`, `charge.dispute.created`. Put the signing secret in `STRIPE_WEBHOOK_SECRET` (required).
4. Customers manage cards through the Stripe billing portal; plan changes are prorated.

## PayPal

1. Create a REST app (sandbox first). `.env`: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
   `PAYPAL_API_URL` (`https://api-m.sandbox.paypal.com` or `https://api-m.paypal.com`).
2. Create billing plans and copy their ids into Admin → Plans (`paypalPlanId`).
3. Webhook: `https://skyhost.tech/api/v1/webhooks/paypal` with `BILLING.SUBSCRIPTION.*`,
   `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.REFUNDED`, `PAYMENT.CAPTURE.COMPLETED`,
   `PAYMENT.CAPTURE.REFUNDED`, `CUSTOMER.DISPUTE.CREATED`; set `PAYPAL_WEBHOOK_ID`. Signatures are verified
   with PayPal's verification API.

## Mobile Money (Flutterwave)

Prepaid credits can be bought with Mobile Money. `.env`: `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_HASH`;
webhook `https://skyhost.tech/api/v1/webhooks/flutterwave`. Each transaction is re-verified with the
Flutterwave API before credits are added.

## Credits, invoices, taxes

- Prepaid credits (minimum 5 USD) can pay a month of any plan.
- Invoices are numbered sequentially and downloadable as PDF. Tax rates are configured per country in
  Admin → Settings (reverse charge supported).
- Spend caps per team: alert only, block deploys, or pause services.

## Promo codes

Admins create codes in Admin → Settings → Discount codes:

- **Credits** (fixed amount): added to the team's prepaid credits as soon as the code is redeemed.
- **Percentage**: applies once, to the team's next plan payment (Stripe checkout, or a month paid with credits).

Codes are case-insensitive, usable once per team, and can have a maximum number of uses and an expiry date;
the limits are enforced atomically. Teams redeem codes in Billing → Overview; owners and admins only.

## Usage and estimate

Billing → Overview shows the estimated bill for the current period (plan price minus a pending promo code), and
the plan price split across services by the CPU and memory they used. Billing → Usage charts CPU hours, memory
GB-hours, egress and build minutes per day.

## Pay as you go

Admin → Settings → "Pay as you go" bills resource usage like Railway: rates per vCPU-hour, GB-hour of memory, GB of
outbound traffic and build minute (cents, fractions allowed). With "the plan price includes the same amount of
usage", a 5 USD plan covers 5 USD of usage and only the rest is billed. The Billing page shows the running
estimate per resource. Each month, usage beyond the plan becomes an invoice paid from prepaid credits; without
enough credits it stays open and the team enters the usual grace period. Billing starts with the first full month
after the feature is switched on: earlier usage is never billed.

## Failed payments

The team enters a grace period (`billing.graceDays`, default 7) with reminder emails (`dunningDays`). After it
ends the team moves to the free plan limits; nothing is deleted.

## Refunds and disputes

Admins refund from Admin → Payments; the refund is applied when the provider confirms it. Refunds and disputes
cancel the related referral rewards automatically.

## What is tested

The integration tests cover webhook signature verification, idempotency, subscription activation, failed
payments and refunds with signed Stripe test events. Live calls to Stripe, PayPal and Flutterwave (creating
checkout sessions) need your sandbox credentials: test them in sandbox before enabling live mode.
