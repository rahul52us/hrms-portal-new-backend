import assert from "node:assert/strict";
import mongoose from "mongoose";
import AttendanceImportBatch from "../../schemas/Attendance/AttendanceImportBatch.schema";
import { getDefaultPermissionsForRole, PERMISSION_KEYS } from "../permissions/permission.utils";
import { operationInput, refreshedPolicySnapshot } from "./attendanceOperations.service";

const statusOperation = operationInput({
  operation: "set_status",
  status: "present",
  reason: "Verified by HR",
});
assert.equal(statusOperation.operation, "set_status");
assert.equal(statusOperation.status, "present");

const overnightAdjustment = operationInput({
  reason: "Verified overnight shift",
  punchInTime: "19:00",
  punchOutTime: "02:00",
  punchOutNextDay: true,
}, "adjust");
assert.equal(overnightAdjustment.punchOutNextDay, true);

const refreshOperation = operationInput({
  operation: "refresh_policies_recalculate",
  reason: "Apply the newly effective overtime policy",
});
assert.equal(refreshOperation.operation, "refresh_policies_recalculate");

const refreshedSnapshot = refreshedPolicySnapshot({
  timezone: "Asia/Kolkata",
  dayType: "working_day",
  requiresAttendance: true,
  expectedWorkMinutes: 480,
  schedule: { startTime: "09:30", endTime: "18:30" },
  organizationAssignment: {},
  policyReferences: {
    attendancePolicy: {
      assignmentId: new mongoose.Types.ObjectId(),
      resourceId: new mongoose.Types.ObjectId(),
      versionId: new mongoose.Types.ObjectId(),
    },
    workSchedule: {
      assignmentId: new mongoose.Types.ObjectId(),
      resourceId: new mongoose.Types.ObjectId(),
      versionId: new mongoose.Types.ObjectId(),
    },
    holidayCalendar: {
      assignmentId: new mongoose.Types.ObjectId(),
      resourceId: new mongoose.Types.ObjectId(),
      versionId: new mongoose.Types.ObjectId(),
    },
  },
});
assert.equal(refreshedSnapshot.timezone, "Asia/Kolkata");
assert.equal(refreshedSnapshot.scheduleStartTimeSnapshot, "09:30");
assert.ok(refreshedSnapshot.attendancePolicyVersion);
assert.throws(
  () => refreshedPolicySnapshot({ policyReferences: {} }),
  /missing Attendance Policy, Work Schedule, Holiday Calendar/i
);

assert.throws(
  () => operationInput({ operation: "set_status", status: "leave", reason: "Manual leave" }),
  /valid manual attendance status/i
);
assert.throws(
  () => operationInput({ operation: "adjust", reason: "No changes" }),
  /change punches, status, or work mode/i
);
assert.throws(
  () => operationInput({ operation: "finalize", reason: "x" }),
  /at least 3 characters/i
);

const importBatch = new AttendanceImportBatch({
  company: new mongoose.Types.ObjectId(),
  idempotencyKey: "attendance-import-001",
  fileName: "attendance.xlsx",
  fileHash: "abc123",
  createdBy: new mongoose.Types.ObjectId(),
});
assert.equal(importBatch.validateSync(), undefined);
assert.equal(importBatch.status, "processing");

const invalidBatch = new AttendanceImportBatch({
  company: new mongoose.Types.ObjectId(),
  idempotencyKey: "attendance-import-002",
  fileName: "attendance.xlsx",
  fileHash: "abc123",
  status: "unknown",
  createdBy: new mongoose.Types.ObjectId(),
});
assert.ok(invalidBatch.validateSync()?.errors.status);

const uniqueIndex = AttendanceImportBatch.schema.indexes().find(
  ([fields]) => fields.company === 1 && fields.idempotencyKey === 1
);
assert.equal(uniqueIndex?.[1]?.unique, true);

const adminPermissions = getDefaultPermissionsForRole("admin");
assert.equal(adminPermissions[PERMISSION_KEYS.ADJUST_ATTENDANCE], true);
assert.equal(adminPermissions[PERMISSION_KEYS.FINALIZE_ATTENDANCE], true);
assert.equal(adminPermissions[PERMISSION_KEYS.REOPEN_ATTENDANCE], true);
assert.equal(adminPermissions[PERMISSION_KEYS.IMPORT_ATTENDANCE], true);
const hrPermissions = getDefaultPermissionsForRole("hr");
assert.equal(hrPermissions[PERMISSION_KEYS.ADJUST_ATTENDANCE], true);
assert.equal(hrPermissions[PERMISSION_KEYS.IMPORT_ATTENDANCE], false);
assert.equal(
  getDefaultPermissionsForRole("departmenthead")[PERMISSION_KEYS.ADJUST_ATTENDANCE],
  false
);

console.log("attendance operations tests passed");
