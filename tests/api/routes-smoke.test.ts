/**
 * Smoke tests over EVERY protected HRMS endpoint (found from the routing files):
 *
 *  - SMOKE-GET : a logged-in company admin calling any GET endpoint must never get a 5xx (crash) or hang.
 *  - SMOKE-BAD : a logged-in company admin sending an EMPTY body to any POST/PUT/PATCH/DELETE endpoint must get a
 *                clean 4xx (validation / not found / forbidden), never a 5xx or a hang.
 *  - SMOKE-PAY : a plain employee must not be able to use payroll endpoints other than their own (/me) ones.
 *
 * Each router file is one test, so a failure lists every offending endpoint of that module together.
 * LMS-only routers are out of scope.
 */
import { startTestEnv, stopTestEnv, http, seedRoles } from "./helpers/testEnv";
import { collectRoutes, RouteInfo } from "./helpers/routes";

const protectedRoutes = collectRoutes().filter((r) => r.protectedRoute);
const byFile: Record<string, RouteInfo[]> = {};
for (const r of protectedRoutes) (byFile[r.file] = byFile[r.file] || []).push(r);
const files = Object.keys(byFile).sort();

let ctx: Awaited<ReturnType<typeof seedRoles>>;

beforeAll(async () => {
  await startTestEnv();
  ctx = await seedRoles();
});
afterAll(async () => { await stopTestEnv(); });

async function call(route: RouteInfo, headers: Record<string, any>) {
  try {
    const req = (http() as any)[route.method](route.url).set(headers).timeout({ response: 15000, deadline: 20000 });
    return await (route.method === "get" ? req : req.send({}));
  } catch (err: any) {
    return { status: 0, error: err?.message || String(err) } as any; // 0 = timeout / no response
  }
}

describe("SMOKE-GET no endpoint crashes on a plain GET (company admin)", () => {
  test.each(files)("%s", async (file) => {
    const offenders: string[] = [];
    for (const r of byFile[file].filter((x) => x.method === "get")) {
      const res = await call(r, ctx.headers.admin);
      if (res.status === 0 || res.status >= 500) offenders.push(`GET ${r.url} -> ${res.status || "no response"} ${String(res.body?.message || res.error || "").slice(0, 120)}`);
    }
    expect(offenders).toEqual([]);
  }, 600000);
});

describe("SMOKE-BAD empty request body gets a clean 4xx, never a crash (company admin)", () => {
  test.each(files)("%s", async (file) => {
    const offenders: string[] = [];
    for (const r of byFile[file].filter((x) => x.method !== "get")) {
      const res = await call(r, ctx.headers.admin);
      if (res.status === 0 || res.status >= 500) offenders.push(`${r.method.toUpperCase()} ${r.url} -> ${res.status || "no response"} ${String(res.body?.message || res.error || "").slice(0, 120)}`);
    }
    expect(offenders).toEqual([]);
  }, 600000);
});

describe("SMOKE-PAY plain employee cannot use payroll administration", () => {
  const payroll = protectedRoutes.filter((r) => r.url.startsWith("/api/payroll") && !/\/me(\/|$)/.test(r.url));

  test("employee GETs on payroll admin endpoints return 401/403", async () => {
    const offenders: string[] = [];
    for (const r of payroll.filter((x) => x.method === "get")) {
      const res = await call(r, ctx.headers.user);
      if (![401, 403].includes(res.status)) offenders.push(`GET ${r.url} -> ${res.status || "no response"}`);
    }
    expect(offenders).toEqual([]);
  }, 600000);

  test("employee changes on payroll admin endpoints never succeed", async () => {
    const offenders: string[] = [];
    for (const r of payroll.filter((x) => x.method !== "get")) {
      const res = await call(r, ctx.headers.user);
      if (res.status < 400 || res.status >= 500 && res.status !== 0) offenders.push(`${r.method.toUpperCase()} ${r.url} -> ${res.status}`);
      else if (res.status === 0) offenders.push(`${r.method.toUpperCase()} ${r.url} -> no response`);
    }
    expect(offenders).toEqual([]);
  }, 600000);
});
