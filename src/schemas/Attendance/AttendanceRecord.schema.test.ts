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

testOptionalEnumDefaults();
testValidEnumValues();
testInvalidEnumValues();

console.log("AttendanceRecord schema tests passed");
