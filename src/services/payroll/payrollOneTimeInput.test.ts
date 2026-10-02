import assert from "node:assert/strict";
import mongoose from "mongoose";
import PayrollAuditLog, { PAYROLL_AUDIT_ENTITY_TYPES } from "../../schemas/Payroll/PayrollAuditLog.schema";
import PayrollOneTimeInput from "../../schemas/Payroll/PayrollOneTimeInput.schema";
import {
  buildPayrollOneTimeInputDocument,
  oneTimeInputComponentCategory,
  oneTimeInputRunDelta,
  parsePayrollAmountToMinor,
} from "./payrollOneTimeInput.service";

const objectId = () => new mongoose.Types.ObjectId();

function fixture() {
  const company = objectId();
  const actorId = objectId();
  const run = {
    _id: objectId(),
    company,
    periodKey: "2026-09",
    currency: "INR",
    currencyMinorUnits: 2,
  };
  const employeeInput = {
    employee: objectId(),
    employeeNameSnapshot: "Asha Sharma",
    employeeCodeSnapshot: "ACME-101",
  };
  const component = {
    _id: objectId(),
    name: "Performance Bonus",
    code: "BONUS",
    category: "earning",
    taxable: true,
  };
  return { company, actorId, run, employeeInput, component };
}

function testAmountParsing() {
  assert.equal(parsePayrollAmountToMinor("1,250.50", 2), 125050);
  assert.equal(parsePayrollAmountToMinor("99", 0), 99);
  assert.equal(parsePayrollAmountToMinor("1.2", 3), 1200);
  assert.throws(() => parsePayrollAmountToMinor("10.001", 2), /at most 2 decimal places/);
  assert.throws(() => parsePayrollAmountToMinor("0", 2), /greater than zero/);
  assert.throws(() => parsePayrollAmountToMinor("-1", 2), /positive number/);
}

function testTypeRulesAndRunDeltas() {
  assert.equal(oneTimeInputComponentCategory("earning"), "earning");
  assert.equal(oneTimeInputComponentCategory("arrear"), "earning");
  assert.equal(oneTimeInputComponentCategory("deduction"), "deduction");
  assert.equal(oneTimeInputComponentCategory("recovery"), "deduction");
  assert.equal(oneTimeInputComponentCategory("reimbursement"), "reimbursement");
  assert.deepEqual(oneTimeInputRunDelta("earning", 5000), {
    earningsMinor: 5000,
    deductionsMinor: 0,
    reimbursementsMinor: 0,
    arrearsMinor: 0,
    recoveriesMinor: 0,
    netImpactMinor: 5000,
  });
  assert.equal(oneTimeInputRunDelta("recovery", 1200).netImpactMinor, -1200);
  assert.equal(oneTimeInputRunDelta("arrear", 800, -1).arrearsMinor, -800);
  assert.equal(oneTimeInputRunDelta("arrear", 800, -1).netImpactMinor, -800);
}

function testSnapshotAndIndexes() {
  const source = fixture();
  const data = buildPayrollOneTimeInputDocument({
    ...source,
    inputType: "earning",
    amountMinor: 125050,
    reason: "September performance bonus",
    reference: "BONUS-SEP-2026",
    idempotencyKey: "request-12345678",
  });
  const input = new PayrollOneTimeInput(data);
  assert.equal(input.validateSync(), undefined);
  assert.equal(input.employeeNameSnapshot, "Asha Sharma");
  assert.equal(input.componentCodeSnapshot, "BONUS");
  assert.equal(input.amountMinor, 125050);
  assert.equal(input.status, "active");

  input.amountMinor = 1.5;
  assert.ok(input.validateSync()?.errors.amountMinor);
  const uniqueRequest = PayrollOneTimeInput.schema.indexes().find(([fields, options]) =>
    fields.company === 1 && fields.payrollRun === 1 && fields.idempotencyKey === 1 && options.unique
  );
  assert.ok(uniqueRequest, "one-time payroll writes require a run-scoped idempotency index");
}

function testAuditEntity() {
  assert.ok(PAYROLL_AUDIT_ENTITY_TYPES.includes("payroll_input"));
  const audit = new PayrollAuditLog({
    company: objectId(),
    entityType: "payroll_input",
    entityId: objectId(),
    action: "created",
    actor: objectId(),
  });
  assert.equal(audit.validateSync(), undefined);
}

testAmountParsing();
testTypeRulesAndRunDeltas();
testSnapshotAndIndexes();
testAuditEntity();

console.log("One-time payroll input amount, snapshot, totals, idempotency, and audit tests passed");
