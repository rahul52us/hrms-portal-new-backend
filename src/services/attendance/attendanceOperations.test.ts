import assert from "node:assert/strict";
import mongoose from "mongoose";
import AttendanceImportBatch from "../../schemas/Attendance/AttendanceImportBatch.schema";
import { getDefaultPermissionsForRole, PERMISSION_KEYS } from "../permissions/permission.utils";
import { operationInput } from "./attendanceOperations.service";

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
