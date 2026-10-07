import assert from "node:assert/strict";
import mongoose from "mongoose";
import AttendanceTrustedDevice from "./AttendanceTrustedDevice.schema";

const device = new AttendanceTrustedDevice({
  company: new mongoose.Types.ObjectId(),
  employee: new mongoose.Types.ObjectId(),
  deviceHash: "a".repeat(64),
  deviceIdSuffix: "1234abcd",
  deviceName: "Windows browser",
  platform: "Windows",
  userAgent: "Test browser",
  status: "pending",
});
assert.equal(device.validateSync(), undefined);

device.status = "trusted";
device.decisions.push({
  status: "trusted",
  actor: new mongoose.Types.ObjectId(),
  reason: "Verified work browser",
  decidedAt: new Date(),
});
assert.equal(device.validateSync(), undefined);

device.status = "unknown" as any;
assert.ok(device.validateSync()?.errors.status);

console.log("Attendance trusted device schema tests passed");
