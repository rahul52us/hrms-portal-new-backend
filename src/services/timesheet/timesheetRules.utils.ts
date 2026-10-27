import { generateError } from "../../config/Error/functions";
import { TimesheetRules } from "../../schemas/WorkforcePolicy/TimesheetPolicyVersion.schema";

export const DEFAULT_TIMESHEET_RULES: TimesheetRules = {
  required: true, deadlineDaysAfterShift: 1, deadlineTime: "23:59", maxBackdateDays: 31,
  minimumEntryMinutes: 15, minuteIncrement: 15, maximumDailyEntries: 50,
  notesRequired: true, minimumNotesLength: 5, allowExtraHours: false,
  maximumExtraMinutes: 0, payrollMode: "report_only",
};

export function timesheetPagination(query: any, maxLimit = 100) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) throw generateError(`Use a valid page and a limit between 1 and ${maxLimit}`, 400);
  return { page, limit, skip: (page - 1) * limit };
}

export function normalizeTimesheetRules(input: any = {}, current: any = DEFAULT_TIMESHEET_RULES): TimesheetRules {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw generateError("Rules must be an object", 400);
  const base = { ...DEFAULT_TIMESHEET_RULES, ...(current?.toObject ? current.toObject() : current) };
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULT_TIMESHEET_RULES)) throw generateError(`Unknown timesheet rule: ${key}`, 400);
  }
  const value = { ...base, ...input };
  for (const key of ["required", "notesRequired", "allowExtraHours"] as const) {
    if (typeof value[key] !== "boolean") throw generateError(`${key} must be true or false`, 422);
  }
  const ranges: Record<string, [number, number]> = {
    deadlineDaysAfterShift: [0, 31], maxBackdateDays: [0, 366], minimumEntryMinutes: [1, 480],
    minuteIncrement: [1, 60], maximumDailyEntries: [1, 100], minimumNotesLength: [0, 500], maximumExtraMinutes: [0, 720],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) {
      throw generateError(`${key} must be a whole number between ${min} and ${max}`, 422);
    }
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.deadlineTime)) throw generateError("Deadline time must use HH:mm", 422);
  if (!["report_only", "block", "shortfall"].includes(value.payrollMode)) throw generateError("Invalid timesheet payroll mode", 422);
  if (value.minimumEntryMinutes % value.minuteIncrement) throw generateError("Minimum entry duration must be a multiple of the minute increment", 422);
  if (value.maxBackdateDays < value.deadlineDaysAfterShift) throw generateError("The edit window must include the submission deadline", 422);
  if (value.notesRequired && value.minimumNotesLength < 1) throw generateError("Set a minimum notes length when notes are required", 422);
  if (!value.notesRequired && value.minimumNotesLength !== 0) throw generateError("Minimum notes length must be 0 when notes are optional", 422);
  if (!value.allowExtraHours && value.maximumExtraMinutes !== 0) throw generateError("Extra minutes must be 0 when extra-hours logging is disabled", 422);
  if (value.allowExtraHours && value.maximumExtraMinutes === 0) throw generateError("Set an extra-minutes limit when extra-hours logging is enabled", 422);
  return value;
}
