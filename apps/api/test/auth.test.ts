import { describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { outbox } from "@skyhost/core";
import { Client, newUser, PASSWORD, uniqueEmail } from "./helpers";

describe("authentication", () => {
  it("signs up, keeps a session, logs out", async () => {
    const { client, email } = await newUser();
    const me = await client.get("/api/v1/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email, emailVerified: true, twoFactorEnabled: false });
    expect(client.cookies.get("sh_session")).toBeTruthy();
    expect((await client.post("/api/v1/auth/logout")).status).toBe(200);
    expect((await client.get("/api/v1/auth/me")).status).toBe(401);
  });

  it("validates input and refuses duplicates and missing terms", async () => {
    const c = new Client();
    expect((await c.post("/api/v1/auth/signup", { email: "bad", password: "x", name: "a", acceptTerms: true })).status).toBe(400);
    const email = uniqueEmail();
    expect((await c.post("/api/v1/auth/signup", { email, password: PASSWORD, name: "A", acceptTerms: false })).status).toBe(400);
    expect((await c.post("/api/v1/auth/signup", { email, password: PASSWORD, name: "A", acceptTerms: true })).status).toBe(201);
    expect((await new Client().post("/api/v1/auth/signup", { email, password: PASSWORD, name: "A", acceptTerms: true })).status).toBe(409);
  });

  it("stores Argon2id hashes and uses secure cookies", async () => {
    const { user, client } = await newUser();
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    const res = await new Client().post("/api/v1/auth/login", { email: user.email, password: PASSWORD });
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/sh_session=.*HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    void client;
  });

  it("requires the CSRF header for cookie-authenticated writes", async () => {
    const { client } = await newUser();
    const res = await client.post("/api/v1/teams", { name: "No CSRF" }, { "x-csrf-token": "wrong" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("csrf");
  });

  it("locks the account progressively after repeated failures", async () => {
    const { email } = await newUser();
    const c = new Client();
    for (let i = 0; i < 5; i++) expect((await c.post("/api/v1/auth/login", { email, password: "wrong-password-1" })).status).toBe(401);
    const locked = await c.post("/api/v1/auth/login", { email, password: PASSWORD });
    expect(locked.status).toBe(429);
  });

  it("does not reveal whether an email exists on login or password reset", async () => {
    const c = new Client();
    const a = await c.post("/api/v1/auth/login", { email: uniqueEmail("ghost"), password: "whatever-123" });
    expect(a.status).toBe(401);
    expect(a.body.error.message).toBe("Invalid email or password");
    expect((await c.post("/api/v1/auth/forgot-password", { email: uniqueEmail("ghost") })).status).toBe(200);
  });

  it("resets the password through the emailed link and revokes sessions", async () => {
    const { client, email } = await newUser();
    await new Client().post("/api/v1/auth/forgot-password", { email });
    const mail = [...outbox].reverse().find((m) => m.to === email && /Reset/.test(m.subject))!;
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    const newPassword = "brand-new-password-7";
    expect((await new Client().post("/api/v1/auth/reset-password", { token, password: newPassword })).status).toBe(200);
    expect((await new Client().post("/api/v1/auth/reset-password", { token, password: newPassword })).status).toBe(400);
    expect((await client.get("/api/v1/auth/me")).status).toBe(401);
    expect((await new Client().post("/api/v1/auth/login", { email, password: newPassword })).status).toBe(200);
  });

  it("supports TOTP 2FA with single-use recovery codes", async () => {
    const { client, email } = await newUser();
    const setup = await client.post("/api/v1/account/2fa/setup");
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png/);
    const secret = setup.body.secret as string;
    expect((await client.post("/api/v1/account/2fa/enable", { code: "000000" })).status).toBe(400);
    const enabled = await client.post("/api/v1/account/2fa/enable", { code: authenticator.generate(secret) });
    expect(enabled.status).toBe(200);
    const codes = enabled.body.recoveryCodes as string[];
    expect(codes).toHaveLength(10);

    const c2 = new Client();
    const step1 = await c2.post("/api/v1/auth/login", { email, password: PASSWORD });
    expect(step1.body).toMatchObject({ twoFactorRequired: true });
    expect(c2.cookies.get("sh_session")).toBeUndefined();
    expect((await c2.post("/api/v1/auth/2fa/login", { challenge: step1.body.challenge, code: "123456" })).status).toBe(401);
    const ok = await c2.post("/api/v1/auth/2fa/login", { challenge: step1.body.challenge, code: authenticator.generate(secret) });
    expect(ok.status).toBe(200);

    const c3 = new Client();
    const s3 = await c3.post("/api/v1/auth/login", { email, password: PASSWORD });
    expect((await c3.post("/api/v1/auth/2fa/login", { challenge: s3.body.challenge, code: codes[0] })).status).toBe(200);
    const c4 = new Client();
    const s4 = await c4.post("/api/v1/auth/login", { email, password: PASSWORD });
    expect((await c4.post("/api/v1/auth/2fa/login", { challenge: s4.body.challenge, code: codes[0] })).status).toBe(401);
  });

  it("lists and revokes sessions (connected devices)", async () => {
    const { client, email } = await newUser();
    const other = new Client();
    await other.post("/api/v1/auth/login", { email, password: PASSWORD });
    const list = await client.get("/api/v1/account/sessions");
    expect(list.body.sessions.length).toBe(2);
    const otherSession = list.body.sessions.find((s: { current: boolean }) => !s.current);
    expect((await client.del(`/api/v1/account/sessions/${otherSession.id}`)).status).toBe(200);
    expect((await other.get("/api/v1/auth/me")).status).toBe(401);
    expect((await client.get("/api/v1/auth/me")).status).toBe(200);
  });

  it("CLI device flow hands out an API key exactly once", async () => {
    const { client, teamId } = await newUser();
    const cli = new Client();
    const start = await cli.post("/api/v1/auth/cli/start");
    expect((await cli.post("/api/v1/auth/cli/poll", { deviceCode: start.body.deviceCode })).body.status).toBe("pending");
    expect((await client.post("/api/v1/auth/cli/approve", { userCode: start.body.userCode, teamId })).status).toBe(200);
    const done = await cli.post("/api/v1/auth/cli/poll", { deviceCode: start.body.deviceCode });
    expect(done.body.status).toBe("approved");
    expect(done.body.apiKey).toMatch(/^sky_/);
    expect((await cli.post("/api/v1/auth/cli/poll", { deviceCode: start.body.deviceCode })).body.status).toBe("expired");
    cli.bearer = done.body.apiKey;
    expect((await cli.get("/api/v1/auth/me")).status).toBe(200);
  });

  it("exports personal data (GDPR)", async () => {
    const { client, email } = await newUser();
    const res = await client.get("/api/v1/account/export");
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2/);
  });
});
