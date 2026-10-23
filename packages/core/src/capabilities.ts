import { serverConfig } from "./config";
import { getSetting } from "./settings";
import { flutterwaveConfigured } from "./billing/flutterwave";
import { paypalConfigured } from "./billing/paypal";
import { stripeConfigured } from "./billing/stripe";

/** Email verification can only be required when emails can actually be delivered. */
export function emailVerificationRequired() {
  const c = serverConfig();
  return c.SKYHOST_REQUIRE_EMAIL_VERIFICATION && !!c.SMTP_URL;
}

/**
 * What this installation can do, given its configuration. The dashboard uses it to show "not available yet"
 * instead of letting users hit an error; the API checks the same flags before calling a provider.
 */
export async function capabilities() {
  const c = serverConfig();
  const maintenance = await getSetting("maintenance");
  return {
    auth: {
      password: true,
      github: !!(c.GITHUB_CLIENT_ID && c.GITHUB_CLIENT_SECRET),
      google: !!(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET),
      gitlab: !!(c.GITLAB_CLIENT_ID && c.GITLAB_CLIENT_SECRET),
    },
    git: {
      github: !!(c.GITHUB_APP_ID && c.GITHUB_APP_SLUG && c.GITHUB_APP_PRIVATE_KEY),
      gitlab: !!(c.GITLAB_CLIENT_ID && c.GITLAB_CLIENT_SECRET),
      bitbucket: !!(c.BITBUCKET_CLIENT_ID && c.BITBUCKET_CLIENT_SECRET),
    },
    payments: {
      enabled: c.SKYHOST_PAYMENTS_ENABLED,
      stripe: c.SKYHOST_PAYMENTS_ENABLED && stripeConfigured(),
      paypal: c.SKYHOST_PAYMENTS_ENABLED && paypalConfigured(),
      mobileMoney: c.SKYHOST_PAYMENTS_ENABLED && flutterwaveConfigured(),
    },
    email: { delivery: !!c.SMTP_URL, verificationRequired: emailVerificationRequired() },
    support: { email: c.SKYHOST_SUPPORT_EMAIL || null },
    maintenance: maintenance.enabled ? { enabled: true, message: maintenance.message, blockDeploys: maintenance.blockDeploys, closeDashboard: maintenance.closeDashboard, endsAt: maintenance.endsAt } : { enabled: false },
  };
}

export type Capabilities = Awaited<ReturnType<typeof capabilities>>;
