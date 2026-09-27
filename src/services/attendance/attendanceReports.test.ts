import assert from "node:assert/strict";
import mongoose from "mongoose";
import AttendancePayrollInput from "../../schemas/Attendance/AttendancePayrollInput.schema";
import {
  attendanceDayPayrollUnits,
  buildAttendanceEmployeeSummary,
  nextAttendancePeriodKey,
  payrollSummaryDelta,
} from "./attendanceSummary.service";

assert.deepEqual(attendanceDayPayrollUnits({ status: "present" }, false), { paidUnits: 1, unpaidUnits: 0 });
assert.deepEqual(attendanceDayPayrollUnits({ status: "pending", state: "open" }, false), { paidUnits: 0, unpaidUnits: 0 });
assert.deepEqual(attendanceDayPayrollUnits({ status: "incomplete", state: "calculated" }, false), { paidUnits: 0, unpaidUnits: 0 });
assert.deepEqual(attendanceDayPayrollUnits({ status: "incomplete", state: "finalized" }, false), { paidUnits: 0, unpaidUnits: 1 });
assert.deepEqual(
  attendanceDayPayrollUnits({ status: "half_day", leaveUnits: 0.5 }, true),
  { paidUnits: 1, unpaidUnits: 0 }
);
assert.deepEqual(
  attendanceDayPayrollUnits({ status: "half_day", leaveUnits: 0.5 }, false),
  { paidUnits: 0.5, unpaidUnits: 0.5 }
);
assert.deepEqual(
  attendanceDayPayrollUnits({ status: "leave", leaveUnits: 1 }, false),
  { paidUnits: 0, unpaidUnits: 1 }
);
assert.deepEqual(
  attendanceDayPayrollUnits({ status: "half_day", leaveUnit: "hours", leaveUnits: 4, expectedWorkMinutesSnapshot: 480 }, true),
  { paidUnits: 1, unpaidUnits: 0 }
);
assert.deepEqual(
  attendanceDayPayrollUnits({ status: "weekly_off", requiresAttendanceSnapshot: false }, false),
  { paidUnits: 1, unpaidUnits: 0 }
);

const employeeId = new mongoose.Types.ObjectId();
const leaveRequestId = new mongoose.Types.ObjectId();
const records = [
  {
    _id: new mongoose.Types.ObjectId(),
    employee: employeeId,
    attendanceDate: "2026-08-01",
    revisionNumber: 1,
    status: "present",
    state: "finalized",
    dayTypeSnapshot: "working_day",
    requiresAttendanceSnapshot: true,
    workMode: "remote",
    workedMinutes: 510,
    lateMinutes: 10,
    earlyExitMinutes: 0,
    overtimeMinutes: 30,
    approvedOvertimeMinutes: 30,
    hasMissingPunch: false,
  },
  {
    _id: new mongoose.Types.ObjectId(),
    employee: employeeId,
    attendanceDate: "2026-08-02",
    revisionNumber: 2,
    status: "half_day",
    state: "finalized",
    dayTypeSnapshot: "working_day",
    requiresAttendanceSnapshot: true,
    workMode: "office",
    workedMinutes: 240,
    lateMinutes: 0,
    earlyExitMinutes: 15,
    overtimeMinutes: 0,
    approvedOvertimeMinutes: 0,
    hasMissingPunch: false,
    leaveRequest: leaveRequestId,
    leaveUnits: 0.5,
  },
  {
    _id: new mongoose.Types.ObjectId(),
    employee: employeeId,
    attendanceDate: "2026-08-03",
    revisionNumber: 1,
    status: "absent",
    state: "finalized",
    dayTypeSnapshot: "working_day",
    requiresAttendanceSnapshot: true,
    workMode: "office",
    workedMinutes: 0,
    lateMinutes: 0,
    earlyExitMinutes: 0,
    overtimeMinutes: 0,
    approvedOvertimeMinutes: 0,
    hasMissingPunch: false,
  },
];

const summary = buildAttendanceEmployeeSummary({
  records,
  employee: { _id: employeeId, name: "Test Employee", code: "TEST-1" },
  paidLeaveRequestIds: new Set([String(leaveRequestId)]),
  regularizedRecordKeys: new Set([`${employeeId}:2026-08-02`]),
});
assert.equal(summary.paidDays, 2);
assert.equal(summary.unpaidDays, 1);
assert.equal(summary.wfhDays, 1);
assert.equal(summary.approvedOvertimeMinutes, 30);
assert.equal(summary.regularizationDays, 1);
assert.equal(summary.exceptionCount, 5);

const delta = payrollSummaryDelta(
  { paidDays: 20, unpaidDays: 2, approvedOvertimeMinutes: 60 },
  { paidDays: 21, unpaidDays: 1, approvedOvertimeMinutes: 90 }
);
assert.equal(delta.changed, true);
assert.equal(delta.deltas.paidDays, 1);
assert.equal(delta.deltas.unpaidDays, -1);
assert.equal(delta.deltas.approvedOvertimeMinutes, 30);
assert.equal(nextAttendancePeriodKey("2026-12"), "2027-01");

const payrollInput = new AttendancePayrollInput({
  company: new mongoose.Types.ObjectId(),
  attendancePeriod: new mongoose.Types.ObjectId(),
  periodKey: "2026-09",
  cycleStartDate: "2026-08-26",
  cycleEndDate: "2026-09-25",
  attendanceCutoffDay: 25,
  version: 1,
  attendancePeriodVersion: 1,
  summaryCount: 10,
  adjustmentCount: 0,
  totals: {},
  reason: "Attendance cycle handed off",
  status: "locked",
  lockedAt: new Date(),
  lockedBy: new mongoose.Types.ObjectId(),
});
assert.equal(payrollInput.validateSync(), undefined);

console.log("Attendance reports and payroll summary tests passed");
