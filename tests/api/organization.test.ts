/**
 * Organization setup API tests: office locations and departments.
 * Test names start with the TC ID from docs/qa/HRMS_Test_Cases.xlsx.
 */
import {
  startTestEnv, stopTestEnv, resetDatabase, http, seedRoles, createCompany, createUser, authHeader,
} from "./helpers/testEnv";

const text = (res: any) => JSON.stringify(res.body);

let ctx: Awaited<ReturnType<typeof seedRoles>>;

beforeAll(async () => { await startTestEnv(); });
afterAll(async () => { await stopTestEnv(); });
beforeEach(async () => {
  await resetDatabase();
  ctx = await seedRoles();
});

const location = (over: Record<string, any> = {}) => ({
  name: "Delhi Head Office", code: "del-ho", city: "Delhi", state: "Delhi", country: "India",
  pinCode: "110001", address: "Full office address", latitude: 28.6139, longitude: 77.209, ...over,
});

describe("Office locations", () => {
  test("ORG-010 admin creates an office location (code is upper-cased)", async () => {
    const res = await http().post("/api/locations/create").set(ctx.headers.admin).send(location());
    expect(res.status).toBe(201);
    expect(res.body.data.code).toBe("DEL-HO");
    expect(res.body.data.name).toBe("Delhi Head Office");
  });

  test("ORG-011 name, code and city are required", async () => {
    for (const missing of ["name", "code", "city"]) {
      const res = await http().post("/api/locations/create").set(ctx.headers.admin).send(location({ [missing]: "" }));
      expect(res.status).toBe(400);
      expect(text(res)).toMatch(/Location name, code, and city are required/);
    }
  });

  test("ORG-012 duplicate code or name is rejected (case-insensitive)", async () => {
    await http().post("/api/locations/create").set(ctx.headers.admin).send(location()).expect(201);
    const sameCode = await http().post("/api/locations/create").set(ctx.headers.admin).send(location({ name: "Other", code: "DEL-HO" }));
    expect(sameCode.status).toBe(400);
    expect(text(sameCode)).toMatch(/already exists/);
    const sameName = await http().post("/api/locations/create").set(ctx.headers.admin).send(location({ name: "delhi head office", code: "NEW" }));
    expect(sameName.status).toBe(400);
  });

  test("ORG-013 latitude and longitude must be given together", async () => {
    const res = await http().post("/api/locations/create").set(ctx.headers.admin)
      .send(location({ longitude: undefined }));
    expect(res.status).toBe(422);
    expect(text(res)).toMatch(/provided together/);
  });

  test.each([
    ["latitude 90.1", { latitude: 90.1 }, /Latitude must be between -90 and 90/],
    ["latitude -90.1", { latitude: -90.1 }, /Latitude must be between -90 and 90/],
    ["longitude 180.1", { longitude: 180.1 }, /Longitude must be between -180 and 180/],
    ["longitude -180.1", { longitude: -180.1 }, /Longitude must be between -180 and 180/],
    ["latitude abc", { latitude: "abc" }, /Latitude must be a number/],
  ])("ORG-014 coordinate out of range or not a number is rejected (%s)", async (_label, over, pattern) => {
    const res = await http().post("/api/locations/create").set(ctx.headers.admin).send(location(over as any));
    expect(res.status).toBe(422);
    expect(text(res)).toMatch(pattern as RegExp);
  });

  test("ORG-014 boundary coordinates 90 / 180 are accepted", async () => {
    const res = await http().post("/api/locations/create").set(ctx.headers.admin).send(location({ latitude: 90, longitude: 180 }));
    expect(res.status).toBe(201);
  });

  test("ORG-015 location assigned to employees cannot be deleted", async () => {
    const created = await http().post("/api/locations/create").set(ctx.headers.admin).send(location()).expect(201);
    await createUser({ company: ctx.company, username: "assigned@test.com", extra: { officeLocation: created.body.data._id } });
    const res = await http().delete(`/api/locations/delete/${created.body.data._id}`).set(ctx.headers.admin);
    expect(res.status).toBe(400);
    expect(text(res)).toMatch(/assigned to employees/);
  });

  test("ORG-015 unassigned location can be deleted", async () => {
    const created = await http().post("/api/locations/create").set(ctx.headers.admin).send(location()).expect(201);
    const res = await http().delete(`/api/locations/delete/${created.body.data._id}`).set(ctx.headers.admin);
    expect(res.status).toBe(200);
  });

  test("ORG-016 HR can view but not manage locations", async () => {
    const list = await http().get("/api/locations/list").set(ctx.headers.hr);
    expect(list.status).toBe(200);
    const create = await http().post("/api/locations/create").set(ctx.headers.hr).send(location());
    expect(create.status).toBe(403);
    expect(text(create)).toMatch(/Only superadmin or admin can manage locations/);
  });

  test("ORG-016 plain employee cannot view or manage locations", async () => {
    const list = await http().get("/api/locations/list").set(ctx.headers.user);
    expect(list.status).toBe(403);
    const create = await http().post("/api/locations/create").set(ctx.headers.user).send(location());
    expect(create.status).toBe(403);
  });

  test("ORG-016 locations require login", async () => {
    expect((await http().get("/api/locations/list")).status).toBe(401);
  });

  test("EMP-022 admin of another company cannot change this company's location", async () => {
    const created = await http().post("/api/locations/create").set(ctx.headers.admin).send(location()).expect(201);
    const otherCompany = await createCompany();
    const otherAdmin = await createUser({ role: "admin", company: otherCompany, username: "other-admin@test.com" });
    const res = await http().put(`/api/locations/update/${created.body.data._id}`).set(await authHeader(otherAdmin)).send({ city: "Mumbai" });
    expect(res.status).toBe(403);
  });

  test("superadmin must say which company the location belongs to", async () => {
    const without = await http().post("/api/locations/create").set(ctx.headers.superadmin).send(location());
    expect(without.status).toBe(422);
    const withCompany = await http().post("/api/locations/create").set(ctx.headers.superadmin)
      .send(location({ companyId: String(ctx.company._id) }));
    expect(withCompany.status).toBe(201);
  });

  test("update keeps unchanged fields and rejects bad id", async () => {
    const created = await http().post("/api/locations/create").set(ctx.headers.admin).send(location()).expect(201);
    const ok = await http().put(`/api/locations/update/${created.body.data._id}`).set(ctx.headers.admin).send({ city: "Gurgaon" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.city).toBe("Gurgaon");
    expect(ok.body.data.code).toBe("DEL-HO");
    const bad = await http().put("/api/locations/update/not-an-id").set(ctx.headers.admin).send({ city: "X" });
    expect(bad.status).toBe(400);
  });
});

describe("Departments", () => {
  const createDepartment = (headers: any, over: Record<string, any> = {}) =>
    http().post("/api/department/create").set(headers).send({ departmentName: "Engineering", code: "ENG-01", ...over });

  test("ORG-001 admin creates a department", async () => {
    const res = await createDepartment(ctx.headers.admin);
    expect(res.status).toBe(201);
    expect(res.body.data.departmentName).toBe("Engineering");
  });

  test("ORG-001 department appears in the list", async () => {
    await createDepartment(ctx.headers.admin).expect(201);
    const res = await http().get("/api/department/list").set(ctx.headers.admin);
    expect(res.status).toBe(200);
    expect(text(res)).toMatch(/Engineering/);
  });

  test("ORG-009 HR cannot create departments", async () => {
    const res = await createDepartment(ctx.headers.hr);
    expect(res.status).toBe(403);
    expect(text(res)).toMatch(/Only superadmin or admin can manage departments/);
  });

  test("ORG-009 employee cannot create departments", async () => {
    expect((await createDepartment(ctx.headers.user)).status).toBe(403);
  });

  test("department creation requires login", async () => {
    expect((await http().post("/api/department/create").send({ departmentName: "X", code: "X" })).status).toBe(401);
  });

  test("ORG-001 department without a name is rejected", async () => {
    const res = await createDepartment(ctx.headers.admin, { departmentName: "" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  describe("teams", () => {
    let departmentId: string;
    beforeEach(async () => {
      const created = await createDepartment(ctx.headers.admin).expect(201);
      departmentId = created.body.data._id;
    });

    test("add a team to a department", async () => {
      const res = await http().post(`/api/department/${departmentId}/teams`).set(ctx.headers.admin).send({ name: "Backend" });
      expect(res.status).toBe(201);
      expect(text(res)).toMatch(/Backend/);
    });

    test("ORG-002 duplicate team name inside a department is rejected", async () => {
      await http().post(`/api/department/${departmentId}/teams`).set(ctx.headers.admin).send({ name: "Backend" }).expect(201);
      const res = await http().post(`/api/department/${departmentId}/teams`).set(ctx.headers.admin).send({ name: "backend" });
      expect(res.status).toBe(400);
      expect(text(res)).toMatch(/Team already exists in this department/);
    });

    test("ORG-003 team name is required", async () => {
      const res = await http().post(`/api/department/${departmentId}/teams`).set(ctx.headers.admin).send({ name: "" });
      expect(res.status).toBe(400);
      expect(text(res)).toMatch(/Team name is required/);
    });
  });

  describe("closing (archiving) a department", () => {
    let departmentId: string;
    beforeEach(async () => {
      departmentId = (await createDepartment(ctx.headers.admin).expect(201)).body.data._id;
    });

    test("ORG-007 closure reason shorter than 3 characters is rejected", async () => {
      const res = await http().post(`/api/department/${departmentId}/archive`).set(ctx.headers.admin).send({ reason: "ab" });
      expect(res.status).toBe(422);
      expect(text(res)).toMatch(/at least 3 characters/);
    });

    test("ORG-006 empty department can be archived with a valid reason, then disappears from the list", async () => {
      const res = await http().post(`/api/department/${departmentId}/archive`).set(ctx.headers.admin).send({ reason: "Restructure" });
      expect(res.status).toBe(200);
      const list = await http().get("/api/department/list").set(ctx.headers.admin);
      expect(text(list)).not.toMatch(/ENG-01/);
    });

    test("ORG-006 an already archived department cannot be archived again", async () => {
      await http().post(`/api/department/${departmentId}/archive`).set(ctx.headers.admin).send({ reason: "Restructure" }).expect(200);
      const again = await http().post(`/api/department/${departmentId}/archive`).set(ctx.headers.admin).send({ reason: "Restructure" });
      expect(again.status).toBe(404);
    });

    test("HR cannot archive a department", async () => {
      const res = await http().post(`/api/department/${departmentId}/archive`).set(ctx.headers.hr).send({ reason: "Restructure" });
      expect(res.status).toBe(403);
    });
  });
});
