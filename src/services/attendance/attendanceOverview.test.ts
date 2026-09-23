import assert from "node:assert/strict";
import {
  addAttendanceSummaryRow,
  attendanceRowMatches,
  createAttendanceSummary,
  deriveAttendanceStatus,
  deriveAttendanceWorkMode,
  finalPunchOut,
  firstPunchIn,
} from "./attendanceOverview.utils";

assert.equal(deriveAttendanceStatus({ classification: { defaultAttendanceStatus: "pending" } }), "not_marked");
assert.equal(deriveAttendanceStatus({ classification: { defaultAttendanceStatus: "holiday" } }), "holiday");
assert.equal(deriveAttendanceStatus({ classification: { defaultAttendanceStatus: "weekly_off" } }), "weekly_off");
assert.equal(deriveAttendanceStatus({ leaveDay: { chargedUnits: 1 } }), "leave");
assert.equal(deriveAttendanceStatus({ leaveDay: { chargedUnits: 0.5 } }), "half_day");
assert.equal(deriveAttendanceStatus({ record: { status: "present" }, leaveDay: { chargedUnits: 1 } }), "present");

assert.equal(deriveAttendanceWorkMode({ remoteWorkDay: { portion: "full" } }), "remote");
assert.equal(deriveAttendanceWorkMode({ remoteWorkDay: { portion: "first_half" } }), "hybrid");
assert.equal(deriveAttendanceWorkMode({ record: { workMode: "field" }, remoteWorkDay: { portion: "full" } }), "field");

const punches = {
  punchSessions: [
    { punchIn: "2026-09-18T04:00:00.000Z", punchOut: "2026-09-18T09:00:00.000Z" },
    { punchIn: "2026-09-18T03:30:00.000Z", punchOut: "2026-09-18T12:30:00.000Z" },
  ],
};
assert.equal(firstPunchIn(punches), "2026-09-18T03:30:00.000Z");
assert.equal(finalPunchOut(punches), "2026-09-18T12:30:00.000Z");

const summary = createAttendanceSummary();
addAttendanceSummaryRow(summary, {
  status: "not_marked",
  workMode: "remote",
  requiresAttendance: true,
  firstIn: null,
  isLate: false,
  dayType: "working_day",
});
assert.equal(summary.expected, 1);
assert.equal(summary.exceptions, 0);
assert.equal(summary.notMarked, 1);
assert.equal(summary.wfh, 1);
assert.equal(summary.absent, 0);

assert.equal(attendanceRowMatches({ status: "present", workMode: "office" }, "present", "all"), true);
assert.equal(attendanceRowMatches({ status: "present", workMode: "office" }, "absent", "all"), false);
assert.equal(attendanceRowMatches({ status: "present", workMode: "office" }, "all", "remote"), false);
assert.equal(attendanceRowMatches({ status: "present", workMode: "office", hasMissingPunch: true }, "all", "all", "missing_punch"), true);
assert.equal(attendanceRowMatches({ status: "present", workMode: "office", isLate: false }, "all", "all", "late_arrival"), false);
assert.equal(attendanceRowMatches({ status: "absent", workMode: "office" }, "all", "all", "absence"), true);
assert.equal(attendanceRowMatches({ status: "present", workMode: "office", overtimeMinutes: 45 }, "all", "all", "overtime"), true);
assert.equal(attendanceRowMatches({ status: "not_marked", workMode: "office", dayType: "unconfigured", schedule: { configured: false } }, "all", "all", "setup_gap"), true);
assert.equal(attendanceRowMatches({ status: "not_marked", workMode: "office", dayType: "working_day", schedule: { configured: true }, setupGaps: ["attendance_policy"] }, "all", "all", "setup_gap"), true);

console.log("attendance overview tests passed");
