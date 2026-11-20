import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import Department from "../../schemas/Department/Department.schema";
import User from "../../schemas/User/User";
import Assignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import AttendanceVersion from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import ScheduleVersion from "../../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
import CalendarVersion from "../../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
import LeaveVersion from "../../schemas/WorkforcePolicy/LeavePolicyVersion.schema";
import RemoteVersion from "../../schemas/WorkforcePolicy/RemoteWorkPolicyVersion.schema";
import TimesheetVersion from "../../schemas/WorkforcePolicy/TimesheetPolicyVersion.schema";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { escapeRegex, getPolicyActor, normalizeRole, normalizeText, validateObjectId, WORKFORCE_ROLE_PATTERN } from "./workforcePolicy.utils";

const exact = (value: string) => new RegExp(`^${escapeRegex(value)}$`, "i");
const names = (value: unknown) => (Array.isArray(value) ? value : []).map(normalizeText).filter(Boolean);
const ids = (value: unknown[]) => value.filter((item: any) => mongoose.Types.ObjectId.isValid(String(item))).map((item: any) => new mongoose.Types.ObjectId(String(item)));

export function companyPolicyReader(req: any) {
  const actor = getPolicyActor(req);
  // Configuration delegation is company-wide; employee coverage keeps its separate organizational scope.
  return ["superadmin", "admin", "hradmin"].includes(normalizeRole(actor.role)) || hasPermission(actor, PERMISSION_KEYS.MANAGE_WORKFORCE_POLICIES);
}

export function workforceEmployeeReadScope(actor: any): any {
  const role = normalizeRole(actor.role);
  if (["superadmin", "admin", "hradmin"].includes(role)) return {};
  if (role === "departmenthead") {
    const department = normalizeText(actor.department);
    if (!department) throw generateError("Department scope is missing", 403);
    return { department: { $regex: exact(department) } };
  }
  if (role === "hr") {
    const scope = actor.hrScope || {}, departments = names(scope.departments), teams = names(scope.teams);
    if (!departments.length) throw generateError("HR department scope is missing", 403);
    const match: any = { $and: [{ $or: departments.map((department) => ({ department: { $regex: exact(department) } })) }] };
    if (teams.length) match.$and.push({ $or: teams.map((team) => ({ team: { $regex: exact(team) } })) });
    const source = scope.officeLocations || scope.officeLocationIds || scope.locations || scope.locationIds || [];
    const locations = ids(Array.isArray(source) ? source : [source]);
    if ((Array.isArray(source) ? source.length : Boolean(source)) && !locations.length) throw generateError("HR location scope is invalid", 403);
    if (locations.length) match.officeLocation = { $in: locations };
    return match;
  }
  throw generateError("You cannot view company policy coverage", 403);
}

type ReadScope = { restricted: boolean; assignments: any; resources: Map<string, Promise<any[]>> };
const cache = new WeakMap<object, Map<string, Promise<ReadScope>>>();

async function readScope(req: any, company: mongoose.Types.ObjectId): Promise<ReadScope> {
  let entries = cache.get(req);
  if (!entries) { entries = new Map(); cache.set(req, entries); }
  const key = String(company);
  if (!entries.has(key)) entries.set(key, (async () => {
    if (companyPolicyReader(req)) return { restricted: false, assignments: { company }, resources: new Map() };
    const actor = getPolicyActor(req), employeeScope = workforceEmployeeReadScope(actor);
    const departments = normalizeRole(actor.role) === "departmenthead" ? [normalizeText(actor.department)] : names(actor.hrScope?.departments);
    const teams = normalizeRole(actor.role) === "hr" ? names(actor.hrScope?.teams).map((name) => name.toLowerCase()) : [];
    const employeeMatch = { company, deletedAt: null, role: { $regex: WORKFORCE_ROLE_PATTERN }, ...employeeScope };
    // Only scope IDs are fetched server-side; no complete employee profiles/roster are returned.
    const [people, locations, departmentRows] = await Promise.all([
      User.distinct("_id", employeeMatch), User.distinct("officeLocation", employeeMatch),
      Department.find({ company, deletedAt: null, departmentName: { $in: departments.map(exact) } }).select("_id teams._id teams.name").lean(),
    ]);
    const teamIds = departmentRows.flatMap((department: any) => (department.teams || []).filter((team: any) => !teams.length || teams.includes(normalizeText(team.name).toLowerCase())).map((team: any) => team._id));
    // A scoped reader also needs inherited defaults and shared-location policies that apply to their employees.
    return { restricted: true, resources: new Map(), assignments: { company, $or: [
      { scopeType: "company", scopeId: null },
      { scopeType: "department", scopeId: { $in: departmentRows.map((department: any) => department._id) } },
      { scopeType: "team", scopeId: { $in: teamIds } },
      { scopeType: "location", scopeId: { $in: ids(locations) } },
      { scopeType: "employee", scopeId: { $in: people } },
    ] } };
  })());
  return entries.get(key)!;
}

