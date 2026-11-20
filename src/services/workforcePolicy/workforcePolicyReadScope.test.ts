import assert from "node:assert/strict";
import mongoose from "mongoose";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import Department from "../../schemas/Department/Department.schema";
import History from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import Assignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import Audit from "../../schemas/WorkforcePolicy/WorkforcePolicyAuditLog.schema";
import Attendance from "../../schemas/WorkforcePolicy/AttendancePolicy.schema";
import AttendanceVersion from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import Schedule from "../../schemas/WorkforcePolicy/WorkSchedule.schema";
import ScheduleVersion from "../../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
import Calendar from "../../schemas/WorkforcePolicy/HolidayCalendar.schema";
import CalendarVersion from "../../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
import Leave from "../../schemas/WorkforcePolicy/LeavePolicy.schema";
import LeaveVersion from "../../schemas/WorkforcePolicy/LeavePolicyVersion.schema";
import LeaveType from "../../schemas/WorkforcePolicy/LeaveType.schema";
import Remote from "../../schemas/WorkforcePolicy/RemoteWorkPolicy.schema";
import RemoteVersion from "../../schemas/WorkforcePolicy/RemoteWorkPolicyVersion.schema";
import Timesheet from "../../schemas/WorkforcePolicy/TimesheetPolicy.schema";
import TimesheetVersion from "../../schemas/WorkforcePolicy/TimesheetPolicyVersion.schema";
import Workflow from "../../schemas/Approval/ApprovalWorkflow.schema";
import WorkflowVersion from "../../schemas/Approval/ApprovalWorkflowVersion.schema";
import { listAttendancePoliciesService, getAttendancePolicyService } from "./attendancePolicy.service";
import { listWorkSchedulesService, getWorkScheduleService } from "./workSchedule.service";
import { listHolidayCalendarsService, getHolidayCalendarService } from "./holidayCalendar.service";
import { listLeavePoliciesService, getLeavePolicyService, listLeaveTypesService } from "./leavePolicy.service";
import { listRemoteWorkPoliciesService, getRemoteWorkPolicyService } from "./remoteWorkPolicy.service";
import { listTimesheetPolicies, getTimesheetPolicy } from "./timesheetPolicy.service";
import { listPolicyAssignmentsService, listPolicyAuditLogService, getPolicyCoverageService } from "./policyAssignment.service";
import { listApprovalWorkflowsService, getApprovalWorkflowService } from "../approval/approvalWorkflow.service";
import { workforceEmployeeReadScope } from "./workforcePolicyReadScope";

const id = () => new mongoose.Types.ObjectId();
const eq = (left: any, right: any) => left == null && right == null || String(left) === String(right);
function matches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, value]: any) => {
    if (key === "$and") return value.every((part: any) => matches(row, part));
    if (key === "$or") return value.some((part: any) => matches(row, part));
    const actual = row[key];
    if (value instanceof RegExp) return value.test(String(actual || ""));
    if (value && typeof value === "object" && !(value instanceof mongoose.Types.ObjectId) && !(value instanceof Date)) {
      return Object.entries(value).every(([operator, expected]: any) => {
        if (operator === "$in") return expected.some((item: any) => item instanceof RegExp ? item.test(String(actual)) : eq(actual, item));
        if (operator === "$regex") return expected.test(String(actual || ""));
        if (operator === "$exists") return (actual !== undefined) === expected;
        if (operator === "$lte") return actual != null && actual <= expected;
        if (operator === "$gt") return actual != null && actual > expected;
        throw new Error(`Unsupported fixture operator ${operator}`);
      });
    }
    return eq(actual, value);
  });
}

