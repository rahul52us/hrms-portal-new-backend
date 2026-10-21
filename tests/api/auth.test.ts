/**
 * Authentication API tests. Test names start with the TC ID from docs/qa/HRMS_Test_Cases.xlsx
 * so failures can be traced straight back to the QA sheet.
 */
import jwt from "jsonwebtoken";
import {
  startTestEnv, stopTestEnv, resetDatabase, http, login, createCompany, createUser, authHeader, DEFAULT_PASSWORD,
} from "./helpers/testEnv";

// Never send real e-mails from tests.
jest.mock("../../src/config/sendMail/sendMail", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue({ success: true }),
}));

const text = (res: any) => JSON.stringify(res.body);
const hasToken = (res: any) => Boolean(res.body?.data?.authorization_token);

beforeAll(async () => { await startTestEnv(); });
afterAll(async () => { await stopTestEnv(); });
beforeEach(async () => { await resetDatabase(); });

describe("Login", () => {
  test("AUTH-001 login with valid email and password", async () => {
    const user = await createUser({ role: "hr", username: "admin@company.com" });
    const res = await login("admin@company.com", DEFAULT_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.authorization_token).toBe("string");
    expect(res.body.data.role).toBe("hr");
    expect(String(res.body.data.userId)).toBe(String(user._id));
  });

  test("AUTH-002 email is trimmed and lower-cased before login", async () => {
    await createUser({ username: "admin@company.com" });
    const res = await login("  Admin@Company.COM ", DEFAULT_PASSWORD);
    expect(res.status).toBe(200);
    expect(hasToken(res)).toBe(true);
  });

  test("AUTH-003 wrong password is rejected", async () => {
    await createUser({ username: "admin@company.com" });
    const res = await login("admin@company.com", "Wrong@1234");
    expect(res.status).toBe(401);
    expect(hasToken(res)).toBe(false);
  });

  test("AUTH-004 unknown email gives the same message as a wrong password", async () => {
    await createUser({ username: "admin@company.com" });
    const wrong = await login("admin@company.com", "Wrong@1234");
    const unknown = await login("nobody@nowhere.com", "Test@1234");
    expect(unknown.status).toBe(401);
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  test("AUTH-005 empty email is rejected with 'Username is required'", async () => {
    const res = await login("", "Test@1234");
    expect(res.status).toBe(422);
    expect(text(res)).toMatch(/Username is required/);
  });

  test("AUTH-006 empty password is rejected with 'Password is required'", async () => {
    const res = await login("admin@company.com", "");
    expect(res.status).toBe(422);
    expect(text(res)).toMatch(/Password is required/);
  });

  test("AUTH-007 username that is not an email is rejected", async () => {
    const res = await login("adminuser", "Test@1234");
    expect(res.status).toBe(422);
    expect(text(res)).toMatch(/valid email/i);
  });

  test("AUTH-008 password shorter than 8 characters is rejected", async () => {
    const res = await login("admin@company.com", "Ab1cdef");
    expect(res.status).toBe(422);
  });

  test("AUTH-009 password longer than 128 characters is rejected", async () => {
    const res = await login("admin@company.com", "Ab1".repeat(43)); // 129 chars
    expect(res.status).toBe(422);
  });

  test("AUTH-010 disabled user cannot log in", async () => {
    await createUser({ username: "disabled@company.com", enabled: false });
    const res = await login("disabled@company.com", DEFAULT_PASSWORD);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(hasToken(res)).toBe(false);
  });

  test("AUTH-011 invited user without a password cannot log in", async () => {
    await createUser({ username: "new.hire@company.com", password: null });
    const res = await login("new.hire@company.com", DEFAULT_PASSWORD);
    expect(res.status).toBe(403);
    expect(text(res)).toMatch(/password setup is required/i);
    expect(hasToken(res)).toBe(false);
  });

  test("AUTH-012 deleted user cannot log in", async () => {
    await createUser({ username: "deleted@company.com", deleted: true });
    const res = await login("deleted@company.com", DEFAULT_PASSWORD);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(hasToken(res)).toBe(false);
  });
});

describe("Session / token", () => {
  test("AUTH-017 request without token, with garbage token and with unknown user is rejected", async () => {
    const none = await http().post("/api/auth/me");
    expect(none.status).toBe(401);

    const garbage = await http().post("/api/auth/me").set("Authorization", "Bearer abc.def.ghi");
    expect(garbage.status).toBe(401);

    const ghost = jwt.sign({ userId: "507f1f77bcf86cd799439011" }, process.env.SECRET_KEY as string);
    const unknown = await http().post("/api/auth/me").set("Authorization", `Bearer ${ghost}`);
    expect(unknown.status).toBe(401);
  });

  test("AUTH-017 expired token is rejected", async () => {
    const user = await createUser();
    const expired = jwt.sign({ userId: String(user._id) }, process.env.SECRET_KEY as string, { expiresIn: -10 });
    const res = await http().post("/api/auth/me").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  test("AUTH-017 token of a user who was disabled afterwards stops working", async () => {
    const user = await createUser();
    const headers = await authHeader(user);
    await http().post("/api/auth/me").set(headers).expect(200);
    user.is_enabled = false;
    await user.save();
    const res = await http().post("/api/auth/me").set(headers);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Forgot / reset password", () => {
  test("AUTH-018 reset link is created for a registered email", async () => {
    const user = await createUser({ username: "admin@company.com" });
    const res = await http().post("/api/auth/forgot-password").send({ username: "admin@company.com" });
    expect(res.status).toBe(200);
    const Token = (await import("../../src/schemas/Token/Token")).default;
    expect(await Token.countDocuments({ userId: user._id })).toBe(1);
  });

  test("AUTH-018 [security] forgot-password for an unknown email must not reveal that it is unregistered", async () => {
    const res = await http().post("/api/auth/forgot-password").send({ username: "nobody@nowhere.com" });
    // Expected: same generic success as for a registered email. Failing here means e-mail enumeration is possible.
    expect(res.status).toBe(200);
  });

  test("AUTH-019 invalid email format is rejected", async () => {
    const res = await http().post("/api/auth/forgot-password").send({ username: "abc" });
    expect(res.status).toBe(422);
    expect(text(res)).toMatch(/valid email/i);
  });

  test("AUTH-020 empty email is rejected", async () => {
    const res = await http().post("/api/auth/forgot-password").send({ username: "" });
    expect(res.status).toBe(422);
  });

  async function issueResetToken(username = "admin@company.com") {
    const user = await createUser({ username });
    await http().post("/api/auth/forgot-password").send({ username }).expect(200);
    const Token = (await import("../../src/schemas/Token/Token")).default;
    const doc: any = await Token.findOne({ userId: user._id });
    return { user, token: doc.token as string };
  }

  test("AUTH-021 reset with valid token and strong password; new password works, old one does not", async () => {
    const { token } = await issueResetToken();
    const res = await http().post("/api/auth/reset-password").send({ token, password: "NewPass@123" });
    expect(res.status).toBe(200);
    expect((await login("admin@company.com", "NewPass@123")).status).toBe(200);
    expect((await login("admin@company.com", DEFAULT_PASSWORD)).status).toBe(401);
  });

  test("AUTH-022 reset with an unknown token is rejected", async () => {
    const res = await http().post("/api/auth/reset-password").send({ token: "not-a-real-token", password: "NewPass@123" });
    expect(res.status).toBe(400);
    expect(text(res)).toMatch(/invalid token|expired/i);
  });

  test("AUTH-022 [security] reset with an EXPIRED token is rejected", async () => {
    const user = await createUser({ username: "admin@company.com" });
    const Token = (await import("../../src/schemas/Token/Token")).default;
    const expiredJwt = jwt.sign({ userId: String(user._id) }, process.env.SECRET_KEY as string, { expiresIn: -3600 });
    await Token.create({ userId: user._id, token: expiredJwt, type: "forgot_password_token" });
    const res = await http().post("/api/auth/reset-password").send({ token: expiredJwt, password: "NewPass@123" });
    // Expected: 400 (link older than its 24h validity). A 200 means reset links never expire.
    expect(res.status).toBe(400);
  });

  test("AUTH-023 reset link cannot be used twice", async () => {
    const { token } = await issueResetToken();
    await http().post("/api/auth/reset-password").send({ token, password: "NewPass@123" }).expect(200);
    const second = await http().post("/api/auth/reset-password").send({ token, password: "Another@123" });
    expect(second.status).toBe(400);
  });

  const weak: [string, string, string][] = [
    ["AUTH-024", "Pass123", "7 characters"],
    ["AUTH-025", "password1", "no uppercase letter"],
    ["AUTH-026", "PASSWORD1", "no lowercase letter"],
    ["AUTH-027", "Password", "no digit"],
  ];
  test.each(weak)("%s weak password rejected on reset (%s: %s)", async (_id, password) => {
    const { token } = await issueResetToken();
    const res = await http().post("/api/auth/reset-password").send({ token, password });
    expect(res.status).toBe(422);
    expect(text(res)).toMatch(/at least 8 characters/);
  });

  test("AUTH-028 exactly 8 characters with upper, lower and digit is accepted", async () => {
    const { token } = await issueResetToken();
    const res = await http().post("/api/auth/reset-password").send({ token, password: "Abcdef1x" });
    expect(res.status).toBe(200);
  });
});

describe("Set password (invite)", () => {
  async function invitedUser() {
    const user = await createUser({
      username: "new.hire@company.com",
      password: null,
      extra: { setupToken: "setup-token-123", setupTokenExpiry: new Date(Date.now() + 3600_000) },
    });
    return user;
  }

  test("AUTH-029 invited user sets a password and can then log in", async () => {
    await invitedUser();
    const res = await http().post("/api/auth/set-password").send({ token: "setup-token-123", password: "Welcome@123" });
    expect(res.status).toBe(200);
    expect((await login("new.hire@company.com", "Welcome@123")).status).toBe(200);
  });

  test("AUTH-029 expired invite token is rejected", async () => {
    await createUser({
      username: "late@company.com",
      password: null,
      extra: { setupToken: "old-token", setupTokenExpiry: new Date(Date.now() - 1000) },
    });
    const res = await http().post("/api/auth/set-password").send({ token: "old-token", password: "Welcome@123" });
    expect(res.status).toBe(400);
  });

  test("AUTH-030 weak password is rejected on set-password", async () => {
    await invitedUser();
    const res = await http().post("/api/auth/set-password").send({ token: "setup-token-123", password: "abc" });
    expect(res.status).toBe(422);
  });
});

describe("Change password", () => {
  test("AUTH-031 change password with the correct old password", async () => {
    const user = await createUser({ username: "admin@company.com" });
    const res = await http().post("/api/auth/change-password").set(await authHeader(user))
      .send({ oldPassword: DEFAULT_PASSWORD, newPassword: "New@12345" });
    expect(res.status).toBe(200);
    expect((await login("admin@company.com", "New@12345")).status).toBe(200);
    expect((await login("admin@company.com", DEFAULT_PASSWORD)).status).toBe(401);
  });

  test("AUTH-032 wrong old password is rejected and password stays unchanged", async () => {
    const user = await createUser({ username: "admin@company.com" });
    const res = await http().post("/api/auth/change-password").set(await authHeader(user))
      .send({ oldPassword: "Wrong@1234", newPassword: "New@12345" });
    expect(res.status).toBe(400);
    expect((await login("admin@company.com", DEFAULT_PASSWORD)).status).toBe(200);
  });

  test("AUTH-033 new password that fails the strength rule is rejected", async () => {
    const user = await createUser({ username: "admin@company.com" });
    const res = await http().post("/api/auth/change-password").set(await authHeader(user))
      .send({ oldPassword: DEFAULT_PASSWORD, newPassword: "newpassword" });
    expect(res.status).toBe(422);
  });

  test("change password requires a logged-in user", async () => {
    const res = await http().post("/api/auth/change-password").send({ oldPassword: DEFAULT_PASSWORD, newPassword: "New@12345" });
    expect(res.status).toBe(401);
  });
});

describe("Bootstrap first Super Admin", () => {
  const body = { name: "Ravi Owner", username: "owner@co.com", phone: "9876543210", password: "Strong@123" };

  test("AUTH-035 creates the first Super Admin, then refuses a second one", async () => {
    const first = await http().post("/api/auth/bootstrap/superadmin").send(body);
    expect(first.status).toBe(201);
    expect(first.body.data.role).toBe("superadmin");
    expect((await login("owner@co.com", "Strong@123")).status).toBe(200);

    const second = await http().post("/api/auth/bootstrap/superadmin").send({ ...body, username: "other@co.com", phone: "9123456780" });
    expect(second.status).toBe(409);
  });

  test("AUTH-035 wrong setup key is rejected when SUPERADMIN_SETUP_KEY is configured", async () => {
    process.env.SUPERADMIN_SETUP_KEY = "right-key";
    try {
      const res = await http().post("/api/auth/bootstrap/superadmin").send({ ...body, setupKey: "wrong-key" });
      expect(res.status).toBe(403);
    } finally {
      delete process.env.SUPERADMIN_SETUP_KEY;
    }
  });

  test("AUTH-036 phone with 9 digits is rejected", async () => {
    const res = await http().post("/api/auth/bootstrap/superadmin").send({ ...body, phone: "987654321" });
    expect(res.status).toBe(422);
    expect(text(res)).toMatch(/10-digit/);
  });

  test("AUTH-037 name boundary: 1 character rejected, 2 characters accepted", async () => {
    const short = await http().post("/api/auth/bootstrap/superadmin").send({ ...body, name: "A" });
    expect(short.status).toBe(422);
    const ok = await http().post("/api/auth/bootstrap/superadmin").send({ ...body, name: "Al" });
    expect(ok.status).toBe(201);
  });

  test("bootstrap rejects a weak password", async () => {
    const res = await http().post("/api/auth/bootstrap/superadmin").send({ ...body, password: "weakpass" });
    expect(res.status).toBe(422);
  });
});
