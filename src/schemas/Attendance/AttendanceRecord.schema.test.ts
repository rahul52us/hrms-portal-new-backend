import assert from "node:assert/strict";
import mongoose from "mongoose";
import AttendanceRecord from "./AttendanceRecord.schema";

function record(overrides: Record<string, unknown> = {}) {
  return new AttendanceRecord({
    company: new mongoose.Types.ObjectId(),
    employee: new mongoose.Types.ObjectId(),
    attendanceDate: "2026-08-24",
    timezone: "Asia/Kolkata",
    state: "open",
    status: "pending",
    workMode: "office",
    workModeSource: "default",
    source: "punch",
    ...overrides,
  });
}

function testOptionalEnumDefaults() {
  const attendance = record();
  assert.equal(attendance.validateSync(), undefined);
  assert.equal(attendance.remoteWorkPortion, null);
  assert.equal(attendance.leaveUnit, null);
  assert.equal(attendance.overtimeApprovalStatus, "not_required");
  assert.equal(attendance.approvedOvertimeMinutes, 0);
}

function testValidEnumValues() {
  assert.equal(
    record({ remoteWorkPortion: "first_half", leaveUnit: "hours" }).validateSync(),
    undefined
  );
}

function testInvalidEnumValues() {
  const validation = record({
    remoteWorkPortion: "morning",
    leaveUnit: "weeks",
  }).validateSync();

  assert.ok(validation?.errors.remoteWorkPortion);
  assert.ok(validation?.errors.leaveUnit);
}

function testOvertimeApprovalValues() {
  assert.equal(
    record({
      overtimeApprovalRequiredSnapshot: true,
      overtimeApprovalStatus: "approved",
      approvedOvertimeMinutes: 90,
      overtimeReview: new mongoose.Types.ObjectId(),
    }).validateSync(),
    undefined
  );
  assert.ok(record({ overtimeApprovalStatus: "ignored" }).validateSync()?.errors.overtimeApprovalStatus);
}

testOptionalEnumDefaults();
testValidEnumValues();
testInvalidEnumValues();
testOvertimeApprovalValues();

console.log("AttendanceRecord schema tests passed");
