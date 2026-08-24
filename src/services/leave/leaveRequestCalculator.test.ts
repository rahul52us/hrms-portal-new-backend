import assert from "node:assert/strict";
import { calculateLeaveRequest, resolveLeaveYear } from "./leaveRequestCalculator.utils";

const leaveTypeId = "507f1f77bcf86cd799439011";

function context(date: string, dayType = "working_day", overrides: any = {}) {
  return {
    attendanceDate: date,
    dayType,
    expectedWorkMinutes: dayType === "mandatory_half_day_holiday" ? 240 : 480,
    holiday: dayType.includes("holiday")
      ? { name: "Holiday", type: "mandatory", isHalfDay: dayType.includes("half_day") }
      : null,
    organizationAssignment: {},
    policyReferences: {
      leavePolicy: { assignmentId: "507f1f77bcf86cd799439012", resourceId: "507f1f77bcf86cd799439013", versionId: "507f1f77bcf86cd799439014", versionNumber: 1 },
      workSchedule: {},
      holidayCalendar: {},
    },
    policies: {
      leavePolicy: {
        version: {
          leaveYearStartMonth: 4,
          leaveYearStartDay: 1,
          rules: [{
            leaveType: leaveTypeId,
            allowHalfDay: true,
            minimumRequestDays: 0.5,
            maximumRequestDays: null,
            minimumNoticeDays: 0,
            probationEligibility: "allowed",
            sandwichRuleEnabled: false,
            balanceTracked: true,
            negativeBalanceAllowed: false,
            maxNegativeBalance: 0,
            ...overrides.rule,
          }],
        },
      },
    },
    ...overrides.context,
  };
}

function run() {
  assert.deepEqual(resolveLeaveYear("2026-03-31", 4, 1), {
    leaveYearKey: "2025-04-01:2026-03-31",
    leaveYearStart: "2025-04-01",
    leaveYearEnd: "2026-03-31",
  });
  assert.deepEqual(resolveLeaveYear("2026-04-01", 4, 1), {
    leaveYearKey: "2026-04-01:2027-03-31",
    leaveYearStart: "2026-04-01",
    leaveYearEnd: "2027-03-31",
  });

  const ordinary = calculateLeaveRequest({
    leaveTypeId,
    leaveUnit: "days",
    fromDate: "2026-08-24",
    toDate: "2026-08-26",
    contexts: [
      context("2026-08-24"),
      context("2026-08-25", "mandatory_holiday"),
      context("2026-08-26"),
    ],
    currentDate: "2026-08-21",
  });
  assert.equal(ordinary.requestedUnits, 3);
  assert.equal(ordinary.chargedUnits, 2);

  const sandwich = calculateLeaveRequest({
    leaveTypeId,
    leaveUnit: "days",
    fromDate: "2026-08-21",
    toDate: "2026-08-24",
    contexts: [
      context("2026-08-21", "working_day", { rule: { sandwichRuleEnabled: true } }),
      context("2026-08-22", "weekly_off", { rule: { sandwichRuleEnabled: true } }),
      context("2026-08-23", "weekly_off", { rule: { sandwichRuleEnabled: true } }),
      context("2026-08-24", "working_day", { rule: { sandwichRuleEnabled: true } }),
    ],
    currentDate: "2026-08-21",
  });
  assert.equal(sandwich.chargedUnits, 4);
  assert.equal(sandwich.dayBreakdown[1].chargeReason, "sandwich_rule");

  const halfHoliday = calculateLeaveRequest({
    leaveTypeId,
    leaveUnit: "days",
    fromDate: "2026-08-25",
    toDate: "2026-08-25",
    contexts: [context("2026-08-25", "mandatory_half_day_holiday")],
    currentDate: "2026-08-21",
  });
  assert.equal(halfHoliday.chargedUnits, 0.5);

  const hourly = calculateLeaveRequest({
    leaveTypeId,
    leaveUnit: "hours",
    fromDate: "2026-08-24",
    toDate: "2026-08-24",
    requestedHours: 2.5,
    contexts: [context("2026-08-24")],
    currentDate: "2026-08-21",
  });
  assert.equal(hourly.chargedUnits, 2.5);

  assert.throws(
    () => calculateLeaveRequest({
      leaveTypeId,
      leaveUnit: "days",
      fromDate: "2026-08-24",
      toDate: "2026-08-24",
      contexts: [context("2026-08-24", "working_day", { rule: { probationEligibility: "after_confirmation" } })],
      currentDate: "2026-08-21",
    }),
    /confirmation date/i
  );
}

run();
console.log("leaveRequestCalculator tests passed");
