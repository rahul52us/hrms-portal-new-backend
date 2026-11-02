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
import { buildEmployeeDayContext } from "../attendance/employeeDayContext.utils";
import { calendarEmployeeActive, effectiveOn, selectCalendarPolicy } from "../calendar/calendar.utils";
import { buildTimesheetDay, timesheetContextSnapshot, timesheetWorkFingerprint } from "./timesheetContext.service";
import { dateInZone } from "./timesheet.utils";
import { plannerDaySummary } from "./timesheetPlanner.utils";
import { organizationFilters, tsId } from "./timesheetOperations.utils";
import { timesheetEmployeeAllowed } from "./timesheetOperationsAccess.service";
import { usesPayrollCutoff } from "./timesheetDeadline.utils";
import { loadTimesheetCycles } from "./timesheetCycle.service";

const employeeFields = "_id name code company department team officeLocation reportingManager joiningDate createdAt employmentEndDate deletedAt";
export function effectiveOrganization(employee: any, histories: any[], date: string) {
  return histories.find((history) => effectiveOn(history, date)) || { departmentNameSnapshot: employee.department || "", teamNameSnapshot: employee.team || "", officeLocation: employee.officeLocation, reportingManager: employee.reportingManager, source: "missing_history" };
}
export async function visitOperationsEmployees(ctx: any, dates: string[], visit: (employee: any, histories: any[], visibleDates: string[]) => Promise<boolean | void> | boolean | void) {
  let after: any = null;
  const start = new Date(`${dates[0]}T00:00:00Z`), end = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  for (;;) {
    const match: any = { company: ctx.company, role: { $ne: "superadmin" } };
    if (ctx.filters.employeeId) match._id = new mongoose.Types.ObjectId(ctx.filters.employeeId);
    if (after) match._id = ctx.filters.employeeId ? { $eq: new mongoose.Types.ObjectId(ctx.filters.employeeId), $gt: after } : { $gt: after };
    if (ctx.filters.search) { const regex = new RegExp(ctx.filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); match.$or = [{ name: regex }, { code: regex }]; }
    const employees: any[] = await User.find(match).select(employeeFields).sort({ _id: 1 }).limit(250).lean();
    if (!employees.length) break;
    const histories: any[] = await History.find({ company: ctx.company, employee: { $in: employees.map((e) => e._id) }, effectiveFrom: { $lte: end }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: start } }] }).sort({ effectiveFrom: -1 }).lean();
    for (const employee of employees) {
      const ownHistory = histories.filter((h) => tsId(h.employee) === tsId(employee));
      const visibleDates = dates.filter((date) => {
        const org = effectiveOrganization(employee, ownHistory, date);
        return calendarEmployeeActive(employee, date) && timesheetEmployeeAllowed(ctx, employee, org) && organizationFilters(org, ctx.filters);
      });
      if (visibleDates.length && await visit(employee, ownHistory, visibleDates) === false) return;
    }
    after = employees[employees.length - 1]._id;
  }
}

