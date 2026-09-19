import { generateError } from "../../config/Error/functions";
import { classifyEmployeeDay, parseAttendanceDate } from "../attendance/employeeDayContext.utils";
import { normalizeLeaveRole } from "../leave/leaveAccess.utils";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { POLICY_SCOPE_PRIORITY } from "../workforcePolicy/workforcePolicy.utils";

export type CalendarScope = "mine" | "reportees" | "organization";
export type CalendarCategory = "all" | "leave" | "wfh" | "holiday" | "weekly_off";
export const calendarId = (value: any) => String(value?._id || value || "");
const normalized = (value: any) => String(value || "").trim().toLowerCase();

export function calendarDates(fromDate: string, toDate: string) {
  const from = parseAttendanceDate(fromDate);
  const to = parseAttendanceDate(toDate);
  const length = (to.date.getTime() - from.date.getTime()) / 86400000 + 1;
  if (length < 1 || length > 62) throw generateError("Calendar range must contain between 1 and 62 days", 400);
  return Array.from({ length }, (_, index) => new Date(from.date.getTime() + index * 86400000).toISOString().slice(0, 10));
}

export function effectiveOn(record: any, date: string) {
  const at = parseAttendanceDate(date).date.getTime();
  return new Date(record.effectiveFrom).getTime() <= at &&
    (!record.effectiveTo || new Date(record.effectiveTo).getTime() > at);
}

export function calendarOrganizationAccess(actor: any, organization: any) {
  const role = normalizeLeaveRole(actor.role);
  if (["admin", "hradmin"].includes(role)) return true;
  const department = normalized(organization?.departmentNameSnapshot);
  if (role === "departmenthead") return Boolean(department) && department === normalized(actor.department);
  if (role !== "hr") return false;
  const scope = actor.hrScope || {};
  const departments = (scope.departments || []).map(normalized);
  const teams = (scope.teams || []).map(normalized);
  const locations = (scope.officeLocations || []).map(calendarId);
  return departments.includes(department) &&
    (!teams.length || teams.includes(normalized(organization?.teamNameSnapshot))) &&
    (!locations.length || locations.includes(calendarId(organization?.officeLocation)));
}

export function canUseOrganizationCalendar(actor: any) {
  return ["admin", "hradmin", "hr", "departmenthead"].includes(normalizeLeaveRole(actor.role)) &&
    (hasPermission(actor, PERMISSION_KEYS.VIEW_LEAVE_REQUESTS) || hasPermission(actor, PERMISSION_KEYS.VIEW_REMOTE_WORK_REQUESTS));
}

export function calendarEmployeeActive(employee: any, date: string) {
  const start = employee.joiningDate || employee.createdAt;
  const end = employee.employmentEndDate || employee.deletedAt;
  const key = (value: any) => new Date(value).toISOString().slice(0, 10);
  return (!start || key(start) <= date) && (!end || key(end) >= date);
}

export function calendarVisible(actor: any, scope: CalendarScope, employee: any, organization: any, filters: any = {}) {
  if (scope === "mine" && calendarId(employee) !== calendarId(actor)) return false;
  if (scope === "reportees" && (calendarId(organization?.reportingManager) !== calendarId(actor) || calendarId(employee) === calendarId(actor))) return false;
  if (scope === "organization" && !calendarOrganizationAccess(actor, organization)) return false;
  if (filters.employeeId && calendarId(employee) !== filters.employeeId) return false;
  if (filters.departmentId && calendarId(organization?.department) !== filters.departmentId) return false;
  if (filters.teamId && calendarId(organization?.teamId) !== filters.teamId) return false;
  if (filters.officeLocationId && calendarId(organization?.officeLocation) !== filters.officeLocationId) return false;
  if (filters.managerId && calendarId(organization?.reportingManager) !== filters.managerId) return false;
  return true;
}

export function selectCalendarPolicy(assignments: any[], versions: any[], date: string) {
  const assignment = assignments.filter((item) => effectiveOn(item, date)).sort((left, right) =>
    (POLICY_SCOPE_PRIORITY[right.scopeType] || 0) - (POLICY_SCOPE_PRIORITY[left.scopeType] || 0) ||
    new Date(right.effectiveFrom).getTime() - new Date(left.effectiveFrom).getTime()
  )[0];
  if (!assignment) return null;
  const version = versions.filter((item) => calendarId(item.policy || item.schedule || item.calendar) === calendarId(assignment.resource) &&
    item.status === "published" && new Date(item.effectiveFrom).getTime() <= parseAttendanceDate(date).date.getTime()
  ).sort((left, right) => new Date(right.effectiveFrom).getTime() - new Date(left.effectiveFrom).getTime() || right.versionNumber - left.versionNumber)[0];
  return version ? { assignment, version } : null;
}

export function calendarRequestEvent(actor: any, scope: CalendarScope, employee: any, organization: any, kind: "leave" | "wfh", request: any, day: any) {
  const permission = kind === "leave" ? PERMISSION_KEYS.VIEW_LEAVE_REQUESTS : PERMISSION_KEYS.VIEW_REMOTE_WORK_REQUESTS;
  const own = calendarId(request.employee) === calendarId(actor);
  const currentApprover = (request.currentApprovers || []).some((item: any) => calendarId(item) === calendarId(actor));
  const legacyApprover = !request.approvalInstance && calendarId(request.approver) === calendarId(actor);
  const hrViewer = hasPermission(actor, permission) && calendarOrganizationAccess(actor, organization);
  if (scope === "organization" && !hasPermission(actor, permission) && !own && !currentApprover) return null;
  const pending = ["submitted", "manager_approved"].includes(request.status);
  if (request.status !== "approved" && !pending) return null;
  if (pending && !own && !currentApprover && !legacyApprover && !hrViewer) return null;
  if (kind === "leave" && Number(day.chargedUnits || 0) <= 0) return null;
  const privateDetails = own || currentApprover || legacyApprover || hrViewer || calendarId(organization?.reportingManager) === calendarId(actor);
  return {
    id: calendarId(request), kind, status: request.status,
    title: kind === "wfh" ? "Work from home" : privateDetails ? request.leaveTypeNameSnapshot || "Leave" : "On leave",
    code: kind === "leave" && privateDetails ? request.leaveTypeCodeSnapshot || "" : "",
    fromDate: request.fromDate, toDate: request.toDate,
    portion: day.portion || "full", units: kind === "leave" ? day.chargedUnits : day.units,
    unit: kind === "leave" ? request.leaveUnit : "days",
    reason: privateDetails ? request.reason || "" : "",
    canApprove: pending && !own && (currentApprover || legacyApprover),
    canWithdraw: pending && own,
    cancellationPending: kind === "leave" && request.cancellationStatus === "submitted",
    employee: { id: calendarId(employee), name: employee.name || request.employeeNameSnapshot || "Employee", code: employee.code || "" },
  };
}

export function calendarDayClassification(date: string, schedule: any, holidays: any) {
  return classifyEmployeeDay({ attendanceDate: date, workScheduleVersion: schedule?.version || null, holidayCalendarVersion: holidays?.version || null });
}

export function calendarRowMatches(row: any, category: CalendarCategory, includePending: boolean) {
  const events = row.events.filter((event: any) => includePending || event.status === "approved");
  if (category === "leave" || category === "wfh") return events.some((event: any) => event.kind === category);
  if (category === "holiday") return Boolean(row.holiday);
  if (category === "weekly_off") return row.dayType === "weekly_off";
  return events.length > 0 || Boolean(row.holiday) || row.dayType === "weekly_off" || row.dayType === "unconfigured";
}
