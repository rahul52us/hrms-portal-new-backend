import "dotenv/config";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { spawn, ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import jwt from "jsonwebtoken";
import Project from "../../schemas/project/Project.schema";
import Assignment from "../../schemas/project/ProjectAssignment.schema";
import WorkType from "../../schemas/project/ProjectWorkType.schema";
import Audit from "../../schemas/project/ProjectAuditLog.schema";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import { projectToday } from "./project.utils";

async function startFullApplication(uri: string) {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(process.execPath, ["-r", "ts-node/register", "src/index.ts"], {
    cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, MONGODB_URI: uri, PORT: String(port), VERCEL: "",
      LEAVE_ACCRUAL_SCHEDULER_ENABLED: "false", ATTENDANCE_PROCESSOR_SCHEDULER_ENABLED: "false", PAYROLL_OPERATIONS_SCHEDULER_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output = (output + chunk).slice(-5000); });
  child.stderr?.on("data", (chunk) => { output = (output + chunk).slice(-5000); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 225; attempt++) {
    if (child.exitCode !== null) throw new Error(`Full backend failed to start: ${output}`);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return { child, base };
    } catch { /* Wait for TypeScript compilation and database startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error(`Full backend startup timed out: ${output}`);
}

async function run() {
  const dbName = process.env.PROJECT_TEST_DB || "hrms_projects_test";
  if (!/^hrms_projects_test(?:_[a-z0-9_]+)?$/i.test(dbName)) throw new Error("PROJECT_TEST_DB must start with hrms_projects_test");
  await mongoose.connect(process.env.MONGODB_URI!, { dbName, serverSelectionTimeoutMS: 10000 });
  const company = new mongoose.Types.ObjectId(), otherCompany = new mongoose.Types.ObjectId();
  const admin = new mongoose.Types.ObjectId(), manager = new mongoose.Types.ObjectId(), employee = new mongoose.Types.ObjectId();
  const outsider = new mongoose.Types.ObjectId(), crossTenant = new mongoose.Types.ObjectId();
  const scopedHr = new mongoose.Types.ObjectId();
  const superadmin = new mongoose.Types.ObjectId();
  const fixtures = [admin, manager, employee, outsider, crossTenant, scopedHr, superadmin];
  let application: ChildProcess | undefined;
  try {
    await Promise.all([Project.init(), Assignment.init(), WorkType.init(), Audit.init()]);
    await Company.collection.insertMany([company, otherCompany].map((id) => ({ _id: id,
      type: "company", companyType: "company", departments: [], createdBy: superadmin, activeUser: admin,
      company_name: `Project Test ${id}`, companyCode: `PJTEST-${id}`, tenantSlug: `project-test-${id}`, tenantUrl: `project-test-${id}.example.test`, is_active: true, createdAt: new Date() })));
    await User.collection.insertMany(fixtures.map((id, index) => ({ _id: id, name: `Project fixture ${index}`, code: `PJTEST-${id}`,
      username: `project-${id}@example.test`, company: index === 6 ? null : index === 4 ? otherCompany : company,
      role: index === 0 ? "hradmin" : index === 5 ? "hr" : index === 6 ? "superadmin" : "user", password: "test-fixture-only", is_enabled: true, createdAt: new Date(),
      ...(index === 2 ? { reportingManager: manager, department: "Engineering", team: "Platform" } : {}),
      ...(index === 5 ? { permissions: { manage_projects: true }, hrScope: { departments: ["Engineering"], teams: ["Platform"] } } : {}) })));
    const isolatedUri = new URL(process.env.MONGODB_URI!);
    isolatedUri.pathname = `/${dbName}`;
    const running = await startFullApplication(isolatedUri.toString());
    application = running.child;
    async function call(who: mongoose.Types.ObjectId | null, path: string, method = "GET", body?: any, expected = 200) {
      const token = who ? jwt.sign({ userId: String(who) }, process.env.SECRET_KEY || "@#$4515Rahulkushwa_675@#") : "";
      const route = path.startsWith("/api/") || path === "/courses-debug" || path === "/" ? path : `/api/projects${path}`;
      const response = await fetch(`${running.base}${route}`, { method, headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json() as any;
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
      return data;
    }
    assert.equal((await call(null, "/")).message, "HRMS backend is running");
    for (const route of ["/api/student", "/api/course", "/api/scorm", "/api/batches", "/api/certificates", "/api/dashboard/learner-results", "/courses-debug"]) {
      await call(superadmin, route, "GET", undefined, 404);
    }
    const platform = (await call(superadmin, "/api/dashboard/summary")).data;
    assert.equal(platform.stats.totalCompanies, 2);
    assert.equal(platform.stats.totalEmployees, 6);
    assert.equal("totalCourses" in platform.stats, false);
    await call(employee, "/api/dashboard/summary", "GET", undefined, 403);
    const recipients = (await call(superadmin, `/api/notification/users?companyId=${company}`)).data.users;
    assert.equal(recipients.length, 5);
    assert.equal("notificationSignals" in recipients[0], false);
    await call(superadmin, "/api/notification/send", "POST", { companyId: company, notificationType: "pending_course" }, 400);
    await call(superadmin, "/api/notification/send", "POST", { companyId: company, filters: { courseStatus: "pending" } }, 400);
    await call(null, "/options", "GET", undefined, 401);
    assert.equal((await call(manager, "/options")).data.canCreate, true);
    assert.equal((await call(employee, "/options")).data.canCreate, false);
    await call(outsider, "", "POST", { name: "Forbidden" }, 403);
    await call(manager, "?scope=all", "GET", undefined, 403);
    await call(manager, `?companyId=${otherCompany}`, "GET", undefined, 403);
    assert.equal((await call(scopedHr, "/options")).data.canCreate, true);
    const hrPeople = (await call(scopedHr, "/people?kind=employee")).data.map((person: any) => person._id);
    assert.ok(hrPeople.includes(String(employee)));
    assert.ok(!hrPeople.includes(String(outsider)));
    await call(scopedHr, "?scope=all", "GET", undefined, 403);
    const today = projectToday();
    const created = await call(manager, "", "POST", { name: "Feature Project", startDate: today }, 201);
    const project = created.data;
    let revision = project.revision;
    await call(manager, "", "POST", { name: "Manager takeover", managerIds: [outsider], startDate: today }, 403);
    assert.match(project.code, /^FEATURE_PROJECT_/);
    await call(crossTenant, `/${project._id}`, "GET", undefined, 404);
    await call(outsider, `/${project._id}`, "GET", undefined, 404);
    await call(employee, `/${project._id}`, "PUT", { revision, name: "Hijack", reason: "Forbidden update" }, 403);
    const work = await call(manager, `/${project._id}/work-types`, "POST", { revision, name: "Feature Development" });
    revision = work.revision;
    await call(manager, `/${project._id}/work-types`, "POST", { revision, name: "feature development" }, 409);
    await call(manager, `/${project._id}`, "PUT", { revision: 1, name: "Stale", reason: "Stale update" }, 409);
    await call(manager, `/${project._id}/assignments`, "POST", { revision, employeeIds: [employee, outsider], effectiveFrom: today, reason: "Bad bulk scope" }, 403);
    assert.equal(await Assignment.countDocuments({ company }), 0);
    const assigned = await call(manager, `/${project._id}/assignments`, "POST", { revision, employeeIds: [employee], effectiveFrom: today, reason: "Sprint assignment" }, 201);
    revision = assigned.revision;
    const assignmentId = assigned.data[0]._id;
    await call(manager, `/${project._id}/assignments`, "POST", { revision, employeeIds: [employee], effectiveFrom: today, reason: "Overlap attempt" }, 409);
    assert.equal((await call(employee, "?scope=mine")).data.length, 1);
    assert.equal((await call(outsider, "?scope=mine")).data.length, 0);
    assert.equal((await call(employee, `/${project._id}/assignments`)).data.length, 1);
    await call(employee, `/${project._id}/audit`, "GET", undefined, 403);
    const archived = await call(manager, `/${project._id}/archive`, "POST", { revision, reason: "Archive project" });
    revision = archived.data.revision;
    assert.equal((await call(employee, "?scope=mine")).data.length, 0);
    await call(manager, `/${project._id}/work-types`, "POST", { revision, name: "Meeting" }, 409);
    revision = (await call(manager, `/${project._id}/restore`, "POST", { revision, reason: "Restore project" })).data.revision;
    const ending = await call(manager, `/${project._id}/assignments/${assignmentId}/end`, "POST", { revision, effectiveTo: today, reason: "End assignment" });
    revision = ending.revision;
    assert.equal(ending.data.effectiveTo, today);
    const tomorrow = new Date(`${today}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const next = tomorrow.toISOString().slice(0, 10);
    const future = await call(manager, `/${project._id}/assignments`, "POST", { revision, employeeIds: [employee], effectiveFrom: next, reason: "Next assignment" }, 201);
    revision = future.revision;
    const cancelled = await call(manager, `/${project._id}/assignments/${future.data[0]._id}/end`, "POST", { revision, cancel: true, reason: "Cancel scheduled work" });
    revision = cancelled.revision;
    await call(manager, `/${project._id}/assignments`, "POST", { revision, employeeIds: [employee], effectiveFrom: next, reason: "Replace cancelled assignment" }, 201);
    assert.equal((await call(admin, "?scope=all&limit=1")).pagination.limit, 1);
    assert.ok((await call(manager, `/${project._id}/audit`)).data.length >= 8);
    const projectAfter: any = await Project.findById(project._id).lean();
    const concurrent = await Promise.allSettled([0, 1].map((index) => call(manager, `/${project._id}/work-types`, "POST", { revision: projectAfter.revision, name: `Concurrent ${index}` })));
    assert.equal(concurrent.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(await WorkType.countDocuments({ company, name: /^Concurrent / }), 1);
    await User.collection.updateOne({ _id: manager }, { $set: { permissions: { manage_projects: false } } });
    assert.equal((await call(manager, "/options")).data.canCreate, false);
    assert.equal((await call(manager, `/${project._id}`)).data.canManage, false);
    if (process.argv.includes("--ui")) {
      const token = (id: mongoose.Types.ObjectId) => jwt.sign({ userId: String(id) }, process.env.SECRET_KEY || "@#$4515Rahulkushwa_675@#");
      const ui = spawn(process.execPath, [path.resolve("../scripts/verify-projects-live-ui.cjs")], {
        stdio: "inherit", windowsHide: true, env: { ...process.env, PROJECT_TEST_API_URL: running.base,
          PROJECT_TEST_ADMIN_TOKEN: token(admin), PROJECT_TEST_EMPLOYEE_TOKEN: token(employee),
          PROJECT_TEST_SUPERADMIN_TOKEN: token(superadmin), PROJECT_TEST_EMPLOYEE_NAME: "Project fixture 2" },
      });
      const exit = await new Promise((resolve) => ui.once("exit", resolve));
      assert.equal(exit, 0, "Full-application browser test failed");
    }
    console.log("Full-backend Project tests passed: normal startup, dashboard/notification cleanup, retired routes, auth, tenant isolation, assignment scope, rollback, history, pagination, and concurrency");
  } finally {
    if (application && application.exitCode === null) await new Promise<void>((resolve) => { application!.once("exit", () => resolve()); application!.kill(); });
    for (const model of [Audit, Assignment, WorkType, Project]) await model.deleteMany({ company });
    await User.collection.deleteMany({ _id: { $in: fixtures } });
    await Company.collection.deleteMany({ _id: { $in: [company, otherCompany] } });
    await mongoose.disconnect();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
