import { attendanceCycleRange } from "../attendance/attendancePeriod.service";
import { addDateDays, dateInZone, localInstant } from "./timesheet.utils";
import { effectiveEditEnd } from "./timesheetDayControl.utils";

export type TimesheetCycle = { periodKey: string; startDate: string; endDate: string; attendanceCutoffDay: number };
export const usesPayrollCutoff = (rules: any) => rules?.deadlineMode === "payroll_cycle" || rules?.payrollCutoffEnabled === true;
export function shiftMonth(month: string, offset: number) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1 + offset, 1)).toISOString().slice(0, 7);
}

// Persisted cycles retain their dates even after a company changes its cutoff.
export function timesheetCyclesForDates(from: string, to: string, cutoff: number, periods: TimesheetCycle[]) {
  const ranges: TimesheetCycle[] = [];
  for (let key = from.slice(0, 7); key <= shiftMonth(to.slice(0, 7), 1); key = shiftMonth(key, 1)) {
    const stored = periods.find((p) => p.periodKey === key);
    ranges.push(stored ? { periodKey: stored.periodKey, startDate: stored.startDate, endDate: stored.endDate, attendanceCutoffDay: stored.attendanceCutoffDay } : attendanceCycleRange(key, cutoff, periods.find((p) => p.periodKey === shiftMonth(key, -1))?.endDate));
  }
  const dates = new Map<string, TimesheetCycle | null>();
  for (let date = from; date <= to; date = addDateDays(date, 1)) {
    const matches = ranges.filter((range) => range.startDate <= date && range.endDate >= date);
    dates.set(date, matches.length === 1 ? matches[0] : null);
  }
  return dates;
}

export function timesheetDeadlines(date: string, schedule: any, rules: any, timezone: string, cycle?: TimesheetCycle | null) {
  const cycleMode = rules.deadlineMode === "payroll_cycle";
  const shiftEndDate = addDateDays(date, schedule.endTime <= schedule.startTime ? 1 : 0);
  const shiftEnd = localInstant(shiftEndDate, schedule.endTime, timezone);
  const dailyDue = cycleMode ? null : localInstant(addDateDays(shiftEndDate, rules.deadlineDaysAfterShift), rules.deadlineTime, timezone);
  const baseEditDate = addDateDays(shiftEndDate, rules.maxBackdateDays);
  const enabled = usesPayrollCutoff(rules);
  const submissionAt = enabled && cycle ? localInstant(addDateDays(cycle.endDate, rules.payrollSubmissionDaysAfterCycleEnd ?? 1), rules.payrollSubmissionTime ?? "10:00", timezone) : null;
  const approvalAt = enabled && cycle ? localInstant(addDateDays(cycle.endDate, rules.payrollApprovalDaysAfterCycleEnd ?? 1), rules.payrollApprovalTime ?? "14:00", timezone) : null;
  let deadline = cycleMode ? submissionAt : dailyDue;
  if (submissionAt && deadline && deadline > submissionAt) deadline = submissionAt;
  let editEnd = cycleMode && submissionAt ? submissionAt : effectiveEditEnd(baseEditDate, timezone, null)!;
  if (submissionAt && editEnd > submissionAt) editEnd = submissionAt;
  return { deadline, editEnd, editable: dateInZone(editEnd, timezone),
    invalid: Boolean(deadline && deadline < shiftEnd || submissionAt && submissionAt < shiftEnd),
    missingCycle: enabled && !cycle,
    payrollCycle: enabled && cycle ? { ...cycle, submissionAt, approvalAt } : null };
}
