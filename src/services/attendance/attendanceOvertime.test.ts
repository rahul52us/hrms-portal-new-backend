import assert from "node:assert/strict";
import mongoose from "mongoose";
import AttendanceOvertimeReview from "../../schemas/Attendance/AttendanceOvertimeReview.schema";
import { getDefaultPermissionsForRole, PERMISSION_KEYS } from "../permissions/permission.utils";
import {
  approvedMinutesAvailable,
  overtimeMinutesForApproval,
} from "./attendanceOvertime.utils";

assert.equal(
  overtimeMinutesForApproval({ dayTypeSnapshot: "working_day", workedMinutes: 570, overtimeMinutes: 90 }),
  90
);
assert.equal(
  overtimeMinutesForApproval({ dayTypeSnapshot: "weekly_off", workedMinutes: 480, overtimeMinutes: 0 }),
  480
);
assert.equal(
  overtimeMinutesForApproval({ dayTypeSnapshot: "mandatory_holiday", workedMinutes: 240, overtimeMinutes: 0 }),
  240
);

assert.equal(
  approvedMinutesAvailable({
    overtimeApprovalRequiredSnapshot: true,
    overtimeApprovalStatus: "pending",
    approvedOvertimeMinutes: 0,
    workedMinutes: 480,
  }),
  0
);
assert.equal(
  approvedMinutesAvailable({
    overtimeApprovalRequiredSnapshot: true,
    overtimeApprovalStatus: "approved",
    approvedOvertimeMinutes: 480,
    workedMinutes: 480,
  }),
  480
);
assert.equal(
  approvedMinutesAvailable({
    overtimeApprovalRequiredSnapshot: false,
    overtimeApprovalStatus: "not_required",
    approvedOvertimeMinutes: 0,
    workedMinutes: 480,
  }),
  480
);

const review = new AttendanceOvertimeReview({
  company: new mongoose.Types.ObjectId(),
  employee: new mongoose.Types.ObjectId(),
  attendanceRecord: new mongoose.Types.ObjectId(),
  attendanceDate: "2026-09-25",
  attendanceRevisionNumber: 2,
  overtimeMinutesSnapshot: 90,
  workedMinutesSnapshot: 570,
  dayTypeSnapshot: "working_day",
  attendancePolicy: new mongoose.Types.ObjectId(),
  attendancePolicyVersion: new mongoose.Types.ObjectId(),
  attendancePolicyVersionNumber: 3,
});
assert.equal(review.validateSync(), undefined);
assert.equal(review.status, "pending");

assert.equal(
  getDefaultPermissionsForRole("hr")[PERMISSION_KEYS.APPROVE_ATTENDANCE_OVERTIME],
  true
);
assert.equal(
  getDefaultPermissionsForRole("employee")[PERMISSION_KEYS.APPROVE_ATTENDANCE_OVERTIME],
  false
);

console.log("Attendance overtime tests passed");
