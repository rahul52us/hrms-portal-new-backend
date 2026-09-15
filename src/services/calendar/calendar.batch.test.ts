import assert from "node:assert/strict";
import mongoose from "mongoose";
import User from "../../schemas/User/User";
import Department from "../../schemas/Department/Department.schema";
import EmployeeAssignmentHistory from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import WorkforcePolicyAssignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import WorkScheduleVersion from "../../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
import HolidayCalendarVersion from "../../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import RemoteWorkRequest from "../../schemas/Request/RemoteWorkRequest.schema";
import { getCalendarSummaryService } from "./calendar.service";

const company = new mongoose.Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
const department = new mongoose.Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb");
const schedule = new mongoose.Types.ObjectId("cccccccccccccccccccccccc");
const employees = Array.from({ length: 10000 }, (_, index) => ({
  _id: new mongoose.Types.ObjectId((index + 1).toString(16).padStart(24, "0")), company,
  name: `Employee ${index}`, code: `SS-${index}`, joiningDate: "2020-01-01",
}));
let queries = 0;
const originals: Array<() => void> = [];
function query(items: any[]) {
  let limit = items.length;
  const builder: any = { select: () => builder, sort: () => builder, limit: (value: number) => { limit = value; return builder; }, lean: async () => items.slice(0, limit) };
  return builder;
}
function mock(model: any, method: string, implementation: (match: any) => any) {
  const original = model[method];
  originals.push(() => { model[method] = original; });
  model[method] = (...args: any[]) => { queries++; return implementation(args[0]); };
}
const selected = (match: any) => {
  const ids = new Set(match.employee.$in.map((id: any) => String(id)));
  return employees.filter((item) => ids.has(String(item._id)));
};

async function main() {
  mock(User, "find", (match) => query(employees.filter((item) => !match._id?.$gt || String(item._id) > String(match._id.$gt))));
  mock(Department, "find", () => query([{ _id: department, departmentName: "Engineering", teams: [] }]));
  mock(WorkforcePolicyAssignment, "find", () => query([{ resourceType: "work_schedule", scopeType: "company", scopeId: null, resource: schedule, effectiveFrom: "2020-01-01" }]));
  mock(WorkScheduleVersion, "find", () => query([{ _id: schedule, schedule, status: "published", effectiveFrom: "2020-01-01", versionNumber: 1, rules: { workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], saturdayRule: "all_off", startTime: "09:00", endTime: "18:00", timezone: "Asia/Kolkata" } }]));
  mock(HolidayCalendarVersion, "find", () => query([]));
  mock(EmployeeAssignmentHistory, "find", (match) => query(selected(match).map((item) => ({ employee: item._id, department, departmentNameSnapshot: "Engineering", effectiveFrom: "2020-01-01" }))));
  const distinct = EmployeeAssignmentHistory.distinct;
  originals.push(() => { EmployeeAssignmentHistory.distinct = distinct; });
  (EmployeeAssignmentHistory as any).distinct = async (_field: string, match: any) => { queries++; return selected(match).map((item) => item._id); };
  const request = { _id: new mongoose.Types.ObjectId(), employee: employees[0]._id, leaveTypeNameSnapshot: "Casual Leave", leaveUnit: "days", status: "approved", fromDate: "2026-09-14", toDate: "2026-09-14", dayBreakdown: [{ attendanceDate: "2026-09-14", chargedUnits: 1, portion: "full" }] };
  mock(LeaveRequest, "find", (match) => query(match.employee.$in.some((id: any) => String(id) === String(request.employee)) ? [request, { ...request, _id: new mongoose.Types.ObjectId() }] : []));
  mock(RemoteWorkRequest, "find", () => query([]));
  const started = Date.now();
  let result: any;
  let error: any;
  try {
    await getCalendarSummaryService({ user: { _id: employees[9999]._id, role: "hradmin", company, permissions: { view_leave_requests: true, view_remote_work_requests: true } }, query: { scope: "organization", fromDate: "2026-09-01", toDate: "2026-09-30" } }, { json: (value: any) => { result = value; } } as any, (value: any) => { error = value; });
    assert.equal(error, undefined);
    assert.equal(result.data.days.length, 30);
    assert.equal(result.data.days[0].employees, 10000);
    assert.equal(result.data.days.find((day: any) => day.date === "2026-09-13").weeklyOff, 10000);
    assert.equal(result.data.days.find((day: any) => day.date === "2026-09-14").onLeave, 1, "Duplicate requests still count the employee once");
    assert.ok(result.data.days.every((day: any) => day.events.length === 0));
    assert.equal(queries, 205, "Queries scale with 250-employee batches, not employee/day combinations");
    console.log(`10,000-employee calendar batching test passed (205 mocked queries, ${Date.now() - started}ms)`);
  } finally { originals.reverse().forEach((restore) => restore()); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