async function main() {
  const company = id(), otherCompany = id(), department = id(), otherDepartment = id(), team = id(), otherTeam = id(), location = id(), otherLocation = id();
  const employee = { _id: id(), company, role: "user", name: "Own employee", department: "Python", team: "SAP", officeLocation: location };
  const otherEmployee = { ...employee, _id: id(), name: "Other employee", department: "Sales", officeLocation: otherLocation };
  const head = { _id: id(), company: String(company), role: "departmenthead", department: "pYtHoN", effectivePermissions: { view_workforce_policies: true, manage_workforce_policies: false } };
  const admin = { ...head, role: "hradmin", effectivePermissions: { view_workforce_policies: true, manage_workforce_policies: true } };
  const workflow = id(), foreignWorkflow = id(), leaveType = id(), foreignLeaveType = id();
  const data = new Map<any, any[]>(), originals: Array<() => void> = [];
  const definitions: any[] = [
    ["attendance_policy", Attendance, AttendanceVersion, "policy", "policyId", listAttendancePoliciesService, getAttendancePolicyService],
    ["work_schedule", Schedule, ScheduleVersion, "schedule", "scheduleId", listWorkSchedulesService, getWorkScheduleService],
    ["holiday_calendar", Calendar, CalendarVersion, "calendar", "calendarId", listHolidayCalendarsService, getHolidayCalendarService],
    ["leave_policy", Leave, LeaveVersion, "policy", "policyId", listLeavePoliciesService, getLeavePolicyService],
    ["remote_work_policy", Remote, RemoteVersion, "policy", "policyId", listRemoteWorkPoliciesService, getRemoteWorkPolicyService],
    ["timesheet_policy", Timesheet, TimesheetVersion, "policy", "policyId", listTimesheetPolicies, getTimesheetPolicy],
  ];
  data.set(Company, [{ _id: company, company_name: "Fixture company" }]);
  data.set(User, [employee, otherEmployee]);
  data.set(Department, [{ _id: department, company, departmentName: "Python", teams: [{ _id: team, name: "SAP" }] }, { _id: otherDepartment, company, departmentName: "Sales", teams: [{ _id: otherTeam, name: "Sales team" }] }]);
  data.set(History, [employee, otherEmployee].map((person) => ({ _id: id(), company, employee: person._id, department: person === employee ? department : otherDepartment, teamId: person === employee ? team : otherTeam, effectiveFrom: new Date("2026-01-01"), effectiveTo: null })));
  data.set(Assignment, []); data.set(Audit, []);
  const labels = ["company", "department", "team", "location", "employee", "other", "unassigned"];
  for (const [type, root, version, parent] of definitions) {
    const roots = labels.map((name) => ({ _id: id(), company, name, code: name, status: "active" }));
    data.set(root, roots);
    data.set(version, roots.flatMap((resource) => ["published", "draft"].map((status, index) => ({
      _id: id(), company, [parent]: resource._id, status, versionNumber: index + 1, effectiveFrom: new Date("2026-01-01"),
      rules: type === "leave_policy" ? [{ leaveType, requestApprovalWorkflow: workflow, encashmentApprovalWorkflow: workflow, compOffClaimApprovalWorkflow: workflow }] : { approvalWorkflowId: workflow, regularization: { approvalWorkflow: workflow } },
    }))));
    labels.slice(0, 6).forEach((label, index) => {
      const scopeType = label === "other" ? "department" : label;
      const scopeId = [null, department, team, location, employee._id, otherDepartment][index];
      data.get(Assignment)!.push({ _id: id(), company, resourceType: type, resource: roots[index]._id, scopeType, scopeId, effectiveFrom: new Date("2026-01-01"), effectiveTo: null });
    });
    // A shared policy's assignment count must not reveal assignments in another department.
    data.get(Assignment)!.push({ _id: id(), company, resourceType: type, resource: roots[1]._id, scopeType: "department", scopeId: otherDepartment, effectiveFrom: new Date("2026-01-01") });
  }
  data.set(Workflow, [{ _id: workflow, company, name: "Own flow", status: "active" }, { _id: foreignWorkflow, company, name: "Other flow", status: "active" }]);
  data.set(WorkflowVersion, [workflow, foreignWorkflow].flatMap((item) => ["published", "draft"].map((status) => ({ _id: id(), company, workflow: item, status, versionNumber: 1, effectiveFrom: new Date("2026-01-01") }))));
  data.set(LeaveType, [{ _id: leaveType, company, name: "CL" }, { _id: foreignLeaveType, company, name: "Other" }]);
  data.set(Audit, data.get(Assignment)!.map((assignment) => ({ _id: id(), company, entityType: "assignment", entityId: assignment._id })));
  data.get(Audit)!.push({ _id: id(), company, entityType: "attendance_policy", entityId: data.get(Attendance)![0]._id });

  function query(rows: any[], single = false) {
    let offset = 0, limit = rows.length, ordered = [...rows];
    const value = () => single ? ordered[0] ? { ...ordered[0], toObject: () => ordered[0] } : null : ordered.slice(offset, offset + limit);
    return {
      select() { return this; }, populate() { return this; }, session() { return this; },
      sort(order: any) { ordered.sort((a, b) => { for (const [key, direction] of Object.entries(order)) { if (!eq(a[key], b[key])) return (a[key] > b[key] ? 1 : -1) * Number(direction); } return 0; }); return this; },
      skip(number: number) { offset = number; return this; }, limit(number: number) { limit = number; return this; },
      lean: async () => value(), exec: async () => value(), then(resolve: any, reject: any) { return Promise.resolve(value()).then(resolve, reject); },
    };
  }
  for (const [model, rows] of data) {
    for (const method of ["find", "findOne", "countDocuments", "distinct", "aggregate"]) {
      const original = model[method]; originals.push(() => { model[method] = original; });
    }
    model.find = (filter: any) => query(rows.filter((row) => matches(row, filter)));
    model.findOne = (filter: any) => query(rows.filter((row) => matches(row, filter)), true);
    model.countDocuments = async (filter: any) => rows.filter((row) => matches(row, filter)).length;
    model.distinct = (field: string, filter: any) => query([...new Map(rows.filter((row) => matches(row, filter)).map((row) => [String(row[field]), row[field]])).values()].filter((value) => value != null));
    model.aggregate = async (pipeline: any[]) => {
      const selected = rows.filter((row) => matches(row, pipeline[0].$match));
      if (model === TimesheetVersion) return selected.map((row) => ({ _id: { policy: row.policy, status: row.status }, version: row }));
      return [...new Set(selected.map((row) => String(row.resource)))].map((resource) => ({ _id: resource, count: selected.filter((row) => eq(row.resource, resource)).length }));
    };
  }
  let assertions = 0;
  const call = async (handler: any, actor: any = head, query: any = {}, params: any = {}) => {
    let response: any, error: any;
    await handler({ user: actor, query, params, body: {} }, { status() { return this; }, json(value: any) { response = value; return this; } }, (failure: any) => { error = failure; });
    if (error) throw error;
    assertions++;
    return response;
  };
  try {
    for (const [, root, , , parameter, list, detail] of definitions) {
      const roots = data.get(root)!;
      const result = await call(list);
      assert.deepEqual(result.data.map((item: any) => item.name).sort(), labels.slice(0, 5).sort());
      assert.equal(result.pagination.total, 5);
      assert.ok(result.data.every((item: any) => !item.draftVersion));
      assert.equal(result.data.find((item: any) => item.name === "department").assignmentCount, 1);
      assert.equal((await call(list, head, { limit: 1 })).data.length, 1);
      assert.equal((await call(list, head, { search: "other" })).pagination.total, 0);
      for (const resource of roots.slice(5)) await assert.rejects(call(detail, head, {}, { [parameter]: String(resource._id) }), (error: any) => error.statusCode === 404);
      await assert.rejects(call(detail, head, {}, { [parameter]: "invalid-id" }), (error: any) => error.statusCode === 400);
      const ownDetail = await call(detail, head, {}, { [parameter]: String(roots[1]._id) });
      assert.ok(ownDetail.data.versions.every((version: any) => version.status === "published"));
      for (const actor of [admin, { ...admin, role: "admin" }, { ...head, effectivePermissions: admin.effectivePermissions }]) {
        assert.equal((await call(list, actor)).pagination.total, 7);
      }
      await assert.rejects(call(list, { ...head, department: "" }), (error: any) => error.statusCode === 403);
      await assert.rejects(call(list, head, { companyId: String(otherCompany) }), (error: any) => error.statusCode === 403);
    }
    const assignments = await call(listPolicyAssignmentsService);
    assert.equal(assignments.pagination.total, 30);
    assert.ok(assignments.data.every((row: any) => !eq(row.scopeId, otherDepartment)));
    assert.equal((await call(listPolicyAssignmentsService, head, { scopeType: "department" })).pagination.total, 6);
    const audit = await call(listPolicyAuditLogService);
    assert.equal(audit.pagination.total, 30);
    assert.equal((await call(listPolicyAuditLogService, head, { entityType: "attendance_policy" })).pagination.total, 0);
    const hidden = data.get(Assignment)!.find((row) => eq(row.scopeId, otherDepartment));
    assert.equal((await call(listPolicyAuditLogService, head, { entityId: String(hidden._id) })).pagination.total, 0);
    assert.equal((await call(listApprovalWorkflowsService)).pagination.total, 1);
    await assert.rejects(call(getApprovalWorkflowService, head, {}, { workflowId: String(foreignWorkflow) }), (error: any) => error.statusCode === 404);
    assert.ok((await call(getApprovalWorkflowService, head, {}, { workflowId: String(workflow) })).data.versions.every((row: any) => row.status === "published"));
    assert.equal((await call(listLeaveTypesService)).pagination.total, 1);
    for (const actor of [head, { ...head, effectivePermissions: admin.effectivePermissions }]) {
      const coverage = await call(getPolicyCoverageService, actor, { at: "2026-11-20", search: "employee" });
      assert.equal(coverage.pagination.total, 1);
      assert.equal(String(coverage.data[0].employee._id), String(employee._id));
    }
    assert.equal((await call(getPolicyCoverageService, head, { search: "Other employee" })).pagination.total, 0);
    const hr = { ...head, role: "hr", hrScope: { departments: ["Python"], teams: ["SAP"], officeLocations: [location] } };
    assert.equal((await call(getPolicyCoverageService, hr)).pagination.total, 1);
    assert.equal((await call(listAttendancePoliciesService, hr)).pagination.total, 5);
    assert.equal((await call(getPolicyCoverageService, { ...hr, hrScope: { ...hr.hrScope, teams: ["different"] } })).pagination.total, 0);
    assert.throws(() => workforceEmployeeReadScope({ ...hr, hrScope: {} }), (error: any) => error.statusCode === 403);
    assert.throws(() => workforceEmployeeReadScope({ ...hr, hrScope: { departments: ["Python"], officeLocations: ["invalid"] } }), (error: any) => error.statusCode === 403);
    assert.equal((await call(getPolicyCoverageService, admin)).pagination.total, 2);
  } finally { originals.reverse().forEach((restore) => restore()); }
  console.log(`Policy read-scope regression passed: ${assertions} successful handler calls plus denied direct-ID/tenant/scope cases. Two-department in-memory query fixtures; no HTTP requests or database writes.`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
