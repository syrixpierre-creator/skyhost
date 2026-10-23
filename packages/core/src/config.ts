import { z } from "zod";

const bool = (d: boolean) =>
  z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? d : v === "true" || v === "1"));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  SKYHOST_MASTER_KEYS: z.string().min(1),
  SKYHOST_INTERNAL_TOKEN: z.string().min(16),
  SKYHOST_SESSION_SECRET: z.string().min(16),
  /** Public URL of the dashboard, e.g. https://app.skyhost.app */
  SKYHOST_DASHBOARD_URL: z.string().url(),
  /** Public URL of the API, e.g. https://api.skyhost.app */
  SKYHOST_API_URL: z.string().url(),
  /** Internal URL Traefik uses to reach the API (waker / forward auth). */
  SKYHOST_API_INTERNAL_URL: z.string().url().default("http://api:4000"),
  /** Internal URL of the dashboard container that Traefik routes the dashboard host to (empty: not routed by Traefik). */
  SKYHOST_DASHBOARD_UPSTREAM: z.string().default(""),
  SKYHOST_BASE_DOMAIN: z.string().default("skyhost.app"),
  SKYHOST_PUBLIC_SCHEME: z.enum(["http", "https"]).default("https"),
  SKYHOST_TLS: bool(true),
  SKYHOST_CERT_RESOLVER: z.string().default("letsencrypt"),
  /** Cert resolver for *.base-domain (DNS challenge). Empty = HTTP challenge per host. */
  SKYHOST_WILDCARD_CERT_RESOLVER: z.string().default(""),
  SKYHOST_REGION: z.string().default("eu-west"),
  SKYHOST_COOKIE_DOMAIN: z.string().optional(),
  SKYHOST_PAYMENTS_ENABLED: bool(false),
  SKYHOST_REQUIRE_EMAIL_VERIFICATION: bool(true),

  SMTP_URL: z.string().default(""),
  MAIL_FROM: z.string().default("SKYHOST <no-reply@skyhost.app>"),

  GITHUB_APP_ID: z.string().default(""),
  GITHUB_APP_SLUG: z.string().default(""),
  GITHUB_APP_PRIVATE_KEY: z.string().default(""),
  GITHUB_WEBHOOK_SECRET: z.string().default(""),
  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GITLAB_URL: z.string().default("https://gitlab.com"),
  GITLAB_CLIENT_ID: z.string().default(""),
  GITLAB_CLIENT_SECRET: z.string().default(""),
  GITLAB_WEBHOOK_SECRET: z.string().default(""),
  BITBUCKET_CLIENT_ID: z.string().default(""),
  BITBUCKET_CLIENT_SECRET: z.string().default(""),
  BITBUCKET_WEBHOOK_SECRET: z.string().default(""),

  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  PAYPAL_CLIENT_ID: z.string().default(""),
  PAYPAL_CLIENT_SECRET: z.string().default(""),
  PAYPAL_WEBHOOK_ID: z.string().default(""),
  PAYPAL_API_URL: z.string().default("https://api-m.sandbox.paypal.com"),
  FLUTTERWAVE_SECRET_KEY: z.string().default(""),
  FLUTTERWAVE_WEBHOOK_HASH: z.string().default(""),
  FLUTTERWAVE_API_URL: z.string().default("https://api.flutterwave.com/v3"),
  BILLING_CURRENCY: z.string().default("usd"),

  SAML_ENABLED: bool(false),
});

export type ServerConfig = z.infer<typeof schema> & {
  isProd: boolean;
  isTest: boolean;
};

let cached: ServerConfig | null = null;

export function serverConfig(): ServerConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === "production") {
    // Live payments must never be enabled without a webhook secret, and dev keys never reach production.
    if (c.SKYHOST_PAYMENTS_ENABLED && c.STRIPE_SECRET_KEY && !c.STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET is required when payments are enabled");
  }
  if (c.NODE_ENV !== "production" && c.STRIPE_SECRET_KEY.startsWith("sk_live_")) {
    throw new Error("Live Stripe keys are not allowed outside production; use sandbox keys (sk_test_...)");
  }
  cached = { ...c, isProd: c.NODE_ENV === "production", isTest: c.NODE_ENV === "test" };
  return cached;
}

export function resetServerConfig() {
  cached = null;
}
