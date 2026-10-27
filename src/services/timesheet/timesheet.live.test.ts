import "dotenv/config";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import path from "node:path";
import { createServer } from "node:net";
import { spawn, ChildProcess } from "node:child_process";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import EmployeeHistory from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import Department from "../../schemas/Department/Department.schema";
import OfficeLocation from "../../schemas/OfficeLocation/OfficeLocation.schema";
import Schedule from "../../schemas/WorkforcePolicy/WorkSchedule.schema";
import ScheduleVersion from "../../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
import Calendar from "../../schemas/WorkforcePolicy/HolidayCalendar.schema";
import CalendarVersion from "../../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
import WorkforceAssignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import Policy from "../../schemas/WorkforcePolicy/TimesheetPolicy.schema";
import PolicyVersion from "../../schemas/WorkforcePolicy/TimesheetPolicyVersion.schema";
import PolicyAudit from "../../schemas/WorkforcePolicy/WorkforcePolicyAuditLog.schema";
import Project from "../../schemas/project/Project.schema";
import WorkType from "../../schemas/project/ProjectWorkType.schema";
import ProjectAssignment from "../../schemas/project/ProjectAssignment.schema";
import Attendance from "../../schemas/Attendance/AttendanceRecord.schema";
import Leave from "../../schemas/Leave/LeaveRequest.schema";
import Timesheet from "../../schemas/Timesheet/Timesheet.schema";
import Revision from "../../schemas/Timesheet/TimesheetRevision.schema";
import { addDateDays, dateInZone, localInstant } from "./timesheet.utils";
import { loadMyTimesheetPlanner } from "./timesheetPlanner.service";