export async function buildOperationsDays(company: any, employees: any[], dates: string[], suppliedHistories?: any[], now = new Date(), includeDetails = false, session?: mongoose.ClientSession, proposal?: { policy: any; version: any; assignment?: any }) {
  if (!employees.length) return [];
  const q = (query: any) => session ? query.session(session) : query;
  const ids = employees.map((e) => e._id), from = dates[0], to = dates[dates.length - 1], start = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  const histories: any[] = suppliedHistories || await q(History.find({ company, employee: { $in: ids }, effectiveFrom: { $lte: end }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: start } }] })).sort({ effectiveFrom: -1 }).lean();
  const scopes: any[] = [{ scopeType: "company", scopeId: null }, { scopeType: "employee", scopeId: { $in: ids } }];
  for (const [type, field] of [["department", "department"], ["team", "teamId"], ["location", "officeLocation"]]) {
    const values = [...new Set([...histories.map((h) => h[field]), ...(type === "location" ? employees.map((e) => e.officeLocation) : [])].filter(Boolean).map(tsId))].filter(mongoose.Types.ObjectId.isValid);
    if (values.length) scopes.push({ scopeType: type, scopeId: { $in: values.map((id) => new mongoose.Types.ObjectId(id)) } });
  }
  const assignments: any[] = await q(Assignment.find({ company, resourceType: { $in: ["work_schedule", "holiday_calendar", "timesheet_policy", "attendance_policy", "leave_policy", "remote_work_policy"] }, effectiveFrom: { $lte: end }, $and: [{ $or: [{ effectiveTo: null }, { effectiveTo: { $gt: start } }] }, { $or: scopes }] })).lean();
  if (proposal?.assignment) {
    for (let i = assignments.length - 1; i >= 0; i--) if (assignments[i].resourceType === "timesheet_policy" && assignments[i].scopeType === proposal.assignment.scopeType && tsId(assignments[i].scopeId) === tsId(proposal.assignment.scopeId)) assignments.splice(i, 1);
    assignments.push(proposal.assignment);
  }
  const resources = (type: string) => assignments.filter((a) => a.resourceType === type).map((a) => a.resource);
  const [schedules, calendars, policies, records, leaves, memberships, sheets, attendancePolicies, leavePolicies, remotePolicies, controls] = await Promise.all([
    q(Schedule.find({ company, schedule: { $in: resources("work_schedule") }, status: "published", effectiveFrom: { $lte: end } })).lean(),
    q(Calendar.find({ company, calendar: { $in: resources("holiday_calendar") }, status: "published", effectiveFrom: { $lte: end } })).lean(),
    q(Policy.find({ company, policy: { $in: resources("timesheet_policy") }, status: "published", effectiveFrom: { $lte: end } })).lean(),
    q(Attendance.find({ company, employee: { $in: ids }, attendanceDate: { $gte: from, $lte: to } })).select("employee attendanceDate state status workMode revisionNumber punchSessions hasMissingPunch workedMinutes").lean(),
    q(Leave.find({ company, employee: { $in: ids }, status: "approved", "dayBreakdown.attendanceDate": { $gte: from, $lte: to } })).select("employee unit dayBreakdown updatedAt").lean(),
    q(Membership.find({ company, employee: { $in: ids }, status: "assigned", effectiveFrom: { $lte: to }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: from } }] })).select("employee effectiveFrom effectiveTo").lean(),
    q(Timesheet.find({ company, employee: { $in: ids }, attendanceDate: { $gte: from, $lte: to } })).select(includeDetails ? "" : "employee attendanceDate status revision loggedMinutes requiredMinutes payrollLockedAt currentSubmission contextSnapshot entries.project entries.workType").lean(),
    q(AttendancePolicy.find({ company, policy: { $in: resources("attendance_policy") }, status: "published", effectiveFrom: { $lte: end } })).select("policy status effectiveFrom versionNumber").lean(),
    q(LeavePolicy.find({ company, policy: { $in: resources("leave_policy") }, status: "published", effectiveFrom: { $lte: end } })).select("policy status effectiveFrom versionNumber").lean(),
    q(RemotePolicy.find({ company, policy: { $in: resources("remote_work_policy") }, status: "published", effectiveFrom: { $lte: end } })).select("policy status effectiveFrom versionNumber").lean(),
    q(DayControl.find({ company, employee: { $in: ids }, attendanceDate: { $gte: from, $lte: to } })).lean(),
  ]);
  if (proposal) policies.push(proposal.version);
  const cycles = policies.some((policy: any) => usesPayrollCutoff(policy.rules)) ? await loadTimesheetCycles(company, from, to, session) : null;
  const clockCache = new Map<string, any>(), rows: any[] = [], todayCache = new Map<string, string>();
  const indexed = new Map<string, any[]>();
  for (const [kind, items] of [["history", histories], ["leave", leaves], ["membership", memberships], ["record", records], ["sheet", sheets], ["control", controls]] as Array<[string, any[]]>) for (const item of items) { const key = `${kind}:${tsId(item.employee)}`; indexed.set(key, [...(indexed.get(key) || []), item]); }
  const assignmentIndex = new Map<string, any[]>();
  for (const a of assignments) { const key = `${a.resourceType}:${a.scopeType}:${tsId(a.scopeId)}`; assignmentIndex.set(key, [...(assignmentIndex.get(key) || []), a]); }
  for (const employee of employees) for (const date of dates) {
    if (!calendarEmployeeActive(employee, date)) continue;
    const employeeId = tsId(employee), organization = effectiveOrganization(employee, indexed.get(`history:${employeeId}`) || [], date);
    const scopeValues = [["company", ""], ["employee", employeeId], ["department", tsId(organization.department)], ["team", tsId(organization.teamId)], ["location", tsId(organization.officeLocation)]];
    const resolve = (kind: string, versions: any[]) => selectCalendarPolicy(scopeValues.flatMap(([type, value]) => assignmentIndex.get(`${kind}:${type}:${value}`) || []), versions, date);
    const context = buildEmployeeDayContext({ attendanceDate: date, policyResolution: { employee, at: new Date(`${date}T00:00:00Z`), organizationAssignment: organization, workSchedule: resolve("work_schedule", schedules), holidayCalendar: resolve("holiday_calendar", calendars), timesheetPolicy: resolve("timesheet_policy", policies), attendancePolicy: resolve("attendance_policy", attendancePolicies), leavePolicy: resolve("leave_policy", leavePolicies), remoteWorkPolicy: resolve("remote_work_policy", remotePolicies) } });
    const record = (indexed.get(`record:${employeeId}`) || []).find((r) => r.attendanceDate === date), sheet = (indexed.get(`sheet:${employeeId}`) || []).find((s) => s.attendanceDate === date);
    const day = buildTimesheetDay({ employee: { ...employee, is_enabled: true }, context, record, leaves: indexed.get(`leave:${employeeId}`) || [], assigned: (indexed.get(`membership:${employeeId}`) || []).some((m) => m.effectiveFrom <= date && (!m.effectiveTo || m.effectiveTo >= date)), now, clockCache, control: (indexed.get(`control:${employeeId}`) || []).find((c) => c.attendanceDate === date), cycle: cycles?.get(date) });
    const zone = context.timezone || "UTC";
    if (!todayCache.has(zone)) todayCache.set(zone, dateInZone(now, zone));
    const compact = plannerDaySummary(day, sheet, todayCache.get(zone)!);
    const stale = Boolean(sheet && (sheet.requiredMinutes !== day.requirement.requiredMinutes || timesheetWorkFingerprint(sheet.contextSnapshot) !== timesheetWorkFingerprint(timesheetContextSnapshot(day))));
    rows.push({ ...compact, ...(includeDetails ? { _day: day, _sheet: sheet } : {}), employee: { _id: employeeId, name: employee.name, code: employee.code }, organization,
      shortfallMinutes: date > todayCache.get(zone)! ? 0 : compact.shortfallMinutes,
      shortHours: Boolean(sheet && (compact.shortfallMinutes || 0) > 0), overdue: day.eligibility.overdue && !["submitted", "approved"].includes(sheet?.status),
      approvedMinutes: sheet?.status === "approved" ? sheet.loggedMinutes : 0, stale, sheetId: sheet ? tsId(sheet) : null, currentSubmission: tsId(sheet?.currentSubmission) || null,
      projectIds: [...new Set((sheet?.entries || []).map((e: any) => tsId(e.project)))], workTypeIds: [...new Set((sheet?.entries || []).map((e: any) => tsId(e.workType)))],
      workAssignments: (sheet?.entries || []).map((e: any) => ({ projectId: tsId(e.project), workTypeId: tsId(e.workType) })),
    });
  }
  return rows;
}
