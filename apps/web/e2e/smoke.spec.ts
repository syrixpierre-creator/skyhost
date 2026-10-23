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
  // Light mode is the default; dark mode is chosen in Account → Appearance and persists.
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.goto("/account");
  await page.getByRole("tab", { name: "Appearance" }).click();
  await page.getByRole("radio", { name: /Dark/ }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: /theme/i }).click();
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

test("phones get a full menu; sign out lives in the account page; English by default", async ({ browser }) => {
  // A French phone still starts in English: the language only changes when the user picks it.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-FR", isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await login(page);
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Billing" })).toBeHidden();
  await page.getByRole("button", { name: "Open menu" }).click();
  const menu = page.getByRole("dialog", { name: "Menu" });
  await expect(menu.getByRole("link", { name: "Templates" })).toBeVisible();
  await menu.getByRole("link", { name: "Billing" }).click();
  await expect(page).toHaveURL(/\/billing$/);
  await expect(page.getByRole("dialog", { name: "Menu" })).toHaveCount(0);
  // No horizontal scrolling on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Sign out is in the account page, not in the header.
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});

test("a standalone database shows its connection details right away", async ({ page }) => {
  await login(page);
  await page.goto("/databases/new");
  for (const engine of ["PostgreSQL", "MySQL (MariaDB)", "MongoDB", "Redis"]) await expect(page.getByRole("button", { name: new RegExp(`^${engine.replace(/[()]/g, "\\$&")}`) })).toBeVisible();
  await page.getByRole("button", { name: /^MongoDB/ }).click();
  await page.getByLabel("Name").fill("orders");
  await page.getByRole("button", { name: "Create database" }).click();
  await expect(page).toHaveURL(/\/databases\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Hostname")).toBeVisible();
  await expect(page.getByText("Internal URL")).toBeVisible();
  await expect(page.getByText("External URL")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable public access" })).toBeVisible();
});

test("maintenance closes the site to users while administrators keep working", async ({ page, browser }) => {
  await login(page); // the first account: platform administrator
  const setMaintenance = (body: Record<string, unknown>) =>
    page.evaluate(async (b) => {
      const csrf = document.cookie.split("; ").find((c) => c.startsWith("sh_csrf="))?.split("=")[1] ?? "";
      return (await fetch("/api/v1/admin/settings/maintenance", { method: "PUT", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(b) })).status;
    }, body);
  expect(await setMaintenance({ enabled: true, closeDashboard: true, message: "Upgrading the servers." })).toBe(200);
  try {
    // The administrator keeps the dashboard.
    await page.goto("/billing");
    await expect(page.getByText("Estimated bill this period")).toBeVisible();
    // A visitor sees the maintenance page on sign in and sign up.
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto("/login");
    await expect(visitor.getByRole("heading", { name: "We'll be back soon" })).toBeVisible();
    await expect(visitor.getByText("Upgrading the servers.")).toBeVisible();
    await expect(visitor.getByLabel("Email")).toHaveCount(0);
    await visitor.goto("/signup");
    await expect(visitor.getByRole("heading", { name: "We'll be back soon" })).toBeVisible();
    // The administrator can still open the sign-in form from it.
    await visitor.goto("/login");
    await visitor.getByRole("button", { name: "Administrator sign-in" }).click();
    await expect(visitor.getByLabel("Email")).toBeVisible();
  } finally {
    expect(await setMaintenance({ enabled: false, closeDashboard: false, message: "" })).toBe(200);
  }
});

test("on a phone, page sections are a menu instead of a hidden row of tabs", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await login(page);
  await page.goto("/account");
  const menu = page.getByLabel("Section");
  await expect(menu).toBeVisible();
  await menu.selectOption({ label: "Appearance" });
  await expect(page.getByRole("radio", { name: /Dark/ })).toBeVisible();
  await ctx.close();
});

test("visitors get the public home page with pricing; signed-in users get their dashboard", async ({ browser, page }) => {
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto("/");
  await expect(visitor.getByRole("heading", { name: "Push your code. Get a live URL." })).toBeVisible();
  await expect(visitor.getByRole("heading", { name: "Simple pricing" })).toBeVisible();
  await expect(visitor.getByText("Starter", { exact: true })).toBeVisible();
  await visitor.getByRole("link", { name: "Deploy for free" }).click();
  await expect(visitor).toHaveURL(/\/signup$/);
  await login(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Push your code. Get a live URL." })).toHaveCount(0);
});

test("a user opens a support ticket and follows the thread", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Support" }).first().click();
  await expect(page.getByText("No tickets yet")).toBeVisible();
  await page.getByRole("button", { name: "New ticket" }).first().click();
  await page.getByLabel("Subject").fill("My app returns 502");
  await page.getByLabel("Message").fill("The web service of my project shows Bad Gateway.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(/\/support\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "My app returns 502" })).toBeVisible();
  await expect(page.getByText("Waiting for support")).toBeVisible();
  await page.getByLabel("Reply").fill("Extra detail: it started after the last deploy.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByText("Extra detail: it started after the last deploy.")).toBeVisible();
  await page.getByRole("button", { name: "Close ticket" }).click();
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();
});

test("public documentation: index, search, articles in English and French", async ({ browser }) => {
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto("/docs");
  await expect(visitor.getByRole("heading", { name: "Documentation", exact: true })).toBeVisible();
  await visitor.getByLabel("Search the documentation").fill("Bad Gateway");
  await expect(visitor.getByRole("main").getByRole("link")).toHaveCount(1);
  await visitor.getByRole("main").getByRole("link", { name: /Troubleshooting/ }).click();
  await expect(visitor).toHaveURL(/\/docs\/troubleshooting$/);
  await expect(visitor.getByRole("heading", { name: "Bad Gateway (502)" })).toBeVisible();
  await expect(visitor.locator("code", { hasText: "process.env.PORT" }).first()).toBeVisible();
  await visitor.getByRole("link", { name: "Custom domains" }).first().click();
  await expect(visitor.getByText("_skyhost-challenge.www.example.com")).toBeVisible();
  await visitor.evaluate(() => localStorage.setItem("sh-lang", "fr"));
  await visitor.goto("/docs/custom-domains");
  await expect(visitor.getByRole("heading", { name: "Domaines personnalisés" })).toBeVisible();
});
