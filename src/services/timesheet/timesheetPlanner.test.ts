import assert from "node:assert/strict";
import { plannerDaySummary, plannerPeriods, plannerState } from "./timesheetPlanner.utils";

const day = (overrides: any = {}) => ({
  context: { attendanceDate: "2026-10-25", dayType: "working_day", timezone: "Asia/Kolkata" },
  requirement: { requiredMinutes: 480 },
  eligibility: { setupIssues: [], saveIssues: [], required: true, overdue: false, canSave: true },
  ...overrides,
});
assert.deepEqual(plannerPeriods("2027-01-01"), {
  today: { from: "2027-01-01", to: "2027-01-01" }, week: { from: "2026-12-28", to: "2027-01-03" }, month: { from: "2027-01-01", to: "2027-01-31" },
});
assert.equal(plannerPeriods("2028-02-29").month.to, "2028-02-29");
assert.equal(plannerPeriods("2026-10-26").week.from, "2026-10-26");
assert.equal(plannerState(day(), null, "2026-10-26"), "required");
assert.equal(plannerState(day({ eligibility: { ...day().eligibility, overdue: true } }), null, "2026-10-26"), "missing");
assert.equal(plannerState(day(), { status: "draft", loggedMinutes: 240 }, "2026-10-26"), "draft");
assert.equal(plannerState(day(), null, "2026-10-24"), "upcoming");
assert.equal(plannerState(day({ requirement: { requiredMinutes: 0 } }), null, "2026-10-26"), "not_required");
for (const status of ["submitted", "approved", "returned", "rejected"]) assert.equal(plannerState(day(), { status }, "2026-10-26"), status);
assert.equal(plannerState(day({ eligibility: { ...day().eligibility, setupIssues: [{ code: "MISSING_WORK_SCHEDULE" }] } }), null, "2026-10-26"), "setup_incomplete");
assert.equal(plannerState(day({ eligibility: { ...day().eligibility, saveIssues: [{ code: "OUTSIDE_EMPLOYMENT" }] } }), null, "2026-10-26"), "not_required");
const summary = plannerDaySummary(day(), { status: "draft", loggedMinutes: 240, revision: 3, entries: ["private"] }, "2026-10-26");
assert.equal(summary.shortfallMinutes, 240); assert.equal(summary.shortHours, true); assert.equal(summary.revision, 3);
assert.equal("entries" in summary, false);
assert.equal(plannerDaySummary(day(), { status: "draft", loggedMinutes: 480 }, "2026-10-26").shortHours, false);
assert.equal(plannerDaySummary(day({ requirement: { requiredMinutes: null } }), null, "2026-10-26").shortfallMinutes, null);
assert.equal(plannerDaySummary(day(), { status: "draft", payrollLockedAt: new Date() }, "2026-10-26").canSave, false);
assert.equal(plannerDaySummary(day(), { status: "approved" }, "2026-10-26").canSave, false);
console.log("Timesheet Planner calculations passed: period boundaries, states, shortfall, compact payload and read-only guards");