async function resourceIds(req: any, company: mongoose.Types.ObjectId, type: string) {
  const scope = await readScope(req, company);
  if (!scope.resources.has(type)) scope.resources.set(type, Assignment.distinct("resource", { ...scope.assignments, resourceType: type }).exec());
  return scope.resources.get(type)!;
}

export async function scopePolicyResourceQuery(req: any, company: mongoose.Types.ObjectId, type: string, match: any) {
  if (companyPolicyReader(req)) return;
  const allowed = await resourceIds(req, company, type);
  match.$and = [...(match.$and || []), { _id: { $in: allowed } }];
}

export async function assertPolicyResourceReadable(req: any, company: mongoose.Types.ObjectId, type: string, id: unknown) {
  const resourceId = validateObjectId(id, "policy resource id");
  if (companyPolicyReader(req)) return;
  const allowed = await resourceIds(req, company, type);
  if (!allowed.some((item) => String(item) === resourceId)) throw generateError("Policy configuration not found", 404);
}

export function policyVersionReadFilter(req: any) { return companyPolicyReader(req) ? {} : { status: "published" }; }

export async function policyAssignmentReadFilter(req: any, company: mongoose.Types.ObjectId) {
  const scope = await readScope(req, company);
  return scope.restricted ? { $and: [scope.assignments] } : {};
}

const versionModels: Record<string, { model: any; parent: string }> = {
  attendance_policy: { model: AttendanceVersion, parent: "policy" }, work_schedule: { model: ScheduleVersion, parent: "schedule" },
  holiday_calendar: { model: CalendarVersion, parent: "calendar" }, leave_policy: { model: LeaveVersion, parent: "policy" },
  remote_work_policy: { model: RemoteVersion, parent: "policy" }, timesheet_policy: { model: TimesheetVersion, parent: "policy" },
};
async function readablePolicyVersions(req: any, company: mongoose.Types.ObjectId, type: string) {
  const definition = versionModels[type], allowed = await resourceIds(req, company, type);
  return definition.model.find({ company, [definition.parent]: { $in: allowed }, status: "published" }).select("rules").lean();
}

export async function scopePolicyWorkflowQuery(req: any, company: mongoose.Types.ObjectId, match: any) {
  if (companyPolicyReader(req)) return;
  const versions = (await Promise.all(Object.keys(versionModels).map((type) => readablePolicyVersions(req, company, type)))).flat();
  const found = new Set<string>();
  const collect = (value: any) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["approvalWorkflow", "approvalWorkflowId", "requestApprovalWorkflow", "encashmentApprovalWorkflow", "compOffClaimApprovalWorkflow"].includes(key) && mongoose.Types.ObjectId.isValid(String(child))) found.add(String(child));
      else if (child && typeof child === "object") collect(child);
    }
  };
  versions.forEach((version: any) => collect(version.rules));
  match.$and = [...(match.$and || []), { _id: { $in: ids([...found]) } }];
}

export async function scopePolicyLeaveTypeQuery(req: any, company: mongoose.Types.ObjectId, match: any) {
  if (companyPolicyReader(req)) return;
  const versions = await readablePolicyVersions(req, company, "leave_policy");
  const allowed = versions.flatMap((version: any) => (version.rules || []).map((rule: any) => rule.leaveType));
  match.$and = [...(match.$and || []), { _id: { $in: ids(allowed) } }];
}

export async function scopePolicyAuditQuery(req: any, company: mongoose.Types.ObjectId, match: any) {
  if (companyPolicyReader(req)) return;
  const scope = await readScope(req, company);
  const assignments = await Assignment.distinct("_id", scope.assignments);
  // Company configuration/draft audit is admin-only; scoped viewers see relevant assignment lifecycle events.
  match.$and = [...(match.$and || []), { entityType: "assignment", entityId: { $in: assignments } }];
}
