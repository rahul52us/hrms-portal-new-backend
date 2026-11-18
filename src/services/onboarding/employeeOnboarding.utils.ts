import { generateError } from "../../config/Error/functions";
import mongoose from "mongoose";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { localAttendanceTimeToUtc } from "../attendance/attendanceRegularization.service";
import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";

export const valueId = (value: any) => String(value?._id || value || "");
export const terminalTask = (task: any) => ["completed", "waived"].includes(task.status);
const values = (value: any) => (Array.isArray(value) ? value : []).map(valueId);
const matches = (items: string[], value: any) => items.some((item) => item.toLowerCase() === valueId(value).toLowerCase());
const exact = (value: string) => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
export function onboardingEmployeeScope(actor: any, permission: string = PERMISSION_KEYS.VIEW_ONBOARDING) {
  if (!hasPermission(actor, permission)) return { _id: { $in: [] } };
  if (["admin", "hradmin"].includes(actor.role)) return {};
  if (actor.role === "hr") {
    const departments = values(actor.hrScope?.departments);
    if (!departments.length) return { _id: { $in: [] } };
    return { department: { $in: departments.map(exact) },
      ...(values(actor.hrScope?.teams).length ? { team: { $in: values(actor.hrScope.teams).map(exact) } } : {}),
      ...(values(actor.hrScope?.officeLocations).length ? { officeLocation: { $in: values(actor.hrScope.officeLocations).filter((value) => /^[a-f\d]{24}$/i.test(value)).map((value) => new mongoose.Types.ObjectId(value)) } } : {}) };
  }
  if (actor.role === "departmenthead") return actor.department ? { department: exact(actor.department) } : { _id: { $in: [] } };
  return { reportingManager: actor._id };
}
export function inOnboardingScope(actor: any, employee: any, permission: string = PERMISSION_KEYS.VIEW_ONBOARDING) {
  if (!hasPermission(actor, permission)) return false;
  if (["admin", "hradmin"].includes(actor.role)) return true;
  if (actor.role === "hr") return matches(values(actor.hrScope?.departments), employee.department) &&
    (!values(actor.hrScope?.teams).length || matches(values(actor.hrScope.teams), employee.team)) &&
    (!values(actor.hrScope?.officeLocations).length || values(actor.hrScope.officeLocations).includes(valueId(employee.officeLocation)));
  if (actor.role === "departmenthead") return Boolean(actor.department) && matches([actor.department], employee.department);
  return valueId(employee.reportingManager) === valueId(actor._id);
}
export const managesOnboardingEmployee = (actor: any, employee: any) => hasPermission(actor, PERMISSION_KEYS.VIEW_ONBOARDING) && inOnboardingScope(actor, employee, PERMISSION_KEYS.MANAGE_ONBOARDING);
export const ownsOnboardingTask = (actor: any, employee: any, task: any) => task.assignees.some((person: any) => valueId(person.user) === valueId(actor)) && (task.owner !== "hr" || task.ownerResolution === "manual" || managesOnboardingEmployee(actor, employee));
export const visibleOnboardingTask = (actor: any, employee: any, task: any) => inOnboardingScope(actor, employee) || ownsOnboardingTask(actor, employee, task) || task.kind === "asset_provisioning" && valueId(actor) === valueId(employee);
export function validateOnboardingTimezone(value: unknown) {
  if (typeof value !== "string" || value.length > 80) throw generateError("Choose a valid timezone", 422);
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); } catch { throw generateError("Choose a valid timezone", 422); }
  return value;
}
export function joiningDateKey(value: any) {
  if (!value) throw generateError("Set the employee's joining date before assigning onboarding", 422);
  const key = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  parseAttendanceDate(key);
  return key;
}
export function onboardingDueDate(joiningDate: string, days: number, timezone: string) {
  const { date } = parseAttendanceDate(joiningDate); date.setUTCDate(date.getUTCDate() + days);
  const dueDate = date.toISOString().slice(0, 10);
  return { dueDate, dueAt: new Date(localAttendanceTimeToUtc(dueDate, "23:59", timezone).getTime() + 59999) };
}
export function onboardingProgress(tasks: any[], now = new Date()) {
  const required = tasks.filter((task) => task.required);
  return { total: tasks.length, done: tasks.filter(terminalTask).length, required: required.length, requiredDone: required.filter(terminalTask).length,
    blocked: tasks.filter((task) => task.status === "blocked").length,
    overdue: tasks.filter((task) => !terminalTask(task) && new Date(task.dueAt) < now).length };
}
export function onboardingStatus(tasks: any[]) {
  const required = tasks.filter((task) => task.required);
  return (required.length ? required : tasks).every(terminalTask) ? "completed" : "active";
}
