import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";

export const projectId = (value: any) => String(value?._id || value || "").trim();
export const projectToday = () => new Date().toISOString().slice(0, 10);
export function objectId(value: unknown, label: string) {
  const id = projectId(value);
  if (!/^[a-f\d]{24}$/i.test(id)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(id);
}
export function dateKey(value: unknown, label: string, optional = false): string | null {
  if (optional && (value === "" || value === null || value === undefined)) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw generateError(`${label} must be a valid YYYY-MM-DD date`, 422);
  }
  return value;
}
export function shortText(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
    throw generateError(`${label} must be ${min}-${max} characters`, 422);
  }
  return value.trim();
}
export function projectCode(value: unknown, name: string) {
  if (value === undefined || value === "") {
    const stem = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);
    return `${/^[A-Z]/.test(stem) ? stem : "PROJECT"}_${new mongoose.Types.ObjectId().toString().slice(-6).toUpperCase()}`;
  }
  const code = shortText(value, "Code", 2, 30).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,29}$/.test(code)) throw generateError("Code must start with a letter and contain only letters, numbers, or underscores", 422);
  return code;
}
export function dateRange(from: string, to: string | null) {
  if (to && to < from) throw generateError("End date cannot be before start date", 422);
}
export function assignmentDateMatch(date: string) {
  return { status: "assigned", effectiveFrom: { $lte: date }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: date } }] };
}
export function overlapMatch(from: string, to: string | null) {
  return { status: "assigned", ...(to ? { effectiveFrom: { $lte: to } } : {}), $or: [{ effectiveTo: null }, { effectiveTo: { $gte: from } }] };
}
export function companyProjectViewer(actor: any) {
  return ["admin", "hradmin"].includes(actor.role);
}
export function companyProjectManager(actor: any) {
  return companyProjectViewer(actor) && hasPermission(actor, PERMISSION_KEYS.MANAGE_PROJECTS);
}
export function projectManagementDisabled(actor: any) {
  return !hasPermission(actor, PERMISSION_KEYS.VIEW_PROJECTS) || actor.permissions?.[PERMISSION_KEYS.MANAGE_PROJECTS] === false;
}
export function canManageProject(actor: any, project: any) {
  return !projectManagementDisabled(actor) && (companyProjectManager(actor) ||
    (project.managers || []).some((id: any) => projectId(id) === projectId(actor)));
}
export function employeeProjectScope(actor: any) {
  if (companyProjectManager(actor)) return {};
  const or: any[] = [{ _id: actor._id }, { reportingManager: actor._id }];
  const exact = (value: any) => new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  if (hasPermission(actor, PERMISSION_KEYS.MANAGE_PROJECTS)) {
    if (actor.role === "departmenthead" && actor.department) or.push({ department: exact(actor.department) });
    if (actor.role === "hr" && actor.hrScope?.departments?.length) {
      const scope: any = { department: { $in: actor.hrScope.departments.map(exact) } };
      if (actor.hrScope.teams?.length) scope.team = { $in: actor.hrScope.teams.map(exact) };
      if (actor.hrScope.officeLocations?.length) scope.officeLocation = { $in: actor.hrScope.officeLocations.map((id: any) => objectId(id, "scope location")) };
      or.push(scope);
    }
  }
  return { $or: or };
}
export function pagination(query: any) {
  const number = (value: any, fallback: number, max: number) => {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(result) || result < 1 || result > max) throw generateError("Invalid project pagination", 400);
    return result;
  };
  const page = number(query.page, 1, 10000), limit = number(query.limit, 20, 50);
  return { page, limit, skip: (page - 1) * limit };
}
