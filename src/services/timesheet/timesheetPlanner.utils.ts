import { addDateDays } from "./timesheet.utils";

export function plannerPeriods(today: string) {
  const date = new Date(`${today}T00:00:00Z`);
  const weekStart = addDateDays(today, -((date.getUTCDay() + 6) % 7));
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { today: { from: today, to: today }, week: { from: weekStart, to: addDateDays(weekStart, 6) }, month: { from: monthStart, to: monthEnd } };
}

export function plannerState(day: any, sheet: any, today: string) {
  if (["submitted", "approved", "returned", "rejected"].includes(sheet?.status)) return sheet.status;
  if (day.eligibility.saveIssues.some((issue: any) => issue.code === "OUTSIDE_EMPLOYMENT")) return "not_required";
  if (day.eligibility.setupIssues.length) return "setup_incomplete";
  if (day.context.attendanceDate > today) return "upcoming";
  if (!day.requirement.requiredMinutes && !sheet?.loggedMinutes) return "not_required";
  if (sheet) return "draft";
  return day.eligibility.overdue ? "missing" : "required";
}

export function plannerDaySummary(day: any, sheet: any, today: string) {
  const requiredMinutes = day.requirement.requiredMinutes;
  const loggedMinutes = sheet?.loggedMinutes || 0;
  const shortfallMinutes = requiredMinutes == null ? null : Math.max(0, requiredMinutes - loggedMinutes);
  return { attendanceDate: day.context.attendanceDate, state: plannerState(day, sheet, today), status: sheet?.status || "missing",
    revision: sheet?.revision || 0, loggedMinutes, requiredMinutes, shortfallMinutes,
    shortHours: Boolean(sheet && loggedMinutes > 0 && shortfallMinutes), required: day.eligibility.required,
    setupIssues: day.eligibility.setupIssues, saveIssues: day.eligibility.saveIssues, overdue: day.eligibility.overdue,
    dayType: day.context.dayType, timezone: day.context.timezone, deadlineAt: day.eligibility.deadlineAt,
    exemptMinutes: day.eligibility.exemptMinutes || 0, hrExemption: Boolean(day.controls?.exemption), deadlineExtended: Boolean(day.controls?.extension),
    canSave: day.eligibility.canSave && (!sheet || ["draft", "returned", "rejected"].includes(sheet.status)) && !sheet?.payrollLockedAt };
}
