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
  assert.equal(policyVersion.rules.officeGeofence.enabled, false);
  assert.equal(policyVersion.rules.officeGeofence.radiusMeters, 200);
  assert.equal(policyVersion.rules.officeGeofence.validateOn, "punch_in");
  assert.equal(policyVersion.rules.officeGeofence.unavailableAction, "block");
  assert.equal(policyVersion.rules.punchNetwork.enabled, false);
  assert.deepEqual(policyVersion.rules.punchNetwork.allowedNetworks, []);
  assert.equal(policyVersion.rules.trustedDevice.enabled, false);
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

function testOfficeGeofenceValidation() {
  const policyVersion = new AttendancePolicyVersion({
    company: new mongoose.Types.ObjectId(),
    policy: new mongoose.Types.ObjectId(),
    versionNumber: 3,
    status: "draft",
    createdBy: new mongoose.Types.ObjectId(),
    rules: {
      officeGeofence: {
        enabled: true,
        radiusMeters: 250,
        validateOn: "punch_in_and_out",
        unavailableAction: "allow",
      },
    },
  });
  assert.equal(policyVersion.validateSync(), undefined);

  policyVersion.rules.officeGeofence.radiusMeters = 20;
  assert.ok(policyVersion.validateSync()?.errors["rules.officeGeofence.radiusMeters"]);
}

function testPunchAccessPolicyValues() {
  const policyVersion = new AttendancePolicyVersion({
    company: new mongoose.Types.ObjectId(),
    policy: new mongoose.Types.ObjectId(),
    versionNumber: 4,
    status: "draft",
    createdBy: new mongoose.Types.ObjectId(),
    rules: {
      punchNetwork: { enabled: true, allowedNetworks: ["10.20.0.0/16"], scope: "office_only" },
      trustedDevice: { enabled: true, scope: "all_punches" },
    },
  });
  assert.equal(policyVersion.validateSync(), undefined);
  policyVersion.rules.punchNetwork.scope = "sometimes" as any;
  assert.ok(policyVersion.validateSync()?.errors["rules.punchNetwork.scope"]);
}

testDefaults();
testValidAutoFinalization();
testInvalidAutoFinalization();
testOvertimeApprovalSnapshot();
testOfficeGeofenceValidation();
testPunchAccessPolicyValues();

console.log("AttendancePolicyVersion schema tests passed");
