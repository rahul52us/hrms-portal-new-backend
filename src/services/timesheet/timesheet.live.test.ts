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
import Submission from "../../schemas/Timesheet/TimesheetSubmission.schema";
import ApprovalInstance from "../../schemas/Approval/ApprovalInstance.schema";
import ApprovalWorkflow from "../../schemas/Approval/ApprovalWorkflow.schema";
import ApprovalVersion from "../../schemas/Approval/ApprovalWorkflowVersion.schema";
import Notification from "../../schemas/Notification/notification.schema";
import { addDateDays, dateInZone, localInstant } from "./timesheet.utils";
import { loadMyTimesheetPlanner } from "./timesheetPlanner.service";
import ExcelJS from "exceljs";
import DayControl from "../../schemas/Timesheet/TimesheetDayControl.schema";
import TimesheetAudit from "../../schemas/Timesheet/TimesheetAuditLog.schema";
import AttendancePeriod from "../../schemas/Attendance/AttendancePeriod.schema";
import { completionModels, verifyTimesheetCompletion, verifyTimesheetScale } from "./timesheetCompletion.live";

async function startBackend(uri: string) {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(process.execPath, ["-r", "ts-node/register", "src/index.ts"], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, MONGODB_URI: uri, PORT: String(port), VERCEL: "", TIMESHEET_SCHEDULER_ENABLED: "false", LEAVE_ACCRUAL_SCHEDULER_ENABLED: "false", ATTENDANCE_PROCESSOR_SCHEDULER_ENABLED: "false", PAYROLL_OPERATIONS_SCHEDULER_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
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
  const models = [Policy, PolicyVersion, PolicyAudit, Project, WorkType, ProjectAssignment, Timesheet, Revision, Submission, ApprovalInstance, ApprovalWorkflow, ApprovalVersion, Notification, WorkforceAssignment, DayControl, TimesheetAudit, ...completionModels];
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
    await call(admin, policies, "POST", { name: "Bad rules", code: "BAD", effectiveFrom: from, rules: { minimumEntryMinutes: 0 } }, 422);
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
    if (process.argv.includes("--completion") || process.argv.includes("--completion-ui")) await verifyTimesheetCompletion({ company, admin, employee, otherEmployee, outsider, day, from, timezone, project, workType, call, policies, policyId, daily, token, base: running.base });
    if (process.argv.includes("--scale")) await verifyTimesheetScale({ company, admin, day, from, project });
    if (process.argv.includes("--duration") || process.argv.includes("--duration-ui")) {
      await call(admin, "/api/workforce-policies/assignments", "POST", { ...assignmentBody, scopeType: "employee", scopeId: otherEmployee }, 201);
      await PolicyVersion.collection.updateOne({ _id: new mongoose.Types.ObjectId(versionId) }, { $set: { "rules.minuteIncrement": 15, "rules.minimumEntryMinutes": 15 } });
      await ProjectAssignment.create({ company, project, employee: otherEmployee, employeeNameSnapshot: "Timesheet employee 2", effectiveFrom: from, changeReason: "Exact duration fixture", createdBy: admin });
      await Attendance.create({ company, employee: otherEmployee, attendanceDate: day, timezone, workMode: "remote", state: "calculated", status: "present", revisionNumber: 1, punchSessions: [{ punchIn: localInstant(day, "09:30", timezone), punchOut: localInstant(day, "18:30", timezone), source: "import" }] });
      const exact = (await call(otherEmployee, daily, "PUT", { revision: 0, requestId: "exact-26-minute-save", entries: [entry("10:00", "10:26")] })).data;
      assert.equal(exact.loggedMinutes, 26);
      const odd = (await call(otherEmployee, daily, "PUT", { revision: exact.revision, requestId: "exact-27-minute-save", entries: [entry("10:00", "10:27")] })).data;
      assert.equal(odd.loggedMinutes, 27);
      await Attendance.updateOne({ company, employee: otherEmployee, attendanceDate: day }, { $set: { punchSessions: [{ punchIn: localInstant(day, "17:47", timezone), punchOut: localInstant(day, "18:13", timezone), source: "import" }] }, $inc: { revisionNumber: 1 } });
      await ScheduleVersion.updateOne({ _id: scheduleVersion }, { $set: { "rules.workingDays": [], "rules.saturdayRule": "all_off" } });
      const offDay = (await call(otherEmployee, daily, "PUT", { revision: odd.revision, requestId: "exact-off-day-save", entries: [entry("17:47", "18:13")] })).data;
      assert.equal(offDay.loggedMinutes, 26); assert.equal(offDay.requiredMinutes, 0);
      const beyondPunch = (await call(otherEmployee, daily, "PUT", { revision: offDay.revision, requestId: "allow-after-punch-out", entries: [entry("17:47", "18:14")] })).data;
      assert.equal(beyondPunch.loggedMinutes, 27);
      await call(otherEmployee, daily, "PUT", { revision: beyondPunch.revision, requestId: "respect-hr-minimum", entries: [entry("17:47", "18:00")] }, 422);
      await call(otherEmployee, daily, "PUT", { revision: beyondPunch.revision, requestId: "respect-schedule-limit", entries: [entry("09:30", "18:30")] }, 422);
      const outside = (await call(otherEmployee, daily, "PUT", { revision: beyondPunch.revision, requestId: "allow-outside-punches", entries: [entry("09:30", "13:00"), entry("14:00", "18:30")] })).data;
      assert.equal(outside.loggedMinutes, 480, "Short punches do not cap allocated work");
      await call(otherEmployee, daily, "PUT", { revision: outside.revision, requestId: "restore-27-minute-draft", entries: [entry("17:47", "18:14")] });
      if (process.argv.includes("--duration-ui")) {
        const child = spawn(process.execPath, [path.resolve(process.cwd(), "../scripts/verify-timesheet-duration-ui.cjs")], { windowsHide: true, stdio: "inherit", env: { ...process.env, TIMESHEET_TEST_API_URL: running.base, TIMESHEET_TEST_EMPLOYEE_TOKEN: token(otherEmployee), TIMESHEET_TEST_DAY: day } });
        const code = await new Promise((resolve) => child.on("exit", resolve)); assert.equal(code, 0, "Exact timesheet duration UI failed");
      }
      const latest = (await call(otherEmployee, daily)).data.timesheet;
      const pending = (await call(otherEmployee, `${daily}/submit`, "POST", { revision: latest.revision, requestId: "submit-exact-duration" })).data;
      await call(admin, `/api/timesheets/submissions/${pending.currentSubmission}/approve`, "POST", { revision: pending.revision, requestId: "approve-exact-duration" });
      assert.equal((await call(otherEmployee, daily)).data.timesheet.loggedMinutes, 27);
      assert.equal((await call(otherEmployee, daily)).data.timesheet.status, "approved");
      const unchangedAttendance: any = await Attendance.findOne({ company, employee: otherEmployee, attendanceDate: day }).lean();
      assert.equal(new Date(unchangedAttendance.punchSessions[0].punchOut).toISOString(), localInstant(day, "18:13", timezone).toISOString(), "Approval must not extend attendance");
      assert.equal((await PolicyVersion.collection.findOne({ _id: new mongoose.Types.ObjectId(versionId) }))!.rules.minuteIncrement, 15, "Published policy evidence is not rewritten");
      console.log("Exact duration live passed: 26/27 minute saves, outside-punch work, schedule/minimum limits, legacy policy preservation, optional weekly-off work, submission/approval and unchanged attendance");
    }
    if (process.argv.includes("--deadlines") || process.argv.includes("--deadlines-ui")) {
      const cutoff = Number(day.slice(-2));
      await Company.updateOne({ _id: company }, { $set: { "payrollSettings.attendanceCutoffDay": cutoff } });
      await call(admin, policies, "POST", { name: "Invalid approval deadline", effectiveFrom: from, rules: { deadlineMode: "payroll_cycle", payrollApprovalTime: "09:00" } }, 422);
      const cycleVersion = (await call(admin, `${policies}/${policyId}/versions`, "POST", { effectiveFrom: day, changeReason: "Use payroll cycle deadlines", rules: { required: true, deadlineMode: "payroll_cycle", maxBackdateDays: 0, payrollSubmissionDaysAfterCycleEnd: 0, payrollSubmissionTime: "23:00", payrollApprovalDaysAfterCycleEnd: 0, payrollApprovalTime: "23:59" } }, 201)).data;
      await call(admin, `${policies}/${policyId}/versions/${cycleVersion._id}/publish`, "POST", { revision: cycleVersion.revision });
      const closed = (await call(employee, daily)).data;
      assert.equal(closed.requiredMinutes, 240, "Existing half-day leave still reduces the working target");
      assert.equal(closed.eligibility.payrollCycle.endDate, day);
      assert.equal(closed.eligibility.payrollCycle.submissionAt, localInstant(day, "23:00", timezone).toISOString());
      assert.equal(closed.eligibility.canSave, false);
      assert.ok(closed.eligibility.saveIssues.some((issue: any) => issue.code === "PAYROLL_CUTOFF_CLOSED"));
      const oldRevision = closed.timesheet.revision, revisions = await Revision.countDocuments({ company });
      await call(employee, daily, "PUT", { revision: oldRevision, requestId: "closed-cycle-save", entries: [entry("14:00", "18:00")] }, 422);
      await call(employee, `${daily}/submit`, "POST", { revision: oldRevision, requestId: "closed-cycle-submit" }, 422);
      assert.equal(await Revision.countDocuments({ company }), revisions);
      const plannerClosed = (await call(employee, `/api/timesheets/planner?from=${day}&to=${day}`)).data.data[0];
      assert.equal(plannerClosed.canSave, false); assert.deepEqual(plannerClosed.saveIssues, closed.eligibility.saveIssues);
      const hrDay = (await call(admin, `/api/timesheets/operations/employees/${employee}/day/${day}?scope=organization`)).data;
      assert.deepEqual(hrDay.eligibility.payrollCycle, closed.eligibility.payrollCycle);
      const controlUrl = `/api/timesheets/operations/employees/${employee}/day/${day}/controls?scope=organization`;
      const currentControl = (await call(admin, controlUrl)).control;
      await call(admin, controlUrl, "POST", { action: "extend_deadline", revision: currentControl.revision, requestId: "cycle-deadline-extension", reason: "Approve audited late timesheet correction", untilDate: addDateDays(today, 1), untilTime: "18:00" });
      const open = (await call(employee, daily)).data;
      assert.equal(open.eligibility.canSave, true);
      const granted = (await call(admin, controlUrl)).control;
      await call(admin, controlUrl, "POST", { action: "revoke_extension", revision: granted.revision, requestId: "revoke-cycle-extension", reason: "Verify original payroll cutoff is restored" });
      assert.equal((await call(employee, daily)).data.eligibility.canSave, false);
      const revoked = (await call(admin, controlUrl)).control;
      await call(admin, controlUrl, "POST", { action: "extend_deadline", revision: revoked.revision, requestId: "restore-cycle-extension", reason: "Allow audited resubmission after cutoff", untilDate: addDateDays(today, 1), untilTime: "18:00" });
      const saved = (await call(employee, daily, "PUT", { revision: oldRevision, requestId: "extended-cycle-save", entries: [entry("14:00", "18:00")] })).data;
      const submitted = (await call(employee, `${daily}/submit`, "POST", { revision: saved.revision, requestId: "extended-cycle-submit" })).data;
      const detail = (await call(admin, `/api/timesheets/submissions/${submitted.currentSubmission}`)).data;
      assert.equal(detail.approvalOverdue, true, "Overdue approval remains actionable, not auto-rejected");
      assert.equal(detail.approvalDeadlineAt, closed.eligibility.payrollCycle.approvalAt);
      assert.equal((await call(admin, "/api/timesheets/submissions?scope=approvals")).data.find((item: any) => item._id === submitted.currentSubmission).approvalOverdue, true);
      await AttendancePeriod.collection.insertOne({ company, periodKey: day.slice(0, 7), startDate: closed.eligibility.payrollCycle.startDate, endDate: day, attendanceCutoffDay: cutoff, status: "open", version: 0 });
      await Company.updateOne({ _id: company }, { $set: { "payrollSettings.attendanceCutoffDay": cutoff === 31 ? 25 : 31 } });
      assert.equal((await call(employee, daily)).data.eligibility.payrollCycle.endDate, day, "Saved attendance cycle dates survive company setting changes");
      assert.equal((await call(admin, `/api/timesheets/submissions/${submitted.currentSubmission}`)).data.approvalDeadlineAt, detail.approvalDeadlineAt);
      await call(admin, `/api/timesheets/submissions/${submitted.currentSubmission}/approve`, "POST", { revision: submitted.revision, requestId: "approve-overdue-timesheet" });
      assert.equal((await call(employee, daily)).data.timesheet.status, "approved");
      assert.equal((await call(admin, `/api/timesheets/submissions/${submitted.currentSubmission}`)).data.approvalOverdue, false);
      assert.equal((await Attendance.findOne({ company, employee, attendanceDate: day }).lean() as any).status, "present");
      if (process.argv.includes("--deadlines-ui")) {
        await call(admin, "/api/workforce-policies/assignments", "POST", { ...assignmentBody, scopeType: "employee", scopeId: otherEmployee }, 201);
        await ProjectAssignment.create({ company, project, employee: otherEmployee, employeeNameSnapshot: "Timesheet employee 2", effectiveFrom: from, changeReason: "Cutoff browser fixture", createdBy: admin });
        await Attendance.create({ company, employee: otherEmployee, attendanceDate: day, timezone, workMode: "remote", state: "calculated", status: "present", revisionNumber: 1, punchSessions: [{ punchIn: localInstant(day, "09:30", timezone), punchOut: localInstant(day, "18:30", timezone), source: "import" }] });
        const otherControl = `/api/timesheets/operations/employees/${otherEmployee}/day/${day}/controls?scope=organization`;
        await call(admin, otherControl, "POST", { action: "extend_deadline", revision: 0, requestId: "browser-cycle-extension", reason: "Browser test audited cutoff extension", untilDate: addDateDays(today, 1), untilTime: "18:00" });
        const work = (await call(otherEmployee, daily, "PUT", { revision: 0, requestId: "browser-cycle-work", entries: [entry("09:30", "13:00"), entry("14:00", "18:30")] })).data;
        const pending = (await call(otherEmployee, `${daily}/submit`, "POST", { revision: work.revision, requestId: "browser-cycle-submit" })).data;
        const child = spawn(process.execPath, [path.resolve(process.cwd(), "../scripts/verify-timesheet-policy-ui.cjs")], { windowsHide: true, stdio: "inherit", env: { ...process.env, TIMESHEET_TEST_API_URL: running.base, TIMESHEET_TEST_ADMIN_TOKEN: token(admin), TIMESHEET_TEST_COMPANY_ID: String(company), TIMESHEET_TEST_FROM: from, TIMESHEET_TEST_CUTOFF_UI: "true", TIMESHEET_TEST_EMPLOYEE_TOKEN: token(otherEmployee), TIMESHEET_TEST_DAY: day, TIMESHEET_TEST_SUBMISSION_ID: String(pending.currentSubmission) } });
        const code = await new Promise((resolve) => child.on("exit", resolve)); assert.equal(code, 0, "Timesheet deadline live UI failed");
      }
      console.log("Payroll-cycle deadline live passed: policy publication, real save/submit cutoff guards, Planner/HR equivalence, audited extension, snapshotted overdue approvals, frozen cycles and unchanged attendance");
    }
    if (process.argv.includes("--reassignment") || process.argv.includes("--reassignment-ui")) {
      const reviewer = id(), alternate = id(), third = id(), hr = id(), disabled = id(), outsideHr = id();
      await User.collection.insertMany([{ _id: reviewer, name: "Delegate A", role: "user" }, { _id: alternate, name: "Delegate B", role: "user" }, { _id: third, name: "Delegate C", role: "user" },
        { _id: hr, name: "Reassignment HR", role: "hr", hrScope: { departments: ["Engineering"], teams: ["Platform"], officeLocations: [location] } },
        { _id: disabled, name: "Delegate Disabled", role: "user", is_enabled: false }, { _id: outsideHr, name: "Outside HR", role: "hr", hrScope: { departments: ["Sales"] } }]
        .map((person) => ({ company, username: `ts-${person._id}@example.test`, code: `RA-${person._id}`, password: "fixture-only", is_enabled: true, reportingManager: admin, department: "Engineering", team: "Platform", officeLocation: location, joiningDate: new Date(`${from}T00:00:00Z`), ...person })));
      let sequence = 0;
      const read = async () => (await call(employee, daily)).data;
      const submit = async () => (await call(employee, `${daily}/submit`, "POST", { revision: (await read()).timesheet.revision, requestId: `reassignment-submit-${++sequence}` })).data;
      const action = async (who: any, name: string, expected = 200) => { const current = (await read()).timesheet; return call(who, `/api/timesheets/submissions/${current.currentSubmission}/${name}`, "POST", { revision: current.revision, requestId: `reassignment-action-${++sequence}`, comment: "Verified unchanged work allocation" }, expected); };
      const pending = await submit(), subId = pending.currentSubmission, endpoint = `/api/timesheets/submissions/${subId}`;
      const payload = { revision: pending.revision, requestId: "timesheet-reassign-main", stepOrder: 1, fromUserId: String(admin), toUserId: String(reviewer), reason: "Reporting manager unavailable; delegate review" };
      const immutable = JSON.stringify((await Submission.findById(subId).lean() as any).snapshot);
      assert.equal((await call(hr, endpoint)).data.reassignment.authorized, false);
      await call(hr, `${endpoint}/reassign`, "POST", payload, 403);
      await User.updateOne({ _id: hr }, { $set: { permissions: { reassign_timesheet_approvals: true } } });
      assert.equal((await call(hr, endpoint)).data.reassignment.canReassign, true);
      await User.updateOne({ _id: hr }, { $set: { "hrScope.departments": ["Sales"] } });
      await call(hr, `${endpoint}/reassign`, "POST", payload, 403);
      await User.updateOne({ _id: hr }, { $set: { "hrScope.departments": ["Engineering"] } });
      await User.updateOne({ _id: employee }, { $set: { permissions: { view_timesheets: true, reassign_timesheet_approvals: true } } });
      await call(employee, `${endpoint}/reassign`, "POST", payload, 403);
      await User.updateOne({ _id: employee }, { $set: { permissions: {} } });
      await call(outsider, `${endpoint}/reassign`, "POST", payload, 404);
      await call(hr, `${endpoint}/reassign`, "POST", { ...payload, toUserId: String(hr) }, 403);
      await call(hr, `${endpoint}/reassign`, "POST", { ...payload, toUserId: String(employee) }, 403);
      await call(hr, `${endpoint}/reassign`, "POST", { ...payload, toUserId: String(disabled) }, 422);
      await call(hr, `${endpoint}/reassign`, "POST", { ...payload, toUserId: String(outsider) }, 422);
      await call(hr, `${endpoint}/reassign`, "POST", { ...payload, toUserId: String(outsideHr) }, 422);
      await call(hr, `${endpoint}/reassign`, "POST", { ...payload, stepOrder: 2 }, 409);
      await call(hr, `${endpoint}/reassign`, "POST", { ...payload, fromUserId: String(otherEmployee) }, 409);
      const choices = await call(hr, `${endpoint}/reassignment-options?search=Delegate&limit=1`);
      assert.equal(choices.data.length, 1); assert.equal(choices.pagination.hasMore, true);
      assert.equal((await call(hr, `${endpoint}/reassignment-options?search=Disabled`)).data.length, 0);
      assert.equal((await call(hr, `${endpoint}/reassignment-options?search=Outside`)).data.length, 0);
      await Submission.updateOne({ _id: subId }, { $set: { reassignmentCount: 50 } });
      await call(hr, `${endpoint}/reassign`, "POST", payload, 409);
      await Submission.updateOne({ _id: subId }, { $set: { reassignmentCount: 0 } });
      await Timesheet.updateOne({ company, employee, attendanceDate: day }, { $set: { payrollLockedAt: new Date() } });
      await call(hr, `${endpoint}/reassign`, "POST", payload, 409);
      await Timesheet.updateOne({ company, employee, attendanceDate: day }, { $set: { payrollLockedAt: null } });
      await DayControl.updateOne({ company, employee, attendanceDate: day }, { $set: { payrollLockedAt: new Date() } });
      await call(hr, `${endpoint}/reassign`, "POST", payload, 409);
      await DayControl.updateOne({ company, employee, attendanceDate: day }, { $set: { payrollLockedAt: null } });
      await User.updateOne({ _id: admin }, { $set: { is_enabled: false } });
      const reassigned = await call(hr, `${endpoint}/reassign`, "POST", payload);
      await User.updateOne({ _id: admin }, { $set: { is_enabled: true } });
      assert.equal(reassigned.data.status, "submitted"); assert.equal(reassigned.data.revision, pending.revision + 1);
      assert.equal((await call(hr, `${endpoint}/reassign`, "POST", payload)).replayed, true);
      await call(hr, `${endpoint}/reassign`, "POST", { ...payload, reason: "Altered replay" }, 409);
      await call(admin, `${endpoint}/reassign`, "POST", payload, 409);
      assert.equal(await Revision.countDocuments({ company, employee, action: "reassign" }), 1);
      assert.equal(await Notification.countDocuments({ company, entityId: subId, eventType: /^timesheet\.approval_reassigned\./ }), 3);
      const detail = (await call(hr, endpoint)).data;
      assert.deepEqual(detail.currentApprovers, [String(reviewer)]); assert.ok(detail.participantIds.includes(String(admin))); assert.ok(detail.participantIds.includes(String(reviewer)));
      assert.equal(detail.history.at(-1).reassignment.to.name, "Delegate A");
      assert.equal(JSON.stringify((await Submission.findById(subId).lean() as any).snapshot), immutable);
      assert.equal((await call(admin, "/api/timesheets/submissions?scope=approvals")).pagination.total, 0);
      assert.equal((await call(reviewer, "/api/timesheets/submissions?scope=approvals")).pagination.total, 1);
      await action(admin, "approve", 403); await action(otherEmployee, "approve", 403); await action(reviewer, "approve");
      assert.equal((await call(hr, `${endpoint}/reassign`, "POST", payload)).replayed, true, "Accepted retry remains replayable after completion");
      await call(hr, `${endpoint}/reassign`, "POST", { ...payload, requestId: "closed-reassign-request", revision: (await read()).timesheet.revision }, 409);
      await action(admin, "reopen");
      const racing = await submit(), raceUrl = `/api/timesheets/submissions/${racing.currentSubmission}`;
      await call(hr, `${endpoint}/reassign`, "POST", { ...payload, revision: racing.revision, requestId: "superseded-attempt-reassign" }, 409);
      const race = await Promise.all([
        fetch(`${running.base}${raceUrl}/reassign`, { method: "POST", headers: { Authorization: `Bearer ${token(hr)}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, revision: racing.revision, requestId: "reassign-race-request" }) }),
        fetch(`${running.base}${raceUrl}/approve`, { method: "POST", headers: { Authorization: `Bearer ${token(admin)}`, "Content-Type": "application/json" }, body: JSON.stringify({ revision: racing.revision, requestId: "approve-race-request", comment: "Concurrent manager decision" }) }),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
      if ((await read()).timesheet.status === "submitted") await action(reviewer, "approve");
      await action(admin, "reopen");
      const workflow = await ApprovalWorkflow.create({ company, name: "Reassignment all then final", code: "REASSIGN_ALL", applicableTo: ["timesheet_submission"], status: "active", createdBy: admin });
      const flowVersion = await ApprovalVersion.create({ company, workflow: workflow._id, versionNumber: 1, status: "published", effectiveFrom: new Date(`${from}T00:00:00Z`), applicableTo: ["timesheet_submission"], autoApprove: false,
        steps: [{ order: 1, name: "Both reviewers", approverType: "specific_users", approvalRule: "all", approverUserIds: [admin, otherEmployee], fallbackToHr: false }, { order: 2, name: "Final reviewer", approverType: "specific_users", approvalRule: "any", approverUserIds: [reviewer], fallbackToHr: false }], createdBy: admin });
      const policyVersionId = (await read()).context.policyReferences.timesheetPolicy.versionId;
      await PolicyVersion.updateOne({ _id: policyVersionId }, { $set: { "rules.approvalWorkflowId": String(workflow._id) } });
      const allPending = await submit(), allUrl = `/api/timesheets/submissions/${allPending.currentSubmission}`;
      await action(admin, "approve"); const partiallyApproved = (await call(hr, allUrl)).data;
      const originalDecision = JSON.stringify(partiallyApproved.approvalInstance.steps[0].approvers.find((a: any) => a.user === String(admin)));
      const replaceAll = { ...payload, revision: partiallyApproved.sheetRevision, requestId: "replace-all-pending-member", fromUserId: String(otherEmployee), toUserId: String(alternate) };
      await call(hr, `${allUrl}/reassign`, "POST", { ...replaceAll, toUserId: String(reviewer) }, 422);
      await call(hr, `${allUrl}/reassign`, "POST", { ...replaceAll, fromUserId: String(admin) }, 409);
      await call(hr, `${allUrl}/reassign`, "POST", replaceAll);
      const replacedAll = (await call(hr, allUrl)).data;
      assert.equal(JSON.stringify(replacedAll.approvalInstance.steps[0].approvers.find((a: any) => a.user === String(admin))), originalDecision);
      assert.equal(replacedAll.approvalInstance.steps[1].status, "waiting"); assert.equal(replacedAll.approvalInstance.workflowVersion, String(flowVersion._id));
      await action(otherEmployee, "approve", 403); await action(alternate, "approve");
      assert.equal((await read()).timesheet.status, "submitted");
      assert.deepEqual((await call(hr, allUrl)).data.currentApprovers, [String(reviewer)]);
      await action(reviewer, "approve"); assert.equal((await read()).timesheet.status, "approved");
      await PolicyVersion.updateOne({ _id: policyVersionId }, { $set: { "rules.approvalWorkflowId": null } });
      console.log("Timesheet reassignment live passed: scoped permission/delegation, inactive source, candidate privacy, self/lock/superseded guards, retries, immutable work, dashboard queues, notifications, concurrent decision and all-rule preservation");
      if (process.argv.includes("--reassignment-ui")) {
        await action(admin, "reopen"); const forUi = await submit();
        const child = spawn(process.execPath, [path.resolve(process.cwd(), "../scripts/verify-timesheet-reassignment-ui.cjs")], { windowsHide: true, stdio: "inherit", env: { ...process.env, TIMESHEET_TEST_API_URL: running.base, TIMESHEET_TEST_HR_TOKEN: token(hr), TIMESHEET_TEST_ADMIN_TOKEN: token(admin), TIMESHEET_TEST_EMPLOYEE_TOKEN: token(employee), TIMESHEET_TEST_REVIEWER_TOKEN: token(reviewer), TIMESHEET_TEST_REVIEWER_ID: String(reviewer), TIMESHEET_TEST_SUBMISSION_ID: String(forUi.currentSubmission), TIMESHEET_TEST_DAY: day } });
        const code = await new Promise((resolve) => child.on("exit", resolve)); assert.equal(code, 0, "Reassignment browser workflow failed");
      }
    }
    if (["--operations", "--operations-ui", "--controls", "--controls-ui"].some((flag) => process.argv.includes(flag))) {
      const hr = id(), manager = id(), projectManager = id(), staff = id(), missing = id(), outside = id(), sales = id(), otherLocation = id(), privateProject = id(), privateType = id();
      const people = [{ _id: hr, name: "Operations HR", role: "hr", department: "Administration", hrScope: { departments: ["Engineering"], teams: ["Platform"], officeLocations: [location] } }, { _id: manager, name: "Operations Manager", role: "user", department: "Engineering" }, { _id: projectManager, name: "Project Reviewer", role: "user", department: "Sales" }, { _id: staff, name: "Operations Staff", role: "user", department: "Engineering", reportingManager: manager }, { _id: missing, name: "Operations Missing", role: "user", department: "Engineering" }, { _id: outside, name: "Confidential Sales", role: "user", department: "Sales" }];
      await User.collection.insertMany(people.map((person) => ({ company, username: `ts-${person._id}@example.test`, code: `OP-${person._id}`, password: "fixture-only", is_enabled: true, joiningDate: new Date(`${from}T00:00:00Z`), createdAt: new Date(`${from}T00:00:00Z`), team: "Platform", officeLocation: person.department === "Sales" ? otherLocation : location, reportingManager: admin, ...person })));
      await Department.collection.insertOne({ _id: sales, company, departmentName: "Sales", code: "SALES", teams: [] });
      await OfficeLocation.collection.insertOne({ _id: otherLocation, company, name: "Mumbai", code: "MUM", deletedAt: null });
      await EmployeeHistory.collection.insertMany(people.map((person) => ({ company, employee: person._id, effectiveFrom: new Date(`${from}T00:00:00Z`), effectiveTo: null, department: person.department === "Engineering" ? department : sales, departmentNameSnapshot: person.department, teamId: team, teamNameSnapshot: "Platform", officeLocation: person.department === "Sales" ? otherLocation : location, officeLocationNameSnapshot: person.department === "Sales" ? "Mumbai" : "Delhi", reportingManager: person.reportingManager || admin })));
      const transferDate = addDateDays(day, 1);
      await EmployeeHistory.updateOne({ company, employee: otherEmployee }, { $set: { effectiveTo: new Date(`${transferDate}T00:00:00Z`) } });
      await EmployeeHistory.collection.insertOne({ company, employee: otherEmployee, effectiveFrom: new Date(`${transferDate}T00:00:00Z`), effectiveTo: null, department: sales, departmentNameSnapshot: "Sales", teamNameSnapshot: "Platform", officeLocation: otherLocation, officeLocationNameSnapshot: "Mumbai", reportingManager: admin });
      await User.updateOne({ _id: otherEmployee }, { $set: { department: "Sales", officeLocation: otherLocation } });
      await Project.updateOne({ _id: project }, { $addToSet: { managers: projectManager } });
      await Project.create({ _id: privateProject, company, name: "Private Sales Project", code: "PRIVATE", managers: [admin], startDate: from, createdBy: admin, updatedBy: admin });
      await WorkType.create({ _id: privateType, company, project: privateProject, name: "Confidential support", code: "PRIVATE", createdBy: admin, updatedBy: admin });
      for (const person of [staff, missing, outside]) {
        await call(admin, "/api/workforce-policies/assignments", "POST", { ...assignmentBody, scopeType: "employee", scopeId: person }, 201);
        await ProjectAssignment.create({ company, project: person === outside ? privateProject : project, employee: person, employeeNameSnapshot: "Operations fixture", effectiveFrom: from, changeReason: "Fixture", createdBy: admin });
      }
      await ProjectAssignment.create({ company, project: privateProject, employee: staff, employeeNameSnapshot: "Operations Staff", effectiveFrom: from, changeReason: "Fixture", createdBy: admin });
      for (const person of [staff, outside]) await Attendance.create({ company, employee: person, attendanceDate: day, timezone, state: "calculated", status: "present", revisionNumber: 1, workedMinutes: 540, punchSessions: [{ punchIn: localInstant(day, "09:30", timezone), punchOut: localInstant(day, "18:30", timezone), source: "import" }] });
      const entryFor = (projectId: any, typeId: any, startTime: string, endTime: string) => ({ projectId: String(projectId), workTypeId: String(typeId), startDate: day, endDate: day, startTime, endTime, notes: "Operations test allocation" });
      await call(staff, daily, "PUT", { revision: 0, requestId: "operations-mixed-draft", entries: [entryFor(project, workType, "09:30", "13:30"), entryFor(privateProject, privateType, "14:00", "18:00")] });
      const staffSubmitted = (await call(staff, `${daily}/submit`, "POST", { revision: 1, requestId: "operations-submit-day" })).data;
      await call(manager, `/api/timesheets/submissions/${staffSubmitted.currentSubmission}/approve`, "POST", { revision: staffSubmitted.revision, requestId: "operations-approve-day" });
      await call(outside, daily, "PUT", { revision: 0, requestId: "operations-private-draft", entries: [entryFor(privateProject, privateType, "09:30", "13:30"), entryFor(privateProject, privateType, "14:00", "18:00")] });
      const extra = Array.from({ length: 12 }, (_, i) => ({ _id: id(), name: `Operations Extra ${i}` }));
      await User.collection.insertMany(extra.map((p) => ({ ...p, company, role: "user", code: `OP-${p._id}`, username: `ts-${p._id}@example.test`, password: "fixture-only", is_enabled: true, department: "Engineering", team: "Platform", officeLocation: location, joiningDate: new Date(`${from}T00:00:00Z`), reportingManager: admin })));
      await EmployeeHistory.collection.insertMany(extra.map((p) => ({ company, employee: p._id, effectiveFrom: new Date(`${from}T00:00:00Z`), effectiveTo: null, department, departmentNameSnapshot: "Engineering", teamId: team, teamNameSnapshot: "Platform", officeLocation: location, officeLocationNameSnapshot: "Delhi", reportingManager: admin })));
      const ops = "/api/timesheets/operations", at = `date=${day}&scope=organization`;
      await call(employee, `${ops}/options`, "GET", undefined, 403);
      assert.ok((await call(admin, "/api/auth/me", "POST", {})).data.timesheetAccess.canAccessWorkspace);
      assert.deepEqual((await call(projectManager, `${ops}/options`)).data.scopes, ["projects"]);
      assert.deepEqual((await call(manager, `${ops}/options`)).data.scopes, ["reportees"]);
      await call(projectManager, `${ops}/register?date=${day}&scope=projects`, "GET", undefined, 403);
      await call(manager, `${ops}/register?${at}`, "GET", undefined, 403);
      await call(admin, `${ops}/register?${at}&companyId=${otherCompany}`, "GET", undefined, 403);
      const register = await call(admin, `${ops}/register?${at}&limit=1&page=2`);
      assert.equal(register.data.length, 1); assert.ok(register.pagination.total > 10); assert.equal(register.summary.rows, register.pagination.total);
      const missingDay = (await call(hr, `${ops}/register?${at}&employeeId=${missing}`)).data[0];
      assert.equal(missingDay.state, "missing"); assert.equal(missingDay.requiredMinutes, 480); assert.equal(missingDay.sheetId, null);
      const current = (await call(hr, `${ops}/register?${at}&employeeId=${staff}`)).data[0];
      assert.equal(current.state, "approved"); assert.equal(current.loggedMinutes, 480); assert.equal(current.stale, false);
      assert.equal((await call(hr, `${ops}/register?${at}&employeeId=${outside}`)).pagination.total, 0);
      assert.equal((await call(hr, `${ops}/register?${at}&employeeId=${otherEmployee}`)).pagination.total, 1, "Historical department is used before transfer");
      assert.equal((await call(hr, `${ops}/register?date=${transferDate}&scope=organization&employeeId=${otherEmployee}`)).pagination.total, 0);
      const reports = await call(manager, `${ops}/register?date=${day}&scope=reportees`);
      assert.equal(reports.pagination.total, 1); assert.equal(reports.data[0].employee._id, String(staff));
      await call(hr, `${ops}/employees/${outside}/day/${day}?scope=organization`, "GET", undefined, 403);
      assert.equal((await call(hr, `${ops}/employees/${staff}/day/${day}?scope=organization`)).data.timesheet.entries.length, 2);
      assert.equal((await call(hr, `/api/timesheets/submissions/${staffSubmitted.currentSubmission}`)).data.snapshot.loggedMinutes, 480);
      const effort = await call(projectManager, `${ops}/effort?from=${day}&to=${day}&scope=projects`);
      assert.equal(effort.summary.loggedMinutes, 480); assert.ok(!JSON.stringify(effort).includes("Private Sales Project")); assert.ok(!JSON.stringify(effort).includes("salary"));
      await call(projectManager, `${ops}/effort?from=${day}&to=${day}&scope=projects&projectId=${privateProject}`, "GET", undefined, 403);
      await call(projectManager, `${ops}/employees/${staff}/day/${day}?scope=projects`, "GET", undefined, 403);
      await call(projectManager, `${ops}/lookups?date=${day}&scope=projects&kind=work_type&projectId=${project}&employeeId=${staff}`, "GET", undefined, 400);
      assert.equal((await call(hr, `${ops}/effort?from=${day}&to=${day}&scope=organization&officeLocationId=${otherLocation}`)).summary.rows, 0, "Location filter cannot replace HR scope");
      assert.equal((await call(manager, `${ops}/effort?from=${day}&to=${day}&scope=reportees&managerId=${admin}`)).summary.rows, 0, "Manager filter cannot replace reportee scope");
      assert.equal((await call(admin, `${ops}/register?${at}&projectId=${project}&workTypeId=${privateType}`)).pagination.total, 0, "Project and work type must match one entry");
      const monthly = await call(hr, `${ops}/monthly?month=${day.slice(0, 7)}&scope=organization&limit=1`);
      assert.equal(monthly.data.length, 1); assert.equal(monthly.summaryScope, "page"); assert.ok(monthly.pagination.total > 1);
      const monthStaff = await call(hr, `${ops}/monthly?month=${day.slice(0, 7)}&scope=organization&employeeId=${staff}`);
      assert.equal(monthStaff.data[0].approvedMinutes, 480); assert.ok(monthStaff.data[0].days.every((d: any) => d.state !== "upcoming" || d.shortfallMinutes === 0));
      await call(admin, `${ops}/monthly?month=${day.slice(0, 7)}&scope=organization&status=missing`, "GET", undefined, 400);
      await call(admin, `${ops}/effort?from=${from}&to=${addDateDays(from, 31)}&scope=organization`, "GET", undefined, 400);
      assert.ok((await call(hr, `${ops}/lookups?${at}&kind=employee&search=Operations&limit=1`)).pagination.hasMore);
      assert.ok(!(await call(hr, `${ops}/lookups?${at}&kind=department`)).data.some((d: any) => d._id === String(sales)));
      const rangeProjects = await call(hr, `${ops}/lookups?date=${transferDate}&from=${day}&to=${transferDate}&scope=organization&kind=project`);
      assert.ok(rangeProjects.data.some((p: any) => p._id === String(project)), "Lookup includes work before the last date of the range");
      await User.updateOne({ _id: staff }, { $set: { name: "=1+1" } });
      const csv = await fetch(`${running.base}${ops}/export?${at}&view=register&format=csv&employeeId=${staff}`, { headers: { Authorization: `Bearer ${token(hr)}` } });
      assert.equal(csv.status, 200); assert.ok((await csv.text()).includes("'=1+1"));
      const xlsx = await fetch(`${running.base}${ops}/export?${at}&view=register&format=xlsx&employeeId=${staff}`, { headers: { Authorization: `Bearer ${token(hr)}` } });
      assert.equal(xlsx.status, 200); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await xlsx.arrayBuffer()) as any); assert.equal(workbook.worksheets[0].getRow(2).getCell(1).value, "'=1+1");
      await User.updateOne({ _id: staff }, { $set: { name: "Operations Staff" } });
      const deniedExport = await fetch(`${running.base}${ops}/export?date=${day}&scope=reportees&view=register&format=csv`, { headers: { Authorization: `Bearer ${token(manager)}` } }); assert.equal(deniedExport.status, 403);
      await User.updateOne({ _id: manager }, { $set: { permissions: { export_timesheets: true } } });
      const exportAccess = (await call(manager, `${ops}/options`)).data;
      assert.deepEqual(exportAccess.scopes, ["reportees"]); assert.equal(exportAccess.canExport, true);
      const scopedExport = await fetch(`${running.base}${ops}/export?date=${day}&scope=reportees&view=register&format=csv`, { headers: { Authorization: `Bearer ${token(manager)}` } });
      assert.equal(scopedExport.status, 200); const scopedCsv = await scopedExport.text(); assert.ok(scopedCsv.includes("Operations Staff")); assert.ok(!scopedCsv.includes("Confidential Sales"));
      await call(manager, `${ops}/register?${at}`, "GET", undefined, 403);
      await Attendance.updateOne({ company, employee: staff, attendanceDate: day }, { $inc: { revisionNumber: 1 } });
      assert.equal((await call(hr, `${ops}/register?${at}&employeeId=${staff}&status=stale`)).pagination.total, 1);
      console.log("Operations live passed: missing rows, totals/pagination, historical HR/reportee/project scopes, mixed-project privacy, monthly targets, changed context, lookups, formula-safe CSV/XLSX and export denial");
      if (process.argv.includes("--controls") || process.argv.includes("--controls-ui")) {
        const endpoint = (person: any, date = day) => `${ops}/employees/${person}/day/${date}/controls?scope=organization`;
        const grant = { action: "grant_exemption", mode: "full_day", revision: 0, requestId: "hr-control-full-grant", reason: "Approved training without project allocation" };
        await call(hr, endpoint(missing), "POST", grant, 403);
        await User.updateOne({ _id: hr }, { $set: { permissions: { manage_timesheet_exceptions: true } } });
        await call(hr, endpoint(outside), "POST", grant, 403);
        await call(admin, endpoint(admin), "POST", grant, 403);
        await call(manager, endpoint(missing), "POST", grant, 403);
        await call(projectManager, `${ops}/employees/${staff}/day/${day}/controls?scope=projects`, "POST", grant, 403);
        await call(hr, endpoint(staff), "POST", grant, 409);
        const noSheetCount = await Timesheet.countDocuments({ company, employee: missing });
        const granted = await call(hr, endpoint(missing), "POST", grant); assert.equal(granted.data.revision, 1);
        const repeated = await call(hr, endpoint(missing), "POST", grant); assert.equal(repeated.replayed, true);
        await call(hr, endpoint(missing), "POST", { ...grant, reason: "Changed retry" }, 409);
        await call(admin, endpoint(missing), "POST", grant, 409);
        assert.equal(await TimesheetAudit.countDocuments({ company, employee: missing }), 1);
        const grantAudit: any = await TimesheetAudit.findOne({ company, employee: missing }).lean();
        assert.equal(grantAudit.contextSnapshot.baselineRequiredMinutes, 480); assert.equal(grantAudit.contextSnapshot.requiredAfter, 0);
        assert.equal(await Notification.countDocuments({ company, recipient: missing, eventType: "timesheet.grant_exemption" }), 1);
        assert.equal(await Timesheet.countDocuments({ company, employee: missing }), noSheetCount, "Granting does not create a fake work document");
        const exemptDay = (await call(missing, daily)).data; assert.equal(exemptDay.requiredMinutes, 0); assert.equal(exemptDay.loggedMinutes, 0);
        assert.equal(exemptDay.eligibility.exemptMinutes, 480);
        assert.equal((await call(missing, `/api/timesheets/planner?from=${day}&to=${day}`)).data.data[0].hrExemption, true);
        assert.equal((await call(hr, `${ops}/register?${at}&status=exempt&employeeId=${missing}`)).pagination.total, 1);
        assert.equal((await call(hr, `${ops}/monthly?month=${day.slice(0, 7)}&scope=organization&employeeId=${missing}`)).data[0].exemptMinutes, 480);
        assert.equal((await call(missing, `${daily}/controls`)).data.length, 1);
        const revoke = { action: "revoke_exemption", revision: 1, requestId: "hr-control-revoke-full", reason: "Training cancelled; restore requirement" };
        await call(hr, endpoint(missing), "POST", { ...revoke, revision: 0 }, 409);
        await call(hr, endpoint(missing), "POST", revoke); assert.equal((await call(missing, daily)).data.requiredMinutes, 480);
        await call(hr, endpoint(missing), "POST", { ...grant, revision: 2, mode: "minutes", minutes: 120, requestId: "hr-control-partial-grant" });
        assert.equal((await call(missing, daily)).data.requiredMinutes, 360);
        const requests = ["concurrent-control-a", "concurrent-control-b"].map((requestId) => fetch(`${running.base}${endpoint(missing)}`, { method: "POST", headers: { Authorization: `Bearer ${token(hr)}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...revoke, revision: 3, requestId }) }));
        assert.deepEqual((await Promise.all(requests)).map((r) => r.status).sort(), [200, 409]);
        assert.equal(await TimesheetAudit.countDocuments({ company, employee: missing }), 4);
        await call(hr, endpoint(missing, addDateDays(today, 1)), "POST", grant, 422);
        await User.updateOne({ _id: outside }, { $set: { is_enabled: false } });
        await call(admin, endpoint(outside), "POST", { ...grant, mode: "minutes", minutes: 120, requestId: "hr-control-historical-disabled" });
        assert.equal((await call(admin, `${ops}/employees/${outside}/day/${day}?scope=organization`)).data.requiredMinutes, 360, "Historic employment days remain manageable after account deactivation");
        await User.updateOne({ _id: outside }, { $set: { is_enabled: true } });
        await DayControl.updateOne({ company, employee: missing, attendanceDate: day }, { $set: { payrollLockedAt: new Date() } });
        await call(hr, endpoint(missing), "POST", { ...grant, revision: 4, requestId: "hr-control-locked-grant" }, 409);
        await DayControl.updateOne({ company, employee: missing, attendanceDate: day }, { $set: { payrollLockedAt: null } });
        // Force a short historical edit window to prove the extension reopens real saving.
        const effectivePolicy: any = (await call(missing, daily)).data.context.policyReferences.timesheetPolicy;
        const versionId = effectivePolicy.versionId || effectivePolicy.version;
        const currentPolicy: any = await PolicyVersion.findById(versionId).lean();
        assert.ok(currentPolicy, "Policy version reference is resolvable");
        await PolicyVersion.updateOne({ _id: currentPolicy._id }, { $set: { "rules.maxBackdateDays": 0 } });
        await Attendance.create({ company, employee: missing, attendanceDate: day, timezone, state: "calculated", status: "present", revisionNumber: 1, punchSessions: [{ punchIn: localInstant(day, "09:30", timezone), punchOut: localInstant(day, "18:30", timezone), source: "import" }] });
        assert.ok((await call(missing, daily)).data.eligibility.saveIssues.some((i: any) => i.code === "EDIT_WINDOW_CLOSED"));
        const extension = { action: "extend_deadline", revision: 4, requestId: "hr-control-extension-one", untilDate: addDateDays(today, 1), untilTime: "23:59", reason: "Reopen missed day for corrected allocation" };
        await call(hr, endpoint(missing), "POST", extension); assert.equal((await call(missing, daily)).data.eligibility.canSave, true);
        await call(missing, daily, "PUT", { revision: 0, requestId: "hr-controls-employee-save", entries: [entryFor(project, workType, "09:30", "13:30")] });
        await call(hr, endpoint(missing), "POST", { action: "revoke_extension", revision: 5, requestId: "hr-control-extension-revoke", reason: "Close correction allowance" });
        assert.equal((await call(missing, daily)).data.eligibility.canSave, false);
        await PolicyVersion.updateOne({ _id: currentPolicy._id }, { $set: { "rules.maxBackdateDays": currentPolicy.rules.maxBackdateDays } });
        const simultaneous = await Promise.all([
          fetch(`${running.base}${daily}`, { method: "PUT", headers: { Authorization: `Bearer ${token(missing)}`, "Content-Type": "application/json" }, body: JSON.stringify({ revision: 1, requestId: "hr-controls-raced-draft", entries: [entryFor(project, workType, "09:30", "13:30")] }) }),
          fetch(`${running.base}${endpoint(missing)}`, { method: "POST", headers: { Authorization: `Bearer ${token(hr)}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...grant, revision: 6, mode: "minutes", minutes: 120, requestId: "hr-controls-raced-grant" }) }),
        ]);
        for (const response of simultaneous) assert.equal(response.status, 200, await response.text());
        const racedDay = (await call(missing, daily)).data; assert.equal(racedDay.requiredMinutes, 360); assert.equal(racedDay.loggedMinutes, 240);
        assert.equal((await Attendance.findOne({ company, employee: missing, attendanceDate: day }).lean() as any).revisionNumber, 1);
        console.log("Day controls live passed: scoped delegation, self/frozen-day denial, full/partial/revoked exemptions, Planner/report consistency, retry/concurrency, immutable audit, notifications and real closed-window extension");
        if (process.argv.includes("--controls-ui")) {
          const child = spawn(process.execPath, [path.resolve(process.cwd(), "../scripts/verify-timesheet-controls-ui.cjs")], { windowsHide: true, stdio: "inherit", env: { ...process.env, TIMESHEET_TEST_API_URL: running.base, TIMESHEET_TEST_HR_TOKEN: token(hr), TIMESHEET_TEST_EMPLOYEE_TOKEN: token(missing), TIMESHEET_TEST_DAY: day } });
          const code = await new Promise((resolve) => child.on("exit", resolve)); assert.equal(code, 0, "Timesheet controls live UI failed");
        }
      }
      if (process.argv.includes("--operations-ui")) {
        const child = spawn(process.execPath, [path.resolve(process.cwd(), "../scripts/verify-timesheet-operations-ui.cjs")], { windowsHide: true, stdio: "inherit", env: { ...process.env, TIMESHEET_TEST_API_URL: running.base, TIMESHEET_TEST_HR_TOKEN: token(hr), TIMESHEET_TEST_PROJECT_MANAGER_TOKEN: token(projectManager), TIMESHEET_TEST_EMPLOYEE_TOKEN: token(employee), TIMESHEET_TEST_STAFF_ID: String(staff), TIMESHEET_TEST_DAY: day } });
        const code = await new Promise((resolve) => child.on("exit", resolve)); assert.equal(code, 0, "Timesheet operations live UI failed");
      }
    }
    if (process.argv.includes("--approvals") || process.argv.includes("--approvals-ui")) {
      let sequence = 0;
      const read = async () => (await call(employee, daily)).data;
      const submit = async (extra: any = {}, expected = 200) => {
        const d = await read(); return call(employee, `${daily}/submit`, "POST", { revision: d.timesheet.revision, requestId: `submit-request-${++sequence}`, ...extra }, expected);
      };
      const act = async (who: any, action: string, extra: any = {}, expected = 200) => {
        const d = await read(); return call(who, `/api/timesheets/submissions/${d.timesheet.currentSubmission}/${action}`, "POST", { revision: d.timesheet.revision, requestId: `decision-request-${++sequence}`, comment: "Verified work allocation", ...extra }, expected);
      };
      const firstSubmitBody = { revision: (await read()).timesheet.revision, requestId: "default-first-submission" };
      const submitted = (await call(employee, `${daily}/submit`, "POST", firstSubmitBody)).data;
      assert.equal(submitted.status, "submitted");
      assert.equal((await call(employee, `${daily}/submit`, "POST", firstSubmitBody)).replayed, true);
      assert.equal(await Submission.countDocuments({ company }), 1);
      assert.equal((await call(admin, "/api/timesheets/submissions?scope=approvals")).pagination.total, 1);
      assert.equal((await call(otherEmployee, "/api/timesheets/submissions?scope=approvals")).pagination.total, 0);
      await call(outsider, `/api/timesheets/submissions/${submitted.currentSubmission}`, "GET", undefined, 404);
      await Project.updateOne({ _id: project }, { $set: { managers: [admin, otherEmployee] } });
      await act(employee, "approve", {}, 403); await act(otherEmployee, "approve", {}, 403);
      await call(employee, daily, "PUT", { revision: submitted.revision, requestId: "edit-pending-submission", entries: [] }, 409);
      await act(employee, "withdraw"); assert.equal((await read()).timesheet.status, "draft");
      await submit(); await act(admin, "approve"); assert.equal((await read()).timesheet.status, "approved");
      await Timesheet.updateOne({ company, employee, attendanceDate: day }, { $set: { payrollLockedAt: new Date() } });
      await act(admin, "reopen", {}, 409);
      await Timesheet.updateOne({ company, employee, attendanceDate: day }, { $set: { payrollLockedAt: null } });
      await act(employee, "reopen", {}, 403); await act(admin, "reopen");
      await submit(); await act(admin, "return", { comment: "x" }, 422); await act(admin, "return");
      assert.equal((await read()).timesheet.status, "returned");
      const saveReturned = async () => { const d = await read(); return call(employee, daily, "PUT", { revision: d.timesheet.revision, requestId: `returned-draft-${++sequence}`, entries: [entry("14:00", "18:00", { notes: "Corrected allocation" })] }); };
      await saveReturned(); await submit(); await act(admin, "reject"); assert.equal((await read()).timesheet.status, "rejected");
      await saveReturned();
      await User.updateOne({ _id: employee }, { $set: { reportingManager: null } });
      await submit({}, 422);
      await User.updateOne({ _id: employee }, { $set: { reportingManager: employee } });
      await submit({}, 422);
      await User.updateOne({ _id: employee }, { $set: { reportingManager: admin } });
      await User.updateOne({ _id: admin }, { $set: { is_enabled: false } });
      await submit({}, 422);
      await User.updateOne({ _id: admin }, { $set: { is_enabled: true } });
      const workflow = await ApprovalWorkflow.create({ company, name: "Timesheet two levels", code: "TIMESHEET_APPROVAL", applicableTo: ["timesheet_submission"], status: "active", createdBy: admin });
      const flowVersion = await ApprovalVersion.create({ company, workflow: workflow._id, versionNumber: 1, status: "published", effectiveFrom: new Date(`${from}T00:00:00Z`), applicableTo: ["timesheet_submission"], autoApprove: false,
        steps: [{ order: 1, name: "Manager", approverType: "reporting_manager", approvalRule: "any", approverUserIds: [], fallbackToHr: false }, { order: 2, name: "Reviewer", approverType: "specific_users", approvalRule: "any", approverUserIds: [otherEmployee], fallbackToHr: false }], createdBy: admin });
      // Change only isolated fixture configuration; production published versions remain immutable.
      await PolicyVersion.updateOne({ _id: versionId }, { $set: { "rules.approvalWorkflowId": String(workflow._id) } });
      await submit();
      const multi = await read(), immutableId = multi.timesheet.currentSubmission;
      await User.updateOne({ _id: employee }, { $set: { reportingManager: otherEmployee } });
      await act(otherEmployee, "approve", {}, 403);
      await act(admin, "approve"); assert.equal((await read()).timesheet.status, "submitted");
      await act(employee, "withdraw", {}, 409);
      assert.equal((await call(otherEmployee, "/api/timesheets/submissions?scope=approvals")).pagination.total, 1);
      await act(otherEmployee, "approve"); assert.equal((await read()).timesheet.status, "approved");
      const immutable = await Submission.findById(immutableId).lean() as any;
      assert.equal(immutable.snapshot.entries[0].notes, "Corrected allocation");
      const instance: any = await ApprovalInstance.findById(immutable.approvalInstance).lean();
      assert.equal(String(instance.workflowVersion), String(flowVersion._id));
      await act(admin, "reopen");
      await ApprovalVersion.create({ company, workflow: workflow._id, versionNumber: 2, status: "published", effectiveFrom: new Date(`${today}T00:00:00Z`), applicableTo: ["timesheet_submission"], autoApprove: true, steps: [], createdBy: admin });
      await submit(); assert.equal((await read()).timesheet.status, "approved", "New submissions use the newly effective workflow version without reassigning");
      await act(admin, "reopen");
      await PolicyVersion.updateOne({ _id: versionId }, { $set: { "rules.approvalWorkflowId": null } });
      await User.updateOne({ _id: employee }, { $set: { reportingManager: admin } });
      await submit();
      await Attendance.updateOne({ company, employee, attendanceDate: day }, { $inc: { revisionNumber: 1 } });
      await act(admin, "approve", {}, 409);
      await act(admin, "return"); await saveReturned(); await submit(); await act(admin, "approve");
      await act(admin, "reopen");
      const shortSaved = await read();
      await call(employee, daily, "PUT", { revision: shortSaved.timesheet.revision, requestId: "short-day-draft-save", entries: [entry("14:00", "16:00")] });
      await submit({}, 422); await submit({ acknowledgeShortfall: true });
      const shortSubmission = await read(); assert.equal(shortSubmission.timesheet.shortfallMinutes, 120);
      const body = { revision: shortSubmission.timesheet.revision, requestId: "duplicate-approve-request", comment: "Accepted two-hour work" };
      const decisionUrl = `/api/timesheets/submissions/${shortSubmission.timesheet.currentSubmission}/approve`;
      await call(admin, decisionUrl, "POST", body);
      const notificationCount = await Notification.countDocuments({ company });
      assert.equal((await call(admin, decisionUrl, "POST", body)).replayed, true);
      assert.equal(await Notification.countDocuments({ company }), notificationCount, "Decision replay must not notify twice");
      assert.ok(await Notification.exists({ company, recipient: admin, eventType: "timesheet.awaiting_approval" }));
      assert.ok(await Notification.exists({ company, recipient: employee, eventType: "timesheet.returned" }));
      assert.equal((await Submission.findById(immutableId).lean() as any).snapshot.entries[0].notes, "Corrected allocation");
      await act(admin, "reopen"); await saveReturned();
      const reviewVersion = async (number: number, steps: any[]) => ApprovalVersion.create({ company, workflow: workflow._id, versionNumber: number, status: "published", effectiveFrom: new Date(`${today}T00:00:00Z`), applicableTo: ["timesheet_submission"], autoApprove: false, steps, createdBy: admin });
      await reviewVersion(3, [{ order: 1, name: "Both reviewers", approverType: "specific_users", approvalRule: "all", approverUserIds: [admin, otherEmployee], fallbackToHr: false }]);
      await PolicyVersion.updateOne({ _id: versionId }, { $set: { "rules.approvalWorkflowId": String(workflow._id) } });
      await submit(); await act(admin, "approve"); assert.equal((await read()).timesheet.status, "submitted"); await act(otherEmployee, "approve");
      assert.equal((await read()).timesheet.status, "approved", "All-approvers step waits for both people");
      await act(admin, "reopen");
      await reviewVersion(4, [{ order: 1, name: "Either reviewer", approverType: "specific_users", approvalRule: "any", approverUserIds: [admin, otherEmployee], fallbackToHr: false }]);
      await submit();
      const raceDay = await read(), raceId = raceDay.timesheet.currentSubmission;
      const decisions = await Promise.all([admin, otherEmployee].map(async (who, index) => {
        const response = await fetch(`${running.base}/api/timesheets/submissions/${raceId}/approve`, { method: "POST", headers: { Authorization: `Bearer ${token(who)}`, "Content-Type": "application/json" }, body: JSON.stringify({ revision: raceDay.timesheet.revision, requestId: `race-decision-${index}`, comment: "Concurrent review" }) }); return response.status;
      }));
      assert.deepEqual(decisions.sort(), [200, 409], "Concurrent decisions cannot both accept the same sheet revision");
      await act(admin, "reopen");
      await reviewVersion(5, [{ order: 1, name: "Manager or scoped HR", approverType: "reporting_manager", approvalRule: "any", approverUserIds: [], fallbackToHr: true }]);
      await User.updateOne({ _id: employee }, { $set: { reportingManager: null } });
      await submit(); const fallbackDay = await read();
      const fallback: any = await Submission.findById(fallbackDay.timesheet.currentSubmission).populate("approvalInstance").lean();
      assert.equal(fallback.approvalInstance.steps[0].fallbackUsed, true); await act(admin, "approve");
      await User.updateOne({ _id: employee }, { $set: { reportingManager: admin } });
      await act(admin, "reopen");
      await Department.updateOne({ _id: department }, { $set: { departmentHead: admin } });
      await reviewVersion(6, [{ order: 1, name: "Manager", approverType: "reporting_manager", approvalRule: "any", approverUserIds: [], fallbackToHr: false }, { order: 2, name: "Department head", approverType: "department_head", approvalRule: "any", approverUserIds: [], fallbackToHr: false }]);
      await submit(); const deduplicatedDay = await read();
      const deduplicated: any = await Submission.findById(deduplicatedDay.timesheet.currentSubmission).populate("approvalInstance").lean();
      assert.equal(deduplicated.approvalInstance.steps[1].status, "skipped", "Same person at multiple levels approves once"); await act(admin, "approve");
      await PolicyVersion.updateOne({ _id: versionId }, { $set: { "rules.approvalWorkflowId": null } });
      if (process.argv.includes("--approvals-ui")) {
        console.log("Phase 4 API assertions passed; starting employee/manager browser workflow");
        await act(admin, "reopen"); await saveReturned();
        const child = spawn(process.execPath, [path.resolve(process.cwd(), "../scripts/verify-timesheet-approval-ui.cjs")], { windowsHide: true, stdio: "inherit", env: { ...process.env, TIMESHEET_TEST_API_URL: running.base, TIMESHEET_TEST_EMPLOYEE_TOKEN: token(employee), TIMESHEET_TEST_ADMIN_TOKEN: token(admin), TIMESHEET_TEST_DAY: day } });
        const code = await new Promise((resolve) => child.on("exit", resolve)); assert.equal(code, 0, "Timesheet approval live UI failed");
      }
      console.log("Phase 4 live passed: immutable submissions, manager snapshot, multi-level/any/all/fallback/deduplicated routing, auto-approval versions, withdrawal/return/reject/resubmit/reopen, stale context, concurrent decisions, shortfall acknowledgement, tenant/self/lock guards and deduplicated notifications");
    }
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
    const collections: mongoose.Model<any>[] = [Company, User, EmployeeHistory, Department, OfficeLocation, Schedule, ScheduleVersion, Calendar, CalendarVersion, WorkforceAssignment, ...models, Attendance, Leave, AttendancePeriod];
    try {
      for (const model of collections) {
        for (let attempt = 0; ; attempt++) {
          try { await model.collection.deleteMany(model === Company ? { _id: { $in: [company, otherCompany] } } : { company: { $in: [company, otherCompany] } }); break; }
          catch (error) { if (attempt >= 2) throw error; await new Promise((resolve) => setTimeout(resolve, 1000)); }
        }
      }
    } finally { await mongoose.disconnect(); }
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