async function startBackend(uri: string) {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(process.execPath, ["-r", "ts-node/register", "src/index.ts"], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, MONGODB_URI: uri, PORT: String(port), VERCEL: "", LEAVE_ACCRUAL_SCHEDULER_ENABLED: "false", ATTENDANCE_PROCESSOR_SCHEDULER_ENABLED: "false", PAYROLL_OPERATIONS_SCHEDULER_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (c) => { output = (output + c).slice(-5000); });
  child.stderr?.on("data", (c) => { output = (output + c).slice(-5000); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 225; attempt++) {
    if (child.exitCode !== null) throw new Error(`Backend startup failed: ${output}`);
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).status === 200) return { child, base }; } catch { /* Wait for normal startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill(); throw new Error(`Backend startup timed out: ${output}`);
}

async function run() {
  const dbName = process.env.TIMESHEET_TEST_DB || "hrms_timesheets_test";
  if (!/^hrms_timesheets_test(?:_[a-z0-9_]+)?$/i.test(dbName)) throw new Error("TIMESHEET_TEST_DB must start with hrms_timesheets_test");
  await mongoose.connect(process.env.MONGODB_URI!, { dbName, serverSelectionTimeoutMS: 10000 });
  const id = () => new mongoose.Types.ObjectId();
  const company = id(), otherCompany = id(), admin = id(), employee = id(), otherEmployee = id(), outsider = id();
  const department = id(), location = id(), team = id();
  const project = id(), workType = id(), secondType = id();
  const schedule = id(), calendar = id();
  const timezone = "Asia/Kolkata", today = dateInZone(new Date(), timezone), day = addDateDays(today, -2), from = addDateDays(day, -10);
  let application: ChildProcess | undefined;
  const policies = "/api/workforce-policies/timesheet-policies";
  const daily = `/api/timesheets/day/${day}`;
  const models = [Policy, PolicyVersion, PolicyAudit, Project, WorkType, ProjectAssignment, Timesheet, Revision, WorkforceAssignment];
  try {
    await Promise.all(models.map((model) => model.init()));
    await Company.collection.insertMany([company, otherCompany].map((_id) => ({ _id, type: "company", companyType: "company", company_name: `Timesheet ${_id}`, companyCode: `TS-${_id}`, tenantSlug: `ts-${_id}`, tenantUrl: `ts-${_id}.example.test`, departments: [], activeUser: admin, createdBy: admin, is_active: true })));
    await User.collection.insertMany([admin, employee, otherEmployee, outsider].map((_id, index) => ({ _id, company: index === 3 ? otherCompany : company, role: index === 0 ? "hradmin" : "user", name: `Timesheet employee ${index}`, code: `TS-${_id}`, username: `ts-${_id}@example.test`, password: "fixture-only", is_enabled: true, joiningDate: new Date(`${from}T00:00:00Z`), createdAt: new Date(`${from}T00:00:00Z`), department: "Engineering", team: "Platform", officeLocation: location, reportingManager: admin })));
    await Department.collection.insertOne({ _id: department, company, departmentName: "Engineering", code: "ENG", teams: [{ _id: team, name: "Platform", isActive: true }] });
    await OfficeLocation.collection.insertOne({ _id: location, company, name: "Delhi", code: "DEL", deletedAt: null });
    await EmployeeHistory.collection.insertMany([admin, employee, otherEmployee].map((_id) => ({ company, employee: _id, effectiveFrom: new Date(`${from}T00:00:00Z`), effectiveTo: null, department, departmentNameSnapshot: "Engineering", teamId: team, teamNameSnapshot: "Platform", officeLocation: location, officeLocationNameSnapshot: "Delhi", reportingManager: admin })));
    const scheduleVersion = id(), calendarVersion = id();
    await Schedule.collection.insertOne({ _id: schedule, company, name: "Day shift", code: "DAY", status: "active" });
    await ScheduleVersion.collection.insertOne({ _id: scheduleVersion, company, schedule, versionNumber: 1, status: "published", effectiveFrom: new Date(`${from}T00:00:00Z`), rules: { timezone, workingDays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], saturdayRule: "all_working", startTime: "09:30", endTime: "18:30", unpaidBreakMinutes: 60, defaultWorkMode: "remote" } });
    await Calendar.collection.insertOne({ _id: calendar, company, name: "Holidays", code: "HOL", status: "active" });
    await CalendarVersion.collection.insertOne({ _id: calendarVersion, company, calendar, versionNumber: 1, status: "published", effectiveFrom: new Date(`${from}T00:00:00Z`), timezone, holidays: [] });
    await WorkforceAssignment.collection.insertMany([{ resourceType: "work_schedule", resourceModel: "WorkSchedule", resource: schedule }, { resourceType: "holiday_calendar", resourceModel: "HolidayCalendar", resource: calendar }].map((item) => ({ ...item, company, scopeType: "company", scopeId: null, scopeNameSnapshot: "Company", priority: 100, effectiveFrom: new Date(`${from}T00:00:00Z`), effectiveTo: null, changeReason: "Fixture", createdBy: admin })));
    await Project.create({ _id: project, company, name: "HRMS", code: "HRMS", managers: [admin], startDate: from, createdBy: admin, updatedBy: admin });
    await WorkType.create([{ _id: workType, company, project, name: "Development", code: "DEV", createdBy: admin, updatedBy: admin }, { _id: secondType, company, project, name: "Meetings", code: "MEET", createdBy: admin, updatedBy: admin }]);
    await ProjectAssignment.create({ company, project, employee, employeeNameSnapshot: "Timesheet employee 1", effectiveFrom: from, changeReason: "Fixture", createdBy: admin });
    await Attendance.create({ company, employee, attendanceDate: day, timezone, workMode: "remote", state: "calculated", status: "present", revisionNumber: 1, workedMinutes: 540,
      punchSessions: [{ punchIn: localInstant(day, "09:30", timezone), punchOut: localInstant(day, "18:30", timezone), source: "import" }] });
    const uri = new URL(process.env.MONGODB_URI!); uri.pathname = `/${dbName}`;
    const running = await startBackend(uri.toString()); application = running.child;
    const token = (who: any) => jwt.sign({ userId: String(who) }, process.env.SECRET_KEY || "@#$4515Rahulkushwa_675@#");
    async function call(who: any, url: string, method = "GET", body?: any, expected = 200) {
      const response = await fetch(`${running.base}${url}`, { method, headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer ${token(who)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const data = await response.json() as any;
      assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(data)}`);
      return data;
    }
    await call(null, daily, "GET", undefined, 401);
    assert.ok((await call(employee, daily)).data.eligibility.setupIssues.some((i: any) => i.code === "MISSING_TIMESHEET_POLICY"));
    await call(employee, policies, "POST", { name: "Denied" }, 403);
    await call(admin, policies, "POST", { name: "Bad rules", code: "BAD", effectiveFrom: from, rules: { minuteIncrement: 0 } }, 422);
    assert.equal(await Policy.countDocuments({ company }), 0, "Invalid draft must roll back policy identity");
    const created = (await call(admin, policies, "POST", { name: "Timesheet policy", code: "TIMESHEET", effectiveFrom: from }, 201)).data;
    const policyId = created.policy._id, versionId = created.version._id;
    await call(outsider, `${policies}/${policyId}`, "GET", undefined, 403);
    await call(admin, `${policies}/${policyId}/versions`, "POST", { effectiveFrom: from, changeReason: "Another draft" }, 409);
    await call(admin, `${policies}/${policyId}/versions/${versionId}`, "PUT", { revision: 99, rules: {} }, 409);
    await call(admin, `${policies}/${policyId}/versions/${versionId}/publish`, "POST", { revision: 1 });
    await call(admin, `${policies}/${policyId}/versions/${versionId}`, "PUT", { revision: 2, rules: {} }, 409);
    const assignmentBody = { resourceType: "timesheet_policy", resourceId: policyId, scopeType: "company", effectiveFrom: from, changeReason: "Enable timesheets" };
    await call(admin, "/api/workforce-policies/assignments", "POST", assignmentBody, 201);
    await call(admin, "/api/workforce-policies/assignments", "POST", assignmentBody, 409);
    await call(admin, `${policies}/${policyId}/archive`, "POST", { reason: "Cannot archive assigned policy" }, 409);
    const effective = (await call(employee, daily)).data;
    assert.equal(effective.requiredMinutes, 480); assert.equal(effective.eligibility.canSave, true);
    assert.equal(effective.context.attendance.workMode, "remote");
    await ScheduleVersion.updateOne({ _id: scheduleVersion }, { $set: { "rules.startTime": "99:00" } });
    assert.ok((await call(employee, daily)).data.eligibility.setupIssues.some((i: any) => i.code === "MISSING_WORK_SCHEDULE"));
    await ScheduleVersion.updateOne({ _id: scheduleVersion }, { $set: { "rules.startTime": "09:30", "rules.timezone": "Invalid/Timezone" } });
    assert.ok((await call(employee, daily)).data.eligibility.setupIssues.some((i: any) => i.code === "MISSING_WORK_SCHEDULE"));
    await ScheduleVersion.updateOne({ _id: scheduleVersion }, { $set: { "rules.timezone": timezone } });
    const policyResolved = (await call(employee, `/api/workforce-policies/resolve/${employee}?at=${day}`)).data;
    assert.equal(policyResolved.timesheetPolicy.version._id, versionId);
    const coverage = (await call(admin, `/api/workforce-policies/coverage?at=${day}&resourceType=timesheet_policy`)).data;
    assert.equal(coverage.find((i: any) => i.employee._id === String(employee)).complete, true);
    const defaultCoverage = (await call(admin, `/api/workforce-policies/coverage?at=${day}`)).data;
    assert.ok(!defaultCoverage.some((i: any) => i.missing.includes("timesheet_policy")));
    assert.equal((await call(employee, `${daily}/projects?limit=1`)).data[0]._id, String(project));
    assert.equal((await call(employee, "/api/auth/me", "POST", {})).data.projectAccess.canAccessWorkspace, false, "A timesheet project picker must work without project-management navigation");
    assert.equal((await call(employee, `${daily}/work-types?projectId=${project}&limit=1`)).pagination.total, 2);
    await call(otherEmployee, `${daily}/work-types?projectId=${project}`, "GET", undefined, 404);
    const entry = (start: string, end: string, extra: any = {}) => ({ projectId: String(project), workTypeId: String(workType), startDate: day, endDate: day, startTime: start, endTime: end, notes: "Feature development", ...extra });
    const payload = { revision: 0, requestId: "first-save-request", entries: [entry("09:30", "13:30")] };
    const first = (await call(employee, daily, "PUT", payload)).data;
    assert.equal(first.loggedMinutes, 240); assert.equal(first.requiredMinutes, 480); assert.equal(first.shortfallMinutes, 240);
    assert.equal((await call(employee, daily, "PUT", payload)).replayed, true);
    await call(employee, daily, "PUT", { ...payload, entries: [entry("09:30", "12:30")] }, 409);
    await call(employee, daily, "PUT", { ...payload, requestId: "stale-save-request" }, 409);
    await call(employee, `${daily}?employeeId=${otherEmployee}`, "GET", undefined, 403);
    await call(employee, `${daily}?companyId=${otherCompany}`, "GET", undefined, 403);
    assert.equal((await call(outsider, `${daily}/history`)).pagination.total, 0);
    const invalid = { revision: 1, requestId: "overlap-save-request", entries: [entry("09:30", "11:00"), entry("10:00", "12:00")] };
    await call(employee, daily, "PUT", invalid, 422);
    assert.equal(await Revision.countDocuments({ company }), 1);
    const second = (await call(employee, daily, "PUT", { revision: 1, requestId: "second-save-request", entries: [entry("09:30", "13:00", { entryId: first.entries[0].entryId }), entry("14:00", "18:30", { workTypeId: String(secondType) })] })).data;
    assert.equal(second.loggedMinutes, 480); assert.equal(second.entries[0].entryId, first.entries[0].entryId);
    const concurrency = await Promise.all(["concurrent-save-one", "concurrent-save-two"].map(async (requestId) => {
      const response = await fetch(`${running.base}${daily}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(employee)}` }, body: JSON.stringify({ revision: 2, requestId, entries: [] }) });
      return response.status;
    }));
    assert.deepEqual(concurrency.sort(), [200, 409]);
    assert.equal(await Revision.countDocuments({ company }), 3);
    const history = (await call(employee, `${daily}/history?limit=1`));
    assert.equal(history.pagination.total, 3); assert.equal(history.data[0].revision, 3);
    assert.equal((await Revision.findOne({ company, revision: 1 }).lean() as any).snapshot.loggedMinutes, 240);
    const noPunchDay = addDateDays(day, 1);
    assert.ok((await call(employee, `/api/timesheets/day/${noPunchDay}`)).data.eligibility.saveIssues.some((i: any) => i.code === "MISSING_PUNCH_IN"));
    const summary = await call(employee, `/api/timesheets/summary?from=${day}&to=${today}`);
    assert.equal(summary.data.length, 3); assert.equal(summary.data[1].status, "missing");
    await call(employee, `/api/timesheets/summary?from=${day}&to=${addDateDays(day, 31)}`, "GET", undefined, 400);
    const v2 = (await call(admin, `${policies}/${policyId}/versions`, "POST", { effectiveFrom: today, changeReason: "Make timesheets optional", rules: { required: false } }, 201)).data;
    await call(admin, `${policies}/${policyId}/versions/${v2._id}/publish`, "POST", { revision: v2.revision });
    assert.equal((await call(employee, daily)).data.requiredMinutes, 480);
    assert.equal((await call(employee, `/api/timesheets/day/${today}`)).data.requiredMinutes, 0);
    const locationPolicy = (await call(admin, policies, "POST", { name: "Location override", code: "LOCAL", effectiveFrom: from, rules: { required: false } }, 201)).data;
    await call(admin, `${policies}/${locationPolicy.policy._id}/versions/${locationPolicy.version._id}/publish`, "POST", { revision: 1 });
    await call(admin, "/api/workforce-policies/assignments", "POST", { ...assignmentBody, resourceId: locationPolicy.policy._id, scopeType: "location", scopeId: location }, 201);
    assert.equal((await call(employee, daily)).data.requiredMinutes, 0);
    await call(admin, "/api/workforce-policies/assignments", "POST", { ...assignmentBody, scopeType: "employee", scopeId: employee }, 201);
    assert.equal((await call(employee, daily)).data.requiredMinutes, 480);
    const sameScope = await Promise.all([policyId, locationPolicy.policy._id].map(async (resourceId) => {
      const response = await fetch(`${running.base}/api/workforce-policies/assignments`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(admin)}` }, body: JSON.stringify({ ...assignmentBody, resourceId, scopeType: "department", scopeId: department }) });
      return response.status;
    }));
    assert.deepEqual(sameScope.sort(), [201, 409], "Different policy identities must not create overlapping assignments in a race");
    const draft = (await call(admin, `${policies}/${policyId}/versions`, "POST", { effectiveFrom: addDateDays(today, 1), changeReason: "Draft to cancel" }, 201)).data;
    await call(admin, `${policies}/${policyId}/versions/${draft._id}/cancel`, "POST", { revision: draft.revision, reason: "Cancel unused version" });
    assert.equal((await call(admin, `${policies}/${policyId}`)).data.versions.find((v: any) => v._id === draft._id).status, "cancelled");
    await Leave.collection.insertOne({ company, employee, unit: "days", status: "approved", dayBreakdown: [{ attendanceDate: day, portion: "first_half", requestedUnits: 0.5 }] });
    const afterLeave = (await call(employee, daily)).data;
    assert.equal(afterLeave.requiredMinutes, 240); assert.equal(afterLeave.contextChanged, true);
    await call(employee, daily, "PUT", { revision: 3, requestId: "leave-conflict-save", entries: [entry("09:30", "11:00")] }, 422);
    await WorkType.updateOne({ _id: workType }, { $set: { status: "archived", archivedAt: new Date() } });
    assert.equal((await call(employee, `${daily}/work-types?projectId=${project}`)).data.find((t: any) => t._id === String(workType)).available, true, "Archiving today must not erase past availability");
    const final = (await call(employee, daily, "PUT", { revision: 3, requestId: "half-day-save-request", entries: [entry("14:00", "18:00")] })).data;
    assert.equal(final.shortfallMinutes, 0);
    await User.updateOne({ _id: employee }, { $set: { joiningDate: new Date(`${today}T00:00:00Z`) } });
    const beforeEmployment = (await call(employee, daily)).data;
    assert.ok(beforeEmployment.eligibility.saveIssues.some((i: any) => i.code === "OUTSIDE_EMPLOYMENT"));
    assert.equal(beforeEmployment.requiredMinutes, 0);
    await User.updateOne({ _id: employee }, { $set: { joiningDate: new Date(`${from}T00:00:00Z`) } });
    const plannerUrl = `/api/timesheets/planner?from=${from}&to=${today}`;
    await call(null, plannerUrl, "GET", undefined, 401);
    await call(employee, `${plannerUrl}&employeeId=${otherEmployee}`, "GET", undefined, 403);
    await call(employee, `${plannerUrl}&companyId=${otherCompany}`, "GET", undefined, 403);
    await call(employee, "/api/timesheets/planner", "GET", undefined, 422);
    await call(employee, `/api/timesheets/planner?from=${today}&to=${from}`, "GET", undefined, 400);
    await call(employee, `/api/timesheets/planner?from=${from}&to=${addDateDays(from, 42)}`, "GET", undefined, 400);
    assert.equal((await call(employee, `/api/timesheets/planner?from=${from}&to=${addDateDays(from, 41)}`)).data.data.length, 42);
    const planner = (await call(employee, plannerUrl)).data;
    assert.equal(planner.today, today); assert.equal(planner.timezone, timezone);
    for (const date of [from, day, noPunchDay, today]) {
      const dailyContext = (await call(employee, `/api/timesheets/day/${date}`)).data;
      const compact = planner.data.find((d: any) => d.attendanceDate === date);
      assert.equal(compact.requiredMinutes, dailyContext.requiredMinutes, `Batch requirement differs on ${date}`);
      assert.equal(compact.canSave, dailyContext.eligibility.canSave, `Batch eligibility differs on ${date}`);
      assert.deepEqual(compact.setupIssues, dailyContext.eligibility.setupIssues);
      assert.equal(compact.loggedMinutes, dailyContext.loggedMinutes);
      assert.equal("entries" in compact, false);
    }
    assert.equal(planner.data.find((d: any) => d.attendanceDate === day).shortfallMinutes, 0);
    for (const period of ["today", "week", "month"]) assert.equal(planner.totals[`${period}Minutes`], day >= planner.periods[period].from && day <= planner.periods[period].to ? 240 : 0);
    assert.ok((await call(outsider, plannerUrl)).data.data.every((d: any) => d.loggedMinutes === 0));
    assert.equal((await call(employee, `${daily}/work-types?projectId=${project}&search=MEET`)).pagination.total, 1);
    assert.equal((await call(employee, `${daily}/work-types?projectId=${project}&search=%5B`)).pagination.total, 0, "Search must escape regex characters");
    const queryCounts: number[] = [];
    try {
      for (const length of [1, 42]) {
        let queries = 0;
        mongoose.set("debug", () => { queries++; });
        await loadMyTimesheetPlanner(company, employee, from, addDateDays(from, length - 1));
        queryCounts.push(queries);
      }
    } finally { mongoose.set("debug", false); }
    assert.equal(queryCounts[0], queryCounts[1], "Planner must not issue per-day database queries");
    assert.ok(queryCounts[1] < 40, `Expected bounded Planner queries, got ${queryCounts}`);
    console.log(`Planner live checks passed: batch/day equivalence, auth, search, totals, 42-day bounds; ${queryCounts[1]} database commands for either 1 or 42 days`);
    if (process.argv.includes("--ui")) {
      const child = spawn(process.execPath, [path.resolve(process.cwd(), "../scripts/verify-timesheet-policy-ui.cjs")], { windowsHide: true, stdio: "inherit", env: { ...process.env, TIMESHEET_TEST_API_URL: running.base, TIMESHEET_TEST_ADMIN_TOKEN: token(admin), TIMESHEET_TEST_COMPANY_ID: String(company), TIMESHEET_TEST_FROM: from } });
      const code = await new Promise((resolve) => child.on("exit", resolve)); assert.equal(code, 0, "Timesheet policy live UI failed");
    }
    if (process.argv.includes("--planner-ui")) {
      const uiDay = addDateDays(today, -1), nightDay = addDateDays(today, -3), offDay = addDateDays(today, -4), holidayDay = addDateDays(today, -5), leaveDay = addDateDays(today, -6), openDay = addDateDays(today, -8);
      const secondProject = id(), supportType = id(), unassignedProject = id(), nightSchedule = id();
      await Project.create([{ _id: secondProject, company, name: "Client Portal", code: "PORTAL", managers: [admin], startDate: from, createdBy: admin, updatedBy: admin }, { _id: unassignedProject, company, name: "Unassigned project", code: "UNASSIGNED", managers: [admin], startDate: from, createdBy: admin, updatedBy: admin }]);
      await WorkType.create({ _id: supportType, company, project: secondProject, name: "Support", code: "SUPPORT", createdBy: admin, updatedBy: admin });
      await ProjectAssignment.create({ company, project: secondProject, employee, employeeNameSnapshot: "Timesheet employee 1", effectiveFrom: from, changeReason: "Browser fixture", createdBy: admin });
      await ScheduleVersion.updateOne({ _id: scheduleVersion }, { $set: { "rules.workingDays": ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].filter((d) => d !== new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" }).format(new Date(`${offDay}T00:00:00Z`))) } });
      if (new Date(`${offDay}T00:00:00Z`).getUTCDay() === 6) await ScheduleVersion.updateOne({ _id: scheduleVersion }, { $set: { "rules.saturdayRule": "all_off" } });
      await CalendarVersion.updateOne({ _id: calendarVersion }, { $set: { holidays: [{ date: holidayDay, name: "Browser test holiday", type: "mandatory" }] } });
      await Leave.collection.insertOne({ company, employee, unit: "days", leaveUnit: "days", leaveTypeNameSnapshot: "Annual leave", status: "approved", fromDate: leaveDay, toDate: leaveDay, dayBreakdown: [{ attendanceDate: leaveDay, portion: "full", requestedUnits: 1, chargedUnits: 1 }] });
      await Schedule.collection.insertOne({ _id: nightSchedule, company, name: "Night shift", code: "NIGHT", status: "active", sourceAttendancePolicy: id() });
      await ScheduleVersion.collection.insertOne({ company, schedule: nightSchedule, versionNumber: 1, status: "published", effectiveFrom: new Date(`${from}T00:00:00Z`), rules: { timezone, workingDays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], saturdayRule: "all_working", startTime: "19:00", endTime: "02:00", unpaidBreakMinutes: 0, defaultWorkMode: "remote" } });
      await WorkforceAssignment.collection.insertOne({ company, resourceType: "work_schedule", resourceModel: "WorkSchedule", resource: nightSchedule, scopeType: "employee", scopeId: employee, priority: 500, effectiveFrom: new Date(`${nightDay}T00:00:00Z`), effectiveTo: new Date(`${addDateDays(nightDay, 1)}T00:00:00Z`), changeReason: "Browser night shift", createdBy: admin });
      for (const [date, startTime, endTime, endDate] of [[uiDay, "09:30", "18:30", uiDay], [nightDay, "19:00", "02:00", addDateDays(nightDay, 1)], [openDay, "09:30", "", openDay]]) {
        await Attendance.create({ company, employee, attendanceDate: date, timezone, state: "calculated", status: "present", revisionNumber: 1, workMode: "remote", punchSessions: [{ punchIn: localInstant(date, startTime, timezone), ...(endTime ? { punchOut: localInstant(endDate, endTime, timezone) } : {}), source: "import" }] });
      }
      // Earlier tests exercise policy v2; browser entry checks use a required historical day.
      const child = spawn(process.execPath, [path.resolve(process.cwd(), "../scripts/verify-timesheet-planner-ui.cjs")], { windowsHide: true, stdio: "inherit", env: { ...process.env, TIMESHEET_TEST_API_URL: running.base, TIMESHEET_TEST_EMPLOYEE_TOKEN: token(employee), TIMESHEET_TEST_ADMIN_TOKEN: token(admin), TIMESHEET_TEST_DAY: uiDay, TIMESHEET_TEST_NIGHT_DAY: nightDay, TIMESHEET_TEST_OFF_DAY: offDay, TIMESHEET_TEST_HOLIDAY_DAY: holidayDay, TIMESHEET_TEST_LEAVE_DAY: leaveDay, TIMESHEET_TEST_HALF_DAY: day, TIMESHEET_TEST_OPEN_DAY: openDay, TIMESHEET_TEST_NO_PUNCH_DAY: addDateDays(today, -7) } });
      const code = await new Promise((resolve) => child.on("exit", resolve)); assert.equal(code, 0, "Timesheet Planner live UI failed");
    }
    console.log("Live Phase 2 passed: normal backend, policy lifecycle/precedence/coverage, own drafts, tenant isolation, retries, concurrency, immutable history, leave, WFH, historical archives and summary bounds");
  } finally {
    if (application && application.exitCode === null) { const exited = new Promise((resolve) => application!.once("exit", resolve)); application.kill(); await exited; }
    const collections: mongoose.Model<any>[] = [Company, User, EmployeeHistory, Department, OfficeLocation, Schedule, ScheduleVersion, Calendar, CalendarVersion, WorkforceAssignment, ...models, Attendance, Leave];
    for (const model of collections) await model.deleteMany(model === Company ? { _id: { $in: [company, otherCompany] } } : { company: { $in: [company, otherCompany] } });
    await mongoose.disconnect();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
