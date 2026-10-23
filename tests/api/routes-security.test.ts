/**
 * Route-level security checks for every HRMS endpoint.
 *
 * 1. Reads the routing files, finds every route and whether it sits behind `authenticate`.
 * 2. Every protected route must answer 401 when called without a token.
 * 3. Routes with NO authentication are listed; only a short reviewed allow-list may be public.
 * 4. Sensitive endpoints that looked unprotected in code are probed directly.
 *
 * LMS-only routers (courses, scorm, batches, certificates, students) are out of scope.
 */
import { startTestEnv, stopTestEnv, resetDatabase, http, createUser, createCompany } from "./helpers/testEnv";
import { collectRoutes, SAMPLE_ID } from "./helpers/routes";

// Endpoints that are intentionally reachable without a login (login, password reset, first-time setup, e-mail verify).
const REVIEWED_PUBLIC = [
  /^post \/api\/auth\/login\/password$/,
  /^post \/api\/auth\/bootstrap\/superadmin$/,
  /^post \/api\/auth\/set-password$/,
  /^post \/api\/auth\/forgot-password$/,
  /^post \/api\/auth\/reset-password$/,
  /^post \/api\/auth\/contact\/mail$/,
  /^get \/api\/auth\/verify-email\//,
];

const routes = collectRoutes();
const protectedRoutes = routes.filter((r) => r.protectedRoute);
const publicRoutes = routes.filter((r) => !r.protectedRoute);

beforeAll(async () => { await startTestEnv(); });
afterAll(async () => { await stopTestEnv(); });
beforeEach(async () => { await resetDatabase(); });

describe("Route inventory", () => {
  test("SEC-001 routes were discovered from the routing files", () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(protectedRoutes.length).toBeGreaterThan(50);
  });
});

describe("SEC-002 every protected route rejects a request without a token", () => {
  test.each(protectedRoutes.map((r) => [`${r.method.toUpperCase()} ${r.url}`, r] as const))("%s", async (_name, r) => {
    const res = await (http() as any)[r.method](r.url).send({});
    expect(res.status).toBe(401);
  });
});

describe("SEC-003 endpoints without authentication", () => {
  test("only the reviewed public endpoints are reachable without a login", () => {
    const unexpected = publicRoutes
      .map((r) => `${r.method} ${r.url}  (${r.file})`)
      .filter((line) => !REVIEWED_PUBLIC.some((rx) => rx.test(line.split("  (")[0])));
    // If this fails, each listed endpoint has no `authenticate` middleware. Confirm it is meant to be public or protect it.
    expect(unexpected).toEqual([]);
  });
});

describe("SEC-004 sensitive endpoints that look unprotected in code", () => {
  test("GET /api/User/:id does not return a user's data without a token", async () => {
    const company = await createCompany();
    const user = await createUser({ company, username: "private@test.com", name: "Private Person" });
    const res = await http().get(`/api/User/${user._id}`);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/private@test\.com/);
  });

  test("POST /api/auth/create does not create a user without a token", async () => {
    const res = await http().post("/api/auth/create").send({
      name: "Intruder", username: "intruder@test.com", password: "Intruder@123", role: "superadmin",
    });
    expect([401, 403]).toContain(res.status);
    const User = (await import("../../src/schemas/User/User")).default;
    expect(await User.countDocuments({ username: "intruder@test.com" })).toBe(0);
  });

  test("POST /api/company/create does not create a company without a token", async () => {
    const res = await http().post("/api/company/create").send({ company_name: "Ghost Co", companyCode: "GHOST" });
    expect([401, 403]).toContain(res.status);
    const Company = (await import("../../src/schemas/company/Company")).default;
    expect(await Company.countDocuments({ companyCode: "GHOST" })).toBe(0);
  });

  test("GET /api/company/:id does not expose company details without a token", async () => {
    const company = await createCompany();
    const res = await http().get(`/api/company/${company._id}`);
    expect(res.status).toBe(401);
  });

  test("file upload and file view require a login", async () => {
    const upload = await http().post("/api/file/upload").send({});
    expect(upload.status).toBe(401);
    const view = await http().get(`/api/file/view/${SAMPLE_ID}`);
    expect(view.status).toBe(401);
  });

  test("manager hierarchy lookups require a login", async () => {
    const a = await http().get(`/api/User/info/Subordinate/${SAMPLE_ID}`);
    const b = await http().get(`/api/User/getManagers/${SAMPLE_ID}`);
    const c = await http().post("/api/User/info/Subordinate").send({});
    expect([a.status, b.status, c.status]).toEqual([401, 401, 401]);
  });

  test("resume processing requires a login", async () => {
    const res = await http().post("/api/auth/processResume").send({});
    expect(res.status).toBe(401);
  });
});
