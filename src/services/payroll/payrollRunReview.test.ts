import assert from "node:assert/strict";
import mongoose from "mongoose";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import { ensureIndependentPayrollReviewer, payrollReviewBlockers } from "./payrollRunReview.service";

const objectId = () => new mongoose.Types.ObjectId();

function readyRun() {
  return {
    attendanceInputStatus: "prepared",
    employeeSnapshotStatus: "prepared",
    employeeSnapshotVersion: 2,
    calculationStatus: "calculated",
    calculationVersion: 3,
    calculationEmployeeSnapshotVersion: 2,
    oneTimeInputCount: 4,
    calculationOneTimeInputCount: 4,
    payrollResultCount: 10,
  };
}

function testReviewReadiness() {
  assert.deepEqual(payrollReviewBlockers(readyRun(), {
    resultCount: 10,
    errorResultCount: 0,
    openWarningCount: 0,
  }), []);

  const blockers = payrollReviewBlockers(
    { ...readyRun(), calculationOneTimeInputCount: 3 },
    { resultCount: 10, errorResultCount: 2, openWarningCount: 1 }
  );
  assert.equal(blockers.length, 3);
  assert.ok(blockers.some((item) => item.includes("blocking errors")));
  assert.ok(blockers.some((item) => item.includes("acknowledgement")));
  assert.ok(blockers.some((item) => item.includes("One-time payroll inputs changed")));
}

function testMakerCheckerSeparation() {
  const maker = objectId();
  assert.throws(() => ensureIndependentPayrollReviewer(maker, maker), /submitter cannot approve/);
  assert.doesNotThrow(() => ensureIndependentPayrollReviewer(maker, objectId()));
}

function testReviewSchema() {
  const submittedBy = objectId();
  const run = new PayrollRun({
    company: objectId(), companyNameSnapshot: "Acme", companyCodeSnapshot: "ACME", periodKey: "2026-09",
    cycleStartDate: "2026-08-26", cycleEndDate: "2026-09-25", attendancePayrollInput: objectId(),
    attendancePayrollInputVersion: 1, attendancePeriod: objectId(), attendancePeriodVersion: 1,
    attendanceCutoffDay: 25, attendanceSummaryCount: 1, attendanceAdjustmentCount: 0, attendanceTotals: {},
    attendanceLockedAt: new Date(), attendanceLockedBy: objectId(), currency: "INR", currencyMinorUnits: 2,
    payFrequency: "monthly", payDay: 31, roundingMode: "nearest", preparationReason: "Prepare payroll",
    createdBy: objectId(), status: "review", reviewSubmittedAt: new Date(), reviewSubmittedBy: submittedBy,
    reviewSubmissionReason: "Ready for independent review", reviewCalculationVersion: 1,
  });
  assert.equal(run.validateSync(), undefined);
  run.reviewSubmissionReason = "x";
  assert.ok(run.validateSync()?.errors.reviewSubmissionReason);
}

testReviewReadiness();
testMakerCheckerSeparation();
testReviewSchema();

console.log("Payroll maker-checker readiness, identity separation, and schema tests passed");
