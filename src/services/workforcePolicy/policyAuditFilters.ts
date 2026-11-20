import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import User from "../../schemas/User/User";
import { localAttendanceTimeToUtc } from "../attendance/attendanceRegularization.service";
import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";
import { escapeRegex } from "./workforcePolicy.utils";

function optionalText(value: unknown, label: string, maximum: number) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > maximum) throw generateError(`${label} must be text up to ${maximum} characters`, 400);
  return value.trim();
}

function validateDate(value: string, label: string) {
  if (!value) return;
  try { parseAttendanceDate(value); }
  catch { throw generateError(`${label} must be a valid date in YYYY-MM-DD format`, 400); }
}

export async function applyPolicyAuditFilters(query: any, company: mongoose.Types.ObjectId, match: any) {
  const search = optionalText(query.search, "Search", 100);
  const fromDate = optionalText(query.fromDate, "From date", 10);
  const toDate = optionalText(query.toDate, "To date", 10);
  const timezone = optionalText(query.timezone, "Timezone", 80) || "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
  catch { throw generateError("Choose a valid IANA timezone", 400); }
  validateDate(fromDate, "From date");
  validateDate(toDate, "To date");
  if (fromDate && toDate && fromDate > toDate) throw generateError("From date must be on or before To date", 400);
  if (fromDate || toDate) {
    // An exclusive next-midnight bound includes the entire last local day, including DST changes.
    match.createdAt = {
      ...(fromDate ? { $gte: localAttendanceTimeToUtc(fromDate, "00:00", timezone) } : {}),
      ...(toDate ? { $lt: localAttendanceTimeToUtc(toDate, "00:00", timezone, true) } : {}),
    };
  }
  if (!search) return;
  const expression = new RegExp(escapeRegex(search), "i");
  const actors = await User.distinct("_id", { company, $or: [{ name: expression }, { username: expression }, { code: expression }] });
  // Intersect search with the existing authorization filter; never replace its $and/$or scope.
  match.$and = [...(match.$and || []), { $or: [
    { actor: { $in: actors } },
    ...["changeReason", "reason", "endReason", "archiveReason", "cancellationReason", "after.changeReason", "after.cancellationReason"].map((field) => ({ [`details.${field}`]: expression })),
  ] }];
}
