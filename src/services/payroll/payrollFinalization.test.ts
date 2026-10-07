import assert from "node:assert/strict";
import mongoose from "mongoose";
import PayrollFinalizedResult from "../../schemas/Payroll/PayrollFinalizedResult.schema";
import { getDefaultPermissionsForRole, PERMISSION_KEYS } from "../permissions/permission.utils";
import { PAYROLL_RESULT_TOTAL_FIELDS } from "./payrollCalculation.service";
import {
  buildFinalizedPayrollDocuments,
  finalizedPayrollSnapshotHash,
  reconcileFinalizedPayrollDocuments,
} from "./payrollFinalization.service";

const objectId = () => new mongoose.Types.ObjectId();

function fixture() {
  const company = objectId();
  const payrollRun = objectId();
  const employee = objectId();
  const actorId = objectId();
  const totals = Object.fromEntries(PAYROLL_RESULT_TOTAL_FIELDS.map((field, index) => [field, field === "netPayMinor" ? 1000 : index + 1]));
  const result = {
    _id: objectId(), company, payrollRun, calculationVersion: 2, sourceRunVersion: 7,
    employeeSnapshotVersion: 3, employee,
    identity: { name: "Asha", code: "ACME-1" }, organization: { departmentName: "Engineering" },
    payrollDays: { paidDays: 29, unpaidDays: 1, totalDays: 30, approvedOvertimeMinutes: 0 },
    recurringComponents: [], oneTimeInputs: [], totals,
    statutoryContributions: [{
      providerKey: "india_standard", providerImplementationVersion: "1.1.0",
      moduleKey: "provident_fund", code: "EPF_EMPLOYEE", name: "Employee provident fund",
      side: "employee_deduction", wageBaseMinor: 1000000, rateBps: 1200, amountMinor: 120000,
      roundingMode: "nearest_major_unit", ruleVersion: "IN_SOCIAL_SECURITY_2025_11", ruleEffectiveFrom: "2025-11-21",
    }],
    issues: [{ code: "missing_pan", category: "statutory", severity: "warning", message: "PAN missing" }],
    calculatedAt: new Date("2026-10-01T00:00:00.000Z"), calculatedBy: objectId(),
  };
  const decision = {
    _id: objectId(), employeePayrollResult: result._id, issueCode: "missing_pan", issueCategory: "statutory",
    action: "acknowledge", reason: "Accepted for this cycle", actor: actorId,
    actorNameSnapshot: "Payroll Checker", actorCodeSnapshot: "ACME-2", createdAt: new Date("2026-10-02T00:00:00.000Z"),
  };
  const run = { _id: payrollRun, company, periodKey: "2026-09", currency: "INR", currencyMinorUnits: 2 };
  return { run, result, decision, actorId, totals };
}

function testSnapshotBuildAndHash() {
  const source = fixture();
  const documents = buildFinalizedPayrollDocuments({
    run: source.run, results: [source.result], decisions: [source.decision], actorId: source.actorId,
    finalizedAt: new Date("2026-10-03T00:00:00.000Z"), finalizationVersion: 1,
  });
  assert.equal(documents.length, 1);
  assert.equal(documents[0].validationDecisions.length, 1);
  assert.equal(documents[0].statutoryContributions[0].code, "EPF_EMPLOYEE");
  assert.equal(documents[0].validationDecisions[0].action, "acknowledge");
  assert.match(documents[0].snapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(finalizedPayrollSnapshotHash({ b: 2, a: 1 }), finalizedPayrollSnapshotHash({ a: 1, b: 2 }));
  assert.notEqual(finalizedPayrollSnapshotHash({ a: 1 }), finalizedPayrollSnapshotHash({ a: 2 }));
  const document = new PayrollFinalizedResult(documents[0]);
  assert.equal(document.validateSync(), undefined);
}

function testReconciliationAndIndexes() {
  const source = fixture();
  const documents = buildFinalizedPayrollDocuments({
    run: source.run, results: [source.result], decisions: [source.decision], actorId: source.actorId,
    finalizedAt: new Date(), finalizationVersion: 1,
  });
  assert.deepEqual(reconcileFinalizedPayrollDocuments(documents, 1, source.totals), source.totals);
  assert.throws(() => reconcileFinalizedPayrollDocuments(documents, 2, source.totals), /employee count/);
  assert.throws(() => reconcileFinalizedPayrollDocuments(documents, 1, { ...source.totals, netPayMinor: 999 }), /netPayMinor/);
  const uniqueIndex = PayrollFinalizedResult.schema.indexes().find(([fields, options]) =>
    fields.company === 1 && fields.payrollRun === 1 && fields.finalizationVersion === 1 && fields.employee === 1 && options.unique
  );
  assert.ok(uniqueIndex, "finalized payroll results must be unique per run version and employee");
}

function testPermissions() {
  assert.equal(getDefaultPermissionsForRole("admin")[PERMISSION_KEYS.FINALIZE_PAYROLL_RUNS], true);
  assert.equal(getDefaultPermissionsForRole("hradmin")[PERMISSION_KEYS.FINALIZE_PAYROLL_RUNS], true);
  assert.equal(getDefaultPermissionsForRole("hr")[PERMISSION_KEYS.FINALIZE_PAYROLL_RUNS], false);
}

testSnapshotBuildAndHash();
testReconciliationAndIndexes();
testPermissions();

console.log("Payroll finalization snapshots, reconciliation, hashes, indexes, and permissions tests passed");
