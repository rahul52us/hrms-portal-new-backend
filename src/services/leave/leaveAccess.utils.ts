import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import { hasPermission } from "../permissions/permission.utils";

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

export function normalizeLeaveRole(value: unknown) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/^department[-\s]?head$/, "departmenthead")
    .replace(/^head[-\s]?hr$/, "hradmin")
    .replace(/^hr[-\s]?admin$/, "hradmin")
    .replace(/^hr[-\s]?executive$/, "hr");
}

export function getLeaveActor(req: any) {
  const source = req?.user || req?.bodyData || {};
  const actorId = normalizeText(req?.userId || source?._id);
  if (!mongoose.Types.ObjectId.isValid(actorId)) {
    throw generateError("Authenticated user is invalid", 401);
  }
  return {
    ...source,
    _id: new mongoose.Types.ObjectId(actorId),
    role: normalizeLeaveRole(source?.role),
    company: normalizeText(source?.company || source?.companyId),
  };
}

export function resolveLeaveCompanyId(actor: any, requestedCompanyId?: unknown) {
  const requested = normalizeText(requestedCompanyId);
  if (actor.role === "superadmin") {
    if (!mongoose.Types.ObjectId.isValid(requested)) {
      throw generateError("A valid companyId is required for superadmin leave operations", 400);
    }
    return new mongoose.Types.ObjectId(requested);
  }
  if (!mongoose.Types.ObjectId.isValid(actor.company)) {
    throw generateError("Your account is not assigned to a company", 403);
  }
  if (requested && requested !== actor.company) {
    throw generateError("You can only access leave data from your company", 403);
  }
  return new mongoose.Types.ObjectId(actor.company);
}

function values(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((item) => normalizeText((item as any)?._id || item))
    .filter(Boolean);
}

function equals(left: unknown, right: unknown) {
  return normalizeText(left).toLowerCase() === normalizeText(right).toLowerCase();
}

export function isEmployeeInActorScope(actor: any, employee: any, permissionKey: string) {
  if (String(actor._id) === String(employee?._id)) return true;
  if (String(employee?.reportingManager?._id || employee?.reportingManager || "") === String(actor._id)) {
    return true;
  }
  if (!hasPermission(actor, permissionKey)) return false;
  if (["superadmin", "admin", "hradmin"].includes(actor.role)) return true;
  if (actor.role === "departmenthead") {
    return Boolean(actor.department) && equals(actor.department, employee?.department);
  }
  if (actor.role === "hr") {
    const departments = values(actor?.hrScope?.departments);
    const teams = values(actor?.hrScope?.teams);
    const locations = values(actor?.hrScope?.officeLocations);
    if (!departments.length || !departments.some((value) => equals(value, employee?.department))) return false;
    if (teams.length && !teams.some((value) => equals(value, employee?.team))) return false;
    const employeeLocation = normalizeText(employee?.officeLocation?._id || employee?.officeLocation);
    if (locations.length && !locations.includes(employeeLocation)) return false;
    return true;
  }
  return false;
}

export function ensureEmployeeInActorScope(
  actor: any,
  employee: any,
  permissionKey: string,
  message: string
) {
  if (!isEmployeeInActorScope(actor, employee, permissionKey)) {
    throw generateError(message, 403);
  }
}

function exactRegex(value: string) {
  return new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}

export function buildLeaveRequestScope(actor: any, permissionKey: string, includeSelf = true) {
  const or: any[] = [];
  if (includeSelf) or.push({ employee: actor._id });
  or.push({ approver: actor._id });
  if (hasPermission(actor, permissionKey)) {
    if (["superadmin", "admin", "hradmin"].includes(actor.role)) return {};
    if (actor.role === "departmenthead" && actor.department) {
      or.push({ departmentNameSnapshot: exactRegex(normalizeText(actor.department)) });
    }
    if (actor.role === "hr") {
      const departments = values(actor?.hrScope?.departments);
      if (departments.length) {
        const scoped: any = {
          departmentNameSnapshot: { $in: departments.map(exactRegex) },
        };
        const teams = values(actor?.hrScope?.teams);
        const locations = values(actor?.hrScope?.officeLocations);
        if (teams.length) scoped.teamNameSnapshot = { $in: teams.map(exactRegex) };
        if (locations.length) {
          scoped.officeLocation = {
            $in: locations.filter(mongoose.Types.ObjectId.isValid).map((item) => new mongoose.Types.ObjectId(item)),
          };
        }
        or.push(scoped);
      }
    }
  }
  return or.length === 1 ? or[0] : { $or: or };
}
