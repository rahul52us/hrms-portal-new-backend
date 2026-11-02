import { generateError } from "../../config/Error/functions";
import mongoose from "mongoose";
import { TimesheetRules } from "../../schemas/WorkforcePolicy/TimesheetPolicyVersion.schema";

export const DEFAULT_TIMESHEET_RULES: TimesheetRules = {
  remindersEnabled: true, remindBeforeHours: 24, reminderEveryDays: 1, approverEscalationDays: 2,
  required: true, deadlineDaysAfterShift: 1, deadlineTime: "23:59", maxBackdateDays: 31,
  deadlineMode: "after_shift", payrollCutoffEnabled: false,
  payrollSubmissionDaysAfterCycleEnd: 1, payrollSubmissionTime: "10:00",
  payrollApprovalDaysAfterCycleEnd: 1, payrollApprovalTime: "14:00",
  minimumEntryMinutes: 1, maximumDailyEntries: 50,
  notesRequired: true, minimumNotesLength: 5, allowExtraHours: false,
  maximumExtraMinutes: 0, payrollMode: "report_only", approvalWorkflowId: null,
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
  // Accept old clients/drafts without carrying their retired rounding rule forward.
  delete base.minuteIncrement;
  for (const key of Object.keys(input)) {
    if (key !== "minuteIncrement" && !(key in DEFAULT_TIMESHEET_RULES)) throw generateError(`Unknown timesheet rule: ${key}`, 400);
  }
  const value = { ...base, ...input };
  delete value.minuteIncrement;
  if (value.approvalWorkflowId === "") value.approvalWorkflowId = null;
  if (value.approvalWorkflowId !== null && (typeof value.approvalWorkflowId !== "string" || !mongoose.Types.ObjectId.isValid(value.approvalWorkflowId))) throw generateError("Select a valid timesheet approval workflow", 422);
  for (const key of ["required", "notesRequired", "allowExtraHours", "payrollCutoffEnabled", "remindersEnabled"] as const) {
    if (typeof value[key] !== "boolean") throw generateError(`${key} must be true or false`, 422);
  }
  const ranges: Record<string, [number, number]> = {
    remindBeforeHours: [0, 168], reminderEveryDays: [1, 7], approverEscalationDays: [1, 31],
    deadlineDaysAfterShift: [0, 31], maxBackdateDays: [0, 366], minimumEntryMinutes: [1, 480],
    payrollSubmissionDaysAfterCycleEnd: [0, 31], payrollApprovalDaysAfterCycleEnd: [0, 31],
    maximumDailyEntries: [1, 100], minimumNotesLength: [0, 500], maximumExtraMinutes: [0, 720],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) {
      throw generateError(`${key} must be a whole number between ${min} and ${max}`, 422);
    }
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.deadlineTime)) throw generateError("Deadline time must use HH:mm", 422);
  if (!["after_shift", "payroll_cycle"].includes(value.deadlineMode)) throw generateError("Choose after-shift or payroll-cycle deadlines", 422);
  for (const key of ["payrollSubmissionTime", "payrollApprovalTime"]) {
    if (typeof value[key] !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value[key])) throw generateError(`${key} must use HH:mm`, 422);
  }
  if (value.deadlineMode === "payroll_cycle") value.payrollCutoffEnabled = true;
  if (value.payrollCutoffEnabled && (value.payrollApprovalDaysAfterCycleEnd < value.payrollSubmissionDaysAfterCycleEnd ||
    value.payrollApprovalDaysAfterCycleEnd === value.payrollSubmissionDaysAfterCycleEnd && value.payrollApprovalTime < value.payrollSubmissionTime)) {
    throw generateError("Approval deadline cannot be before the employee submission cutoff", 422);
  }
  if (!["report_only", "block", "shortfall"].includes(value.payrollMode)) throw generateError("Invalid timesheet payroll mode", 422);
  if (value.deadlineMode === "after_shift" && value.maxBackdateDays < value.deadlineDaysAfterShift) throw generateError("The edit window must include the submission deadline", 422);
  if (value.notesRequired && value.minimumNotesLength < 1) throw generateError("Set a minimum notes length when notes are required", 422);
  if (!value.notesRequired && value.minimumNotesLength !== 0) throw generateError("Minimum notes length must be 0 when notes are optional", 422);
  if (!value.allowExtraHours && value.maximumExtraMinutes !== 0) throw generateError("Extra minutes must be 0 when extra-hours logging is disabled", 422);
  if (value.allowExtraHours && value.maximumExtraMinutes === 0) throw generateError("Set an extra-minutes limit when extra-hours logging is enabled", 422);
  return value;
}
