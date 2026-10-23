import { expect, test, type Page } from "@playwright/test";

const stamp = Date.now();
const email = `ui-${stamp}@example.com`;
const memberEmail = `ui-member-${stamp}@example.com`;
const password = "Sup3r-secret-pass";

async function signup(page: Page, address = email, name = "Ada Tester") {
  await page.goto("/signup");
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Email").fill(address);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe.configure({ mode: "serial" });

test("public pages render without a session", async ({ page }) => {
  await page.goto("/status");
  await expect(page.getByRole("heading", { name: "SKYHOST status" })).toBeVisible();
  await expect(page.getByText("API")).toBeVisible();
  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: "Terms of service" })).toBeVisible();
  await page.goto("/this-does-not-exist");
  await expect(page.getByText("This page does not exist.")).toBeVisible();
  // Protected pages redirect to sign in and keep the target.
  await page.goto("/billing");
  await expect(page).toHaveURL(/\/login\?next=%2Fbilling/);
});

test("abuse report form submits to the API", async ({ page }) => {
  await page.goto("/report-abuse");
  await page.getByLabel("URL").fill("https://phish-abcdef.skyhost.test/login");
  await page.getByLabel("Description").fill("This page imitates a bank login form.");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("Our team reviews every report")).toBeVisible();
});

async function login(page: Page, address = email) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(address);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("sign up, dashboard, theme and language", async ({ page }) => {
  // The database is fresh: the first account becomes the platform administrator.
  await signup(page);
  // No SMTP in this environment: email verification cannot be required, so no banner asks for it.
  await expect(page.getByText("Verify your email address to deploy.")).toHaveCount(0);
  // Dark mode is the default; the toggle switches to light and persists.
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: /theme/i }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  // French translation
  await page.getByRole("button", { name: /^(Language|Langue)$/ }).click();
  await expect(page.getByRole("link", { name: "Facturation" })).toBeVisible();
  await page.getByRole("button", { name: /^(Language|Langue)$/ }).click();
  await expect(page.getByRole("link", { name: "Billing" })).toBeVisible();
});

test("sign-in ignores an external ?next target", async ({ page, baseURL }) => {
  await page.goto("/login?next=//evil.example/steal");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
});

test("account, billing, team settings, templates and referrals pages load real data", async ({ page }) => {
  await login(page);

  await page.goto("/billing");
  await expect(page.getByText("Estimated bill this period")).toBeVisible();
  await expect(page.getByLabel("Promo code")).toBeVisible();
  await page.getByRole("tab", { name: "Plans" }).click();
  await expect(page.getByText("Starter", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Usage" }).click();
  await expect(page.getByText("Plan limits")).toBeVisible();
  // Payment providers are not configured here: they are shown as not available, not as errors.
  await page.getByRole("tab", { name: "Payment methods" }).click();
  await expect(page.getByText("Not available yet").first()).toBeVisible();

  await page.goto("/account");
  await page.getByRole("tab", { name: "Security" }).click();
  await page.getByRole("button", { name: "Set up 2FA" }).click();
  await expect(page.getByAltText("2FA QR code")).toBeVisible();

  await page.getByRole("tab", { name: "Sessions" }).click();
  await expect(page.getByText("This device")).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("tab", { name: "Members" }).click();
  await expect(page.getByText(email)).toBeVisible();

  await page.goto("/templates");
  await expect(page.getByText("Next.js + PostgreSQL")).toBeVisible();

  await page.goto("/referrals");
  await expect(page.getByText("Your referral link")).toBeVisible();
  await expect(page.getByText(/\/r\/[a-z0-9]+/)).toBeVisible();

});

test("administration console", async ({ page }) => {
  await login(page);
  await page.goto("/admin");
  await expect(page.getByText("Running instances")).toBeVisible();
  await page.getByRole("link", { name: "Users" }).last().click();
  await expect(page.getByText(email)).toBeVisible();
  await page.getByRole("link", { name: "Plans" }).click();
  await expect(page.getByText("business", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Abuse" }).click();
  await expect(page.getByText("This page imitates a bank login form.")).toBeVisible();
});

test("regular users cannot open the administration console", async ({ page }) => {
  await signup(page, memberEmail, "Grace Member");
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  await page.goto("/admin");
  await expect(page.getByText("reserved to SKYHOST administrators")).toBeVisible();
});

test("the dashboard is fully usable in French", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: /^(Language|Langue)$/ }).click();
  await page.goto("/billing");
  await expect(page.getByText("Facture estimée pour cette période")).toBeVisible();
  await page.getByRole("tab", { name: "Moyens de paiement" }).click();
  await expect(page.getByText("Pas encore disponible").first()).toBeVisible();
  await page.goto("/account");
  await page.getByRole("tab", { name: "Sécurité" }).click();
  await expect(page.getByRole("button", { name: "Configurer la 2FA" })).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("tab", { name: "Membres" })).toBeVisible();
  await page.getByRole("button", { name: /^(Language|Langue)$/ }).click();
  await expect(page.getByRole("tab", { name: "Members" })).toBeVisible();
});

test("new project wizard shows the GitHub, ZIP and template sources", async ({ page }) => {
  await login(page);
  await page.goto("/new");
  await expect(page.getByText(/GitHub/).first()).toBeVisible();
  await expect(page.getByText(/ZIP/i).first()).toBeVisible();
});
