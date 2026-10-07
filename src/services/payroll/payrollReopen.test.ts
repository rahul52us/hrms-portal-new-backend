import assert from "node:assert/strict";
import mongoose from "mongoose";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import { getDefaultPermissionsForRole, PERMISSION_KEYS } from "../permissions/permission.utils";
import { buildPayrollRunDocument } from "./payrollRun.service";
import { buildPayrollReopenUpdate, payrollReopenBlocker } from "./payrollReopen.service";

const objectId = () => new mongoose.Types.ObjectId();

function testReopenGuards() {
  assert.equal(payrollReopenBlocker({ status: "finalized", finalizationVersion: 1 }), null);
  assert.equal(payrollReopenBlocker({ status: "finalized", finalizationVersion: 1, payoutStatus: "not_started" }), null);
  assert.match(payrollReopenBlocker({ status: "draft", finalizationVersion: 1 }) || "", /finalized/);
  assert.match(payrollReopenBlocker({ status: "finalized", finalizationVersion: 0 }) || "", /metadata/);
  assert.match(payrollReopenBlocker({ status: "finalized", finalizationVersion: 1, payoutStatus: "processing" }) || "", /payout/);
  assert.match(payrollReopenBlocker({ status: "finalized", finalizationVersion: 1, payoutStatus: "paid" }) || "", /payout/);
}

function testReopenUpdatePreservesFinalization() {
  const update = buildPayrollReopenUpdate({
    actorId: objectId(),
    reason: "Correct one-time deduction",
    reopenedAt: new Date("2026-10-03T00:00:00.000Z"),
    finalizationVersion: 2,
  });
  assert.equal(update.$set.status, "draft");
  assert.equal(update.$set.reopenedFromFinalizationVersion, 2);
  assert.equal(update.$set.reviewCalculationVersion, 0);
  assert.equal(update.$inc.version, 1);
  assert.equal("finalizationVersion" in update.$set, false);
  assert.equal("finalizedAt" in update.$unset, false);
  assert.equal("finalizedBy" in update.$unset, false);
}

function testSchemaDefaultsAndPayoutValidation() {
  const actorId = objectId();
  const companyId = objectId();
  const data = buildPayrollRunDocument({
    company: {
      _id: companyId,
      company_name: "Acme Private Limited",
      companyCode: "ACME",
      payrollSettings: { currency: "INR", currencyMinorUnits: 2, payDay: 31, roundingMode: "nearest" },
    },
    input: {
      _id: objectId(),
      attendancePeriod: objectId(),
      periodKey: "2026-09",
      cycleStartDate: "2026-08-26",
      cycleEndDate: "2026-09-25",
      attendanceCutoffDay: 25,
      version: 1,
      attendancePeriodVersion: 1,
      summaryCount: 1,
      adjustmentCount: 0,
      totals: {},
      lockedAt: new Date(),
      lockedBy: actorId,
    },
    actorId,
    reason: "Prepare payroll",
  });
  assert.equal(data.payoutStatus, "not_started");
  assert.equal(data.reopenedFromFinalizationVersion, 0);
  assert.equal(new PayrollRun(data).validateSync(), undefined);
  const invalid = new PayrollRun({ ...data, attendancePayrollInput: objectId(), payoutStatus: "unknown" });
  assert.ok(invalid.validateSync()?.errors.payoutStatus);
}

function testPermissions() {
  assert.equal(getDefaultPermissionsForRole("admin")[PERMISSION_KEYS.REOPEN_PAYROLL_RUNS], true);
  assert.equal(getDefaultPermissionsForRole("hradmin")[PERMISSION_KEYS.REOPEN_PAYROLL_RUNS], true);
  assert.equal(getDefaultPermissionsForRole("hr")[PERMISSION_KEYS.REOPEN_PAYROLL_RUNS], false);
}

testReopenGuards();
testReopenUpdatePreservesFinalization();
testSchemaDefaultsAndPayoutValidation();
testPermissions();

console.log("Payroll reopen guards, immutable history, schema, and permission tests passed");
