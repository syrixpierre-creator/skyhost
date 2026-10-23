import { defineConfig } from "@playwright/test";

/**
 * UI smoke tests against the real API (Postgres + Redis required) and the production build served by `vite preview`.
 * The preview server proxies /api to the API, exactly like the nginx container does in production.
 */
const API_PORT = Number(process.env.SKYHOST_UI_API_PORT ?? 4310);
const WEB_PORT = Number(process.env.SKYHOST_UI_WEB_PORT ?? 4311);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

const apiEnv: Record<string, string> = {
  NODE_ENV: "test",
  PORT: String(API_PORT),
  HOST: "127.0.0.1",
  DATABASE_URL: process.env.SKYHOST_UI_DATABASE_URL ?? "postgres://skyhost:skyhost@127.0.0.1:5432/skyhost_ui",
  REDIS_URL: process.env.SKYHOST_UI_REDIS_URL ?? "redis://127.0.0.1:6379/14",
  SKYHOST_MASTER_KEYS: "k1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  SKYHOST_INTERNAL_TOKEN: "ui-test-internal-token-123456",
  SKYHOST_SESSION_SECRET: "ui-test-session-secret-123456789",
  SKYHOST_DASHBOARD_URL: WEB_URL,
  SKYHOST_API_URL: WEB_URL,
  SKYHOST_API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`,
  SKYHOST_BASE_DOMAIN: "skyhost.test",
  SKYHOST_PUBLIC_SCHEME: "http",
  SKYHOST_TLS: "false",
  SKYHOST_RATE_LIMIT: "100000",
  STORAGE_DRIVER: "fs",
  STORAGE_FS_ROOT: "/tmp/skyhost-ui-objects",
  SKYHOST_WORK_DIR: "/tmp/skyhost-ui-work",
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: WEB_URL, trace: "retain-on-failure" },
  webServer: [
    {
      command: "node e2e/reset-db.mjs && pnpm --filter @skyhost/api exec tsx src/index.ts",
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      env: apiEnv,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --strictPort --port ${WEB_PORT}`,
      url: WEB_URL,
      env: { SKYHOST_API_DEV_URL: `http://127.0.0.1:${API_PORT}` },
      timeout: 180_000,
      reuseExistingServer: false,
    },
  ],
});
