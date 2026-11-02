import assert from "node:assert/strict";
import mongoose from "mongoose";
import User from "../../schemas/User/User";
import History from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import Assignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import Schedule from "../../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
import Calendar from "../../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
import Policy from "../../schemas/WorkforcePolicy/TimesheetPolicyVersion.schema";
import AttendancePolicy from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import LeavePolicy from "../../schemas/WorkforcePolicy/LeavePolicyVersion.schema";
import RemotePolicy from "../../schemas/WorkforcePolicy/RemoteWorkPolicyVersion.schema";
import Attendance from "../../schemas/Attendance/AttendanceRecord.schema";
import Leave from "../../schemas/Leave/LeaveRequest.schema";
import Membership from "../../schemas/project/ProjectAssignment.schema";
import Timesheet from "../../schemas/Timesheet/Timesheet.schema";
import DayControl from "../../schemas/Timesheet/TimesheetDayControl.schema";
import Company from "../../schemas/company/Company";
import AttendancePeriod from "../../schemas/Attendance/AttendancePeriod.schema";
import { loadTimesheetRegister, loadTimesheetMonthly } from "./timesheetOperations.service";
import { DEFAULT_TIMESHEET_RULES } from "./timesheetRules.utils";
const company = new mongoose.Types.ObjectId(), schedule = new mongoose.Types.ObjectId(), calendar = new mongoose.Types.ObjectId(), policy = new mongoose.Types.ObjectId();
const employees = Array.from({ length: 10000 }, (_, i) => ({ _id: new mongoose.Types.ObjectId((i + 1).toString(16).padStart(24, "0")), company, name: `Employee ${i}`, code: `SS-${i}`, joiningDate: new Date("2026-01-01") }));
let queries = 0, maxPolicyBatch = 0, cycleMode = false;
const restorers: Array<() => void> = [];
function query(items: any[]) { let limit = items.length; const result: any = { select: () => result, sort: () => result, limit: (n: number) => { limit = n; return result; }, lean: async () => items.slice(0, limit) }; return result; }
function mock(model: any, action: (match: any) => any[]) { const original = model.find; restorers.push(() => { model.find = original; }); model.find = (match: any) => { queries++; return query(action(match)); }; }
function selected(match: any) { const ids = new Set(match.employee.$in.map(String)); return employees.filter((e) => ids.has(String(e._id))); }
async function run() {
  try {
    mock(User, (match) => employees.filter((e) => !match._id?.$gt || String(e._id) > String(match._id.$gt)));
    mock(History, (match) => selected(match).map((e) => ({ _id: e._id, employee: e._id, departmentNameSnapshot: "Engineering", effectiveFrom: "2026-01-01" })));
    mock(Assignment, () => [["work_schedule", schedule], ["holiday_calendar", calendar], ["timesheet_policy", policy]].map(([resourceType, resource]) => ({ _id: resource, company, resourceType, resource, scopeType: "company", scopeId: null, effectiveFrom: "2026-01-01" })));
    mock(Schedule, () => [{ _id: schedule, schedule, status: "published", effectiveFrom: "2026-01-01", versionNumber: 1, rules: { timezone: "Asia/Kolkata", workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], saturdayRule: "all_off", startTime: "09:30", endTime: "18:30", unpaidBreakMinutes: 60 } }]);
    mock(Calendar, () => [{ _id: calendar, calendar, status: "published", effectiveFrom: "2026-01-01", holidays: [] }]);
    mock(Policy, () => [{ _id: policy, policy, status: "published", effectiveFrom: "2026-01-01", rules: cycleMode ? { ...DEFAULT_TIMESHEET_RULES, deadlineMode: "payroll_cycle", payrollCutoffEnabled: true } : DEFAULT_TIMESHEET_RULES }]);
    mock(AttendancePeriod, () => []);
    const findCompany = Company.findById;
    restorers.push(() => { Company.findById = findCompany; });
    Company.findById = (() => { queries++; const result: any = { select: () => result, lean: async () => ({ payrollSettings: { attendanceCutoffDay: 25 } }) }; return result; }) as any;
    for (const model of [AttendancePolicy, LeavePolicy, RemotePolicy, Attendance, Leave, Timesheet, DayControl]) mock(model, () => []);
    mock(Membership, (match) => { maxPolicyBatch = Math.max(maxPolicyBatch, match.employee.$in.length); return selected(match).map((e) => ({ employee: e._id, effectiveFrom: "2026-01-01" })); });
    const ctx = { company, actor: { role: "hradmin", permissions: { view_timesheets: true } }, scope: "organization", filters: { status: "all", search: "" }, dates: ["2026-10-26"] };
    const started = Date.now(), daily = await loadTimesheetRegister(ctx, 2, 25);
    assert.equal(daily.pagination.total, 10000); assert.equal(daily.data.length, 25); assert.equal(daily.data[0].employee.name, "Employee 25");
    assert.equal(daily.summary.requiredMinutes, 4800000); assert.ok(queries < 650, `Unexpected per-employee queries: ${queries}`); assert.ok(maxPolicyBatch <= 250);
    const dailyQueries = queries; queries = 0; maxPolicyBatch = 0;
    const monthly = await loadTimesheetMonthly({ ...ctx, dates: ["2026-10-26", "2026-10-27"] }, 1, 25);
    assert.equal(monthly.pagination.total, 10000); assert.equal(monthly.data.length, 25); assert.equal(monthly.summary.rows, 50);
    assert.equal(maxPolicyBatch, 25, "Monthly calculations load selected employee page only"); assert.ok(queries < 110);
    const monthlyQueries = queries; queries = 0; cycleMode = true;
    const cycleDaily = await loadTimesheetRegister(ctx, 1, 25);
    assert.equal(cycleDaily.pagination.total, 10000); assert.equal(cycleDaily.summary.requiredMinutes, 4800000);
    assert.ok(queries <= dailyQueries + 80, `Cycle lookup must be per 250-employee batch, not per employee: ${queries}`);
    console.log(`10,000-employee operations batching passed: Daily ${dailyQueries}, Monthly ${monthlyQueries}, Cycle daily ${queries} queries; selected-page targets; ${Date.now() - started}ms`);
  } finally { restorers.reverse().forEach((restore) => restore()); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
