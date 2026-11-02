import mongoose from "mongoose";
import User from "../../schemas/User/User";
import History from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import Project from "../../schemas/project/Project.schema";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { calendarId, calendarOrganizationAccess } from "../calendar/calendar.utils";
import { getEmployeeRequestActor, resolveEmployeeRequestCompanyId } from "../leave/leaveAccess.utils";
import { generateError } from "../../config/Error/functions";

export type TimesheetScope = "organization" | "reportees" | "projects";
export async function resolveTimesheetWorkspaceAccess(actor: any) {
  const scopes: TimesheetScope[] = [];
  const companyId = calendarId(actor.company), employeeId = calendarId(actor._id);
  if (actor.role === "superadmin" || !mongoose.Types.ObjectId.isValid(companyId) || !mongoose.Types.ObjectId.isValid(employeeId)) return { canAccessWorkspace: false, scopes, canExport: false };
  const company = new mongoose.Types.ObjectId(companyId), employee = new mongoose.Types.ObjectId(employeeId);
  if (hasPermission(actor, PERMISSION_KEYS.VIEW_TIMESHEETS)) scopes.push("organization");
  const [reports, oldReports, projects] = await Promise.all([
    User.exists({ company, reportingManager: employee, _id: { $ne: employee } }),
    History.exists({ company, reportingManager: employee, employee: { $ne: employee } }),
    hasPermission(actor, PERMISSION_KEYS.VIEW_PROJECTS) ? Project.exists({ company, managers: employee }) : null,
  ]);
  if (reports || oldReports) scopes.push("reportees");
  if (projects) scopes.push("projects");
  return { canAccessWorkspace: Boolean(scopes.length) || hasPermission(actor, PERMISSION_KEYS.MANAGE_PAYROLL_RUNS), scopes, canExport: hasPermission(actor, PERMISSION_KEYS.EXPORT_TIMESHEETS) };
}
export function timesheetOrganizationAllowed(actor: any, organization: any) {
  if (!hasPermission(actor, PERMISSION_KEYS.VIEW_TIMESHEETS)) return false;
  if (["hr", "departmenthead"].includes(actor.role)) return calendarOrganizationAccess(actor, organization);
  return true;
}
export function timesheetEmployeeAllowed(ctx: any, employee: any, organization: any) {
  if (!organization._id && (ctx.scope === "reportees" || ["hr", "departmenthead"].includes(ctx.actor.role))) return false;
  return ctx.scope === "organization" ? timesheetOrganizationAllowed(ctx.actor, organization)
    : ctx.scope === "reportees" && calendarId(organization.reportingManager) === calendarId(ctx.actor) && calendarId(employee) !== calendarId(ctx.actor);
}
export async function timesheetOperationsContext(req: any) {
  const actor = getEmployeeRequestActor(req);
  if (actor.role === "superadmin") throw generateError("Timesheet operations require a company account", 403);
  const company = resolveEmployeeRequestCompanyId(actor, req.query.companyId, "timesheet");
  const access = await resolveTimesheetWorkspaceAccess(actor);
  const scope = String(req.query.scope || access.scopes[0] || "") as TimesheetScope;
  if (!access.scopes.includes(scope)) throw generateError("This timesheet scope is not available to your account", 403);
  return { actor, company, access, scope };
}

export async function loadTimesheetScopedEmployee(ctx: any, employeeId: any, date: string) {
  if (ctx.scope === "projects") throw generateError("Project reports do not expose employee-day details", 403);
  const employee: any = await User.findOne({ _id: employeeId, company: ctx.company }).select("_id name code department team officeLocation reportingManager joiningDate employmentEndDate").lean();
  if (!employee) throw generateError("Employee not found", 404);
  const at = new Date(`${date}T00:00:00Z`);
  const organization: any = await History.findOne({ company: ctx.company, employee: employeeId, effectiveFrom: { $lte: at }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }] }).sort({ effectiveFrom: -1 }).lean() || { departmentNameSnapshot: employee.department || "", teamNameSnapshot: employee.team || "", officeLocation: employee.officeLocation, reportingManager: employee.reportingManager, source: "missing_history" };
  if (!timesheetEmployeeAllowed(ctx, employee, organization)) throw generateError("Employee is outside your timesheet scope", 403);
  return { employee, organization };
}
