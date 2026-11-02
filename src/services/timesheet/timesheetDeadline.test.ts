import assert from "node:assert/strict";
import mongoose from "mongoose";
import { buildEmployeeDayContext } from "../attendance/employeeDayContext.utils";
import { buildTimesheetDay, timesheetContextSnapshot, timesheetWorkFingerprint } from "./timesheetContext.service";
import { DEFAULT_TIMESHEET_RULES, normalizeTimesheetRules } from "./timesheetRules.utils";
import { timesheetCyclesForDates, timesheetDeadlines } from "./timesheetDeadline.utils";
import { localInstant } from "./timesheet.utils";

const zone = "Asia/Kolkata", schedule = { startTime: "09:30", endTime: "18:30" };
const rules = normalizeTimesheetRules({ deadlineMode: "payroll_cycle", maxBackdateDays: 0 });
const cycles = timesheetCyclesForDates("2026-08-26", "2026-09-26", 25, []);
const cycle = cycles.get("2026-09-25")!;
assert.deepEqual(cycle, { periodKey: "2026-09", startDate: "2026-08-26", endDate: "2026-09-25", attendanceCutoffDay: 25 });
assert.equal(cycles.get("2026-09-26")?.periodKey, "2026-10");
for (const date of ["2026-08-26", "2026-09-10", "2026-09-25"]) {
  const result = timesheetDeadlines(date, schedule, rules, zone, cycle);
  assert.equal(result.deadline?.toISOString(), "2026-09-26T04:30:00.000Z");
  assert.equal(result.editEnd.toISOString(), result.deadline?.toISOString(), "Early cycle days stay editable until the cutoff, despite a short daily window");
  assert.equal(result.payrollCycle?.approvalAt?.toISOString(), "2026-09-26T08:30:00.000Z");
}
assert.equal(rules.payrollCutoffEnabled, true);
assert.equal(normalizeTimesheetRules().payrollCutoffEnabled, false, "Legacy behavior stays opt-in");
for (const input of [{ deadlineMode: "fixed_date" }, { payrollCutoffEnabled: "true" }, { payrollSubmissionDaysAfterCycleEnd: -1 }, { payrollApprovalDaysAfterCycleEnd: 32 }, { payrollSubmissionTime: "25:00" }, { payrollApprovalTime: null }, { deadlineMode: "payroll_cycle", payrollApprovalTime: "09:00" }, { payrollCutoffEnabled: true, payrollSubmissionDaysAfterCycleEnd: 2 }]) assert.throws(() => normalizeTimesheetRules(input));

const daily = timesheetDeadlines("2026-09-01", schedule, DEFAULT_TIMESHEET_RULES, zone);
assert.equal(daily.deadline?.toISOString(), "2026-09-02T18:29:00.000Z");
assert.equal(daily.payrollCycle, null);
const hybrid = { ...rules, deadlineMode: "after_shift", maxBackdateDays: 60, deadlineDaysAfterShift: 5 };
assert.equal(timesheetDeadlines("2026-09-01", schedule, hybrid, zone, cycle).deadline?.toISOString(), "2026-09-06T18:29:00.000Z");
assert.equal(timesheetDeadlines("2026-09-25", schedule, hybrid, zone, cycle).deadline?.toISOString(), "2026-09-26T04:30:00.000Z");
assert.equal(timesheetDeadlines("2026-09-01", schedule, hybrid, zone, cycle).editEnd.toISOString(), "2026-09-26T04:30:00.000Z");
assert.equal(timesheetDeadlines("2026-09-25", { startTime: "19:00", endTime: "02:00" }, rules, zone, cycle).invalid, false);
assert.equal(timesheetDeadlines("2026-09-25", { startTime: "19:00", endTime: "02:00" }, { ...rules, payrollSubmissionDaysAfterCycleEnd: 0, payrollSubmissionTime: "23:59" }, zone, cycle).invalid, true);
assert.equal(timesheetDeadlines("2026-09-25", schedule, rules, "America/New_York", cycle).deadline?.toISOString(), "2026-09-26T14:00:00.000Z");
assert.doesNotThrow(() => timesheetDeadlines("2026-03-07", schedule, { ...rules, deadlineDaysAfterShift: 1, deadlineTime: "02:30" }, "America/New_York", { periodKey: "2026-03", startDate: "2026-02-26", endDate: "2026-03-25", attendanceCutoffDay: 25 }), "Cycle mode must not evaluate an unused daily deadline in a DST gap");

const stored = { periodKey: "2026-09", startDate: "2026-08-26", endDate: "2026-09-25", attendanceCutoffDay: 25 };
const changed = timesheetCyclesForDates("2026-09-25", "2026-10-01", 31, [stored]);
assert.equal(changed.get("2026-09-25")?.endDate, "2026-09-25", "Saved cycle dates are not rewritten by settings changes");
assert.equal(changed.get("2026-09-26")?.startDate, "2026-09-26");
assert.equal(changed.get("2026-09-26")?.endDate, "2026-10-31");
assert.equal(timesheetCyclesForDates("2024-02-29", "2024-03-01", 31, []).get("2024-02-29")?.endDate, "2024-02-29");
assert.equal(timesheetCyclesForDates("2026-12-26", "2026-12-26", 25, []).get("2026-12-26")?.periodKey, "2027-01");

function day(now: string, control?: any, suppliedCycle: any = cycle) {
  const context = buildEmployeeDayContext({ attendanceDate: "2026-09-25", policyResolution: { employee: {}, organizationAssignment: { _id: new mongoose.Types.ObjectId() }, at: new Date("2026-09-25"),
    workSchedule: { assignment: {}, version: { rules: { ...schedule, timezone: zone, workingDays: ["Friday"], saturdayRule: "all_off", unpaidBreakMinutes: 60 } } },
    holidayCalendar: { assignment: {}, version: { holidays: [] } }, timesheetPolicy: { assignment: {}, version: { rules } } } });
  return buildTimesheetDay({ employee: {}, context, record: { punchSessions: [{ punchIn: localInstant("2026-09-25", "09:30", zone), punchOut: localInstant("2026-09-25", "18:30", zone) }] }, leaves: [], assigned: true, now: new Date(now), cycle: suppliedCycle, control });
}
assert.equal(day("2026-09-26T04:30:00.000Z").eligibility.canSubmit, true);
const closed = day("2026-09-26T04:30:00.001Z");
assert.equal(closed.eligibility.canSave, false);
assert.ok(closed.eligibility.saveIssues.some((i) => i.code === "PAYROLL_CUTOFF_CLOSED"));
assert.equal(day("2026-09-26T04:30:00.001Z", { extension: { until: "2026-09-27T04:30:00.000Z" } }).eligibility.canSubmit, true);
assert.ok(day("2026-09-26T04:30:00.000Z", undefined, null).eligibility.setupIssues.some((i) => i.code === "MISSING_PAYROLL_CYCLE"));
const before = timesheetContextSnapshot(closed), after = { ...before, eligibility: { ...before.eligibility, payrollCycle: { ...cycle, approvalAt: new Date() } } };
assert.equal(timesheetWorkFingerprint(before), timesheetWorkFingerprint(after), "Clock-derived cycle dates do not rewrite submitted work evidence");
console.log("Timesheet deadlines passed: daily/cycle/combined modes, cutoff boundaries, extension, frozen/custom/leap/year cycles, overnight/timezones, validation and legacy behavior");
