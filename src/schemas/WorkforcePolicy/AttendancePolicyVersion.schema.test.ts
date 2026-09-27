import assert from "node:assert/strict";
import mongoose from "mongoose";
import AttendancePolicyVersion from "./AttendancePolicyVersion.schema";

function version(autoFinalize?: Record<string, unknown>) {
  return new AttendancePolicyVersion({
    company: new mongoose.Types.ObjectId(),
    policy: new mongoose.Types.ObjectId(),
    versionNumber: 1,
    status: "draft",
    createdBy: new mongoose.Types.ObjectId(),
    rules: autoFinalize ? { autoFinalize } : {},
  });
}

function testDefaults() {
  const policyVersion = version();
  assert.equal(policyVersion.validateSync(), undefined);
  assert.equal(policyVersion.rules.autoFinalize.enabled, false);
  assert.equal(policyVersion.rules.autoFinalize.graceMinutes, 1440);
  assert.equal(policyVersion.rules.autoFinalize.mode, "clean_only");
  assert.equal(policyVersion.rules.overtimeApproval.required, false);
}

function testValidAutoFinalization() {
  assert.equal(version({
    enabled: true,
    graceMinutes: 2880,
    mode: "all_calculated",
  }).validateSync(), undefined);
}

function testInvalidAutoFinalization() {
  const excessiveGrace = version({
    enabled: true,
    graceMinutes: 2881,
    mode: "clean_only",
  }).validateSync();
  assert.ok(excessiveGrace?.errors["rules.autoFinalize.graceMinutes"]);

  const invalidMode = version({
    enabled: true,
    graceMinutes: 60,
    mode: "immediate_lock",
  }).validateSync();
  assert.ok(invalidMode?.errors["rules.autoFinalize.mode"]);
}

function testOvertimeApprovalSnapshot() {
  const policyVersion = new AttendancePolicyVersion({
    company: new mongoose.Types.ObjectId(),
    policy: new mongoose.Types.ObjectId(),
    versionNumber: 2,
    status: "draft",
    createdBy: new mongoose.Types.ObjectId(),
    rules: {
      overtimeEnabled: true,
      overtimeApproval: {
        required: true,
        approvalWorkflow: new mongoose.Types.ObjectId(),
        approvalWorkflowVersion: new mongoose.Types.ObjectId(),
        approvalWorkflowVersionNumber: 1,
      },
    },
  });
  assert.equal(policyVersion.validateSync(), undefined);
  assert.equal(policyVersion.rules.overtimeApproval.required, true);
}

testDefaults();
testValidAutoFinalization();
testInvalidAutoFinalization();
testOvertimeApprovalSnapshot();

console.log("AttendancePolicyVersion schema tests passed");
