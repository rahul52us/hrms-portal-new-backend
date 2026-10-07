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

function testPunchLocationEvidence() {
  assert.equal(
    record({
      punchSessions: [{
        punchIn: new Date(),
        source: "web",
        punchInLocation: {
          latitude: 28.6139,
          longitude: 77.209,
          accuracyMeters: 15,
          verificationStatus: "within_geofence",
          distanceMeters: 12,
          radiusMeters: 200,
          officeLocation: new mongoose.Types.ObjectId(),
          officeLocationNameSnapshot: "Delhi Head Office",
          officeLatitudeSnapshot: 28.6139,
          officeLongitudeSnapshot: 77.209,
        },
        punchInAccess: {
          clientIp: "10.20.4.5",
          networkStatus: "allowed",
          matchedNetworkSnapshot: "10.20.0.0/16",
          deviceStatus: "trusted",
          trustedDevice: new mongoose.Types.ObjectId(),
          deviceIdSuffix: "1234abcd",
          deviceNameSnapshot: "Windows browser",
        },
      }],
    }).validateSync(),
    undefined
  );
  assert.ok(record({
    punchSessions: [{
      punchIn: new Date(),
      source: "web",
      punchInLocation: { verificationStatus: "outside" },
    }],
  }).validateSync()?.errors["punchSessions.0.punchInLocation.verificationStatus"]);
}

testOptionalEnumDefaults();
testValidEnumValues();
testInvalidEnumValues();
testOvertimeApprovalValues();
testPunchLocationEvidence();

console.log("AttendanceRecord schema tests passed");
