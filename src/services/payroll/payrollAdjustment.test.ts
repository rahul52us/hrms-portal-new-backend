import assert from "node:assert/strict";
import mongoose from "mongoose";
import PayrollOneTimeInput from "../../schemas/Payroll/PayrollOneTimeInput.schema";
import {
  buildFinalizedCorrectionInputDocument,
  payrollAdjustmentBlocker,
} from "./payrollAdjustment.service";

const objectId = () => new mongoose.Types.ObjectId();

function fixture() {
  const company = objectId();
  const employee = objectId();
  const sourceRun = {
    _id: objectId(),
    company,
    periodKey: "2026-09",
    status: "finalized",
    finalizationVersion: 2,
    currency: "INR",
    currencyMinorUnits: 2,
  };
  const sourceResult = {
    _id: objectId(),
    payrollRun: sourceRun._id,
    employee,
    finalizationVersion: 2,
  };
  const targetRun = {
    _id: objectId(),
    company,
    periodKey: "2026-10",
    status: "draft",
    attendanceInputStatus: "prepared",
    currency: "INR",
    currencyMinorUnits: 2,
  };
  const employeeInput = {
    employee,
    employeeNameSnapshot: "Asha Sharma",
    employeeCodeSnapshot: "ACME-101",
  };
  const component = {
    _id: objectId(),
    name: "Salary Arrears",
    code: "ARREARS",
    category: "earning",
    taxable: true,
  };
  return { sourceRun, sourceResult, targetRun, employeeInput, component, actorId: objectId() };
}

function testRoutingGuards() {
  const source = fixture();
  assert.equal(payrollAdjustmentBlocker(source.sourceRun, source.sourceResult, source.targetRun), null);
  assert.match(payrollAdjustmentBlocker({ ...source.sourceRun, status: "draft" }, source.sourceResult, source.targetRun) || "", /finalized/);
  assert.match(payrollAdjustmentBlocker(source.sourceRun, { ...source.sourceResult, finalizationVersion: 1 }, source.targetRun) || "", /current finalized/);
  assert.match(payrollAdjustmentBlocker(source.sourceRun, source.sourceResult, { ...source.targetRun, status: "review" }) || "", /draft/);
  assert.match(payrollAdjustmentBlocker(source.sourceRun, source.sourceResult, { ...source.targetRun, attendanceInputStatus: "pending" }) || "", /attendance/);
  assert.match(payrollAdjustmentBlocker(source.sourceRun, source.sourceResult, { ...source.targetRun, periodKey: "2026-09" }) || "", /later period/);
  assert.match(payrollAdjustmentBlocker(source.sourceRun, source.sourceResult, { ...source.targetRun, currency: "USD" }) || "", /currency/);
}

function testCorrectionLineageSnapshot() {
  const source = fixture();
  const data = buildFinalizedCorrectionInputDocument({
    ...source,
    inputType: "arrear",
    amountMinor: 125050,
    reason: "Underpayment found after September finalization",
    reference: "CORR-SEP-001",
    idempotencyKey: "correction-request-001",
  });
  const input = new PayrollOneTimeInput(data);
  assert.equal(input.validateSync(), undefined);
  assert.equal(input.sourceType, "finalized_correction");
  assert.equal(String(input.sourcePayrollRun), String(source.sourceRun._id));
  assert.equal(input.sourcePeriodKey, "2026-09");
  assert.equal(input.sourceFinalizationVersion, 2);
  assert.equal(String(input.sourceFinalizedResult), String(source.sourceResult._id));
  assert.equal(input.payrollRun.toString(), source.targetRun._id.toString());
  assert.equal(input.periodKey, "2026-10");

  const missingLineage = new PayrollOneTimeInput({
    ...data,
    _id: objectId(),
    sourcePayrollRun: null,
    sourceFinalizedResult: null,
    sourceFinalizationVersion: null,
  });
  const errors = missingLineage.validateSync()?.errors || {};
  assert.ok(errors.sourcePayrollRun);
  assert.ok(errors.sourceFinalizedResult);
  assert.ok(errors.sourceFinalizationVersion);
}

testRoutingGuards();
testCorrectionLineageSnapshot();

console.log("Future payroll correction routing, lineage, and schema tests passed");
