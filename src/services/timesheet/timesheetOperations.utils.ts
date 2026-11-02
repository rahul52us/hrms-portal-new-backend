import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import { dateKey } from "../project/project.utils";
import { addDateDays } from "./timesheet.utils";
export const OPERATIONS_STATUSES = ["all", "missing", "required", "draft", "submitted", "approved", "returned", "rejected", "not_required", "setup_incomplete", "short_hours", "overdue", "stale", "upcoming", "exempt"] as const;
export const tsId = (value: any) => String(value?._id || value || "");
export function operationsFilters(query: any) {
  const filters: any = {};
  for (const key of ["employeeId", "managerId", "departmentId", "teamId", "officeLocationId", "projectId", "workTypeId"]) {
    if (query[key]) { if (!mongoose.Types.ObjectId.isValid(String(query[key]))) throw generateError(`Invalid ${key}`, 400); filters[key] = String(query[key]); }
  }
  filters.search = String(query.search || "").trim();
  if (filters.search.length > 100) throw generateError("Search is limited to 100 characters", 400);
  filters.status = String(query.status || "all");
  if (!(OPERATIONS_STATUSES as readonly string[]).includes(filters.status)) throw generateError("Invalid timesheet status", 400);
  return filters;
}
export function operationsDates(query: any, view: string) {
  if (view === "register") return [dateKey(query.date, "Work date")!];
  if (view === "monthly") {
    if (!/^\d{4}-\d{2}$/.test(String(query.month))) throw generateError("Month must use YYYY-MM", 400);
    const from = dateKey(`${query.month}-01`, "Month")!;
    const last = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 0)).getUTCDate();
    return Array.from({ length: last }, (_, i) => addDateDays(from, i));
  }
  const from = dateKey(query.from, "From date")!, to = dateKey(query.to, "To date")!;
  if (from > to || to >= addDateDays(from, 31)) throw generateError("Choose 1 to 31 inclusive dates", 400);
  const count = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  return Array.from({ length: count }, (_, i) => addDateDays(from, i));
}
export function organizationFilters(organization: any, filters: any) {
  return [["departmentId", "department"], ["teamId", "teamId"], ["officeLocationId", "officeLocation"], ["managerId", "reportingManager"]].every(([key, field]) => !filters[key] || filters[key] === tsId(organization[field]));
}
export function operationRowMatches(row: any, filters: any) {
  const status = filters.status;
  if (status === "exempt") return row.hrExemption;
  if (status === "short_hours") return row.shortHours;
  if (status === "overdue") return row.overdue;
  if (status === "stale") return row.stale;
  return status === "all" || row.state === status;
}
export function operationsSummary() {
  return { rows: 0, requiredMinutes: 0, loggedMinutes: 0, approvedMinutes: 0, shortfallMinutes: 0, exemptMinutes: 0, exempt: 0, required: 0, missing: 0, draft: 0, submitted: 0, approved: 0, returned: 0, rejected: 0, not_required: 0, setup_incomplete: 0, upcoming: 0, short_hours: 0, overdue: 0, stale: 0 };
}
export function addOperationsRow(summary: any, row: any) {
  summary.rows++; for (const key of ["requiredMinutes", "loggedMinutes", "approvedMinutes", "shortfallMinutes", "exemptMinutes"]) summary[key] += row[key] || 0;
  if (row.hrExemption) summary.exempt++;
  if (row.state in summary) summary[row.state]++;
  if (row.shortHours) summary.short_hours++;
  if (row.overdue) summary.overdue++;
  if (row.stale) summary.stale++;
}
export function hoursText(value: number | null) { return value == null ? "" : `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`; }
export function safeSpreadsheetText(value: any) {
  const text = String(value ?? ""); return /^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
}
