import assert from "node:assert/strict";
import { calculateAttendance } from "./attendanceCalculator.utils";

const base = {
  attendanceDate: "2026-08-24",
  timezone: "Asia/Kolkata",
  attendanceRules: {
    gracePeriodMinutesLate: 10,
    gracePeriodMinutesEarly: 5,
    minimumFullDayMinutes: 480,
    minimumHalfDayMinutes: 240,
    requirePunchOut: true,
    allowMultiplePunches: true,
    missingPunchTreatment: "flag_incomplete" as const,
    overtimeEnabled: true,
    overtimeStartsAfterMinutes: 480,
  },
  schedule: { startTime: "09:30", endTime: "18:30" },
  requiresAttendance: true,
  expectedWorkMinutes: 480,
  defaultAttendanceStatus: "pending" as const,
};

const local = (time: string) => new Date(`2026-08-24T${time}:00+05:30`);

function testCompleteDay() {
  const result = calculateAttendance({
    ...base,
    punchSessions: [{ punchIn: local("09:35"), punchOut: local("18:35") }],
  });
  assert.equal(result.status, "present");
  assert.equal(result.workedMinutes, 540);
  assert.equal(result.lateMinutes, 0);
  assert.equal(result.earlyExitMinutes, 0);
  assert.equal(result.overtimeMinutes, 60);
  assert.equal(result.state, "calculated");
}

function testMultipleSessionsAndBreak() {
  const result = calculateAttendance({
    ...base,
    punchSessions: [
      { punchIn: local("09:45"), punchOut: local("13:00") },
      { punchIn: local("14:00"), punchOut: local("18:00") },
    ],
  });
  assert.equal(result.workedMinutes, 435);
  assert.equal(result.breakMinutes, 60);
  assert.equal(result.status, "half_day");
  assert.equal(result.lateMinutes, 5);
  assert.equal(result.earlyExitMinutes, 25);
}

function testOpenSession() {
  const result = calculateAttendance({
    ...base,
    punchSessions: [{ punchIn: local("09:30"), punchOut: null }],
  });
  assert.equal(result.status, "pending");
  assert.equal(result.state, "open");
  assert.equal(result.hasOpenSession, true);
  assert.equal(result.hasMissingPunch, true);
}

function testMissingPunchTreatments() {
  const halfDay = calculateAttendance({
    ...base,
    attendanceRules: { ...base.attendanceRules, missingPunchTreatment: "half_day" },
    punchSessions: [{ punchIn: local("09:30"), punchOut: null }],
  });
  assert.equal(halfDay.status, "pending", "An active punch remains pending during the day");

  const invalidPair = calculateAttendance({
    ...base,
    attendanceRules: { ...base.attendanceRules, missingPunchTreatment: "absent" },
    punchSessions: [{ punchIn: null, punchOut: local("18:30") }],
  });
  assert.equal(invalidPair.status, "absent");
  assert.equal(invalidPair.hasMissingPunch, true);
}

function testHolidayWork() {
  const result = calculateAttendance({
    ...base,
    requiresAttendance: false,
    expectedWorkMinutes: 0,
    defaultAttendanceStatus: "holiday",
    punchSessions: [{ punchIn: local("10:00"), punchOut: local("12:00") }],
  });
  assert.equal(result.status, "present");
  assert.equal(result.workedMinutes, 120);
}

function testNoPunchUsesDayClassification() {
  const result = calculateAttendance({
    ...base,
    requiresAttendance: false,
    expectedWorkMinutes: 0,
    defaultAttendanceStatus: "weekly_off",
    punchSessions: [],
  });
  assert.equal(result.status, "weekly_off");
  assert.equal(result.state, "calculated");
}

[
  testCompleteDay,
  testMultipleSessionsAndBreak,
  testOpenSession,
  testMissingPunchTreatments,
  testHolidayWork,
  testNoPunchUsesDayClassification,
].forEach((test) => test());

console.log("Attendance calculator tests passed (6 tests)");

