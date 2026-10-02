import assert from "node:assert/strict";
import mongoose from "mongoose";
import PayrollValidationDecision from "../../schemas/Payroll/PayrollValidationDecision.schema";
import {
  validationDecisionTransition,
  validationIssueRecommendedAction,
} from "./payrollValidation.service";

const objectId = () => new mongoose.Types.ObjectId();

function validDecision() {
  return new PayrollValidationDecision({
    company: objectId(),
    payrollRun: objectId(),
    calculationVersion: 2,
    employeePayrollResult: objectId(),
    employee: objectId(),
    issueCode: "missing_pan",
    issueCategory: "statutory",
    issueSeverity: "warning",
    action: "acknowledge",
    reason: "PAN collection is pending and payroll may proceed",
    actor: objectId(),
    actorNameSnapshot: "Payroll Admin",
    actorCodeSnapshot: "ACME-001",
  });
}

function testDecisionSchemaAndIndex() {
  assert.equal(validDecision().validateSync(), undefined);
  const invalid = validDecision();
  invalid.reason = "x";
  assert.ok(invalid.validateSync()?.errors.reason);
  const historyIndex = PayrollValidationDecision.schema.indexes().find(([fields]) =>
    fields.company === 1
      && fields.payrollRun === 1
      && fields.calculationVersion === 1
      && fields.employeePayrollResult === 1
      && fields.issueCategory === 1
      && fields.issueCode === 1
      && fields.createdAt === -1
  );
  assert.ok(historyIndex, "validation decision history needs a current-issue lookup index");
}

function testWarningTransitions() {
  assert.deepEqual(validationDecisionTransition("warning", "", "acknowledge"), {
    create: true,
    status: "acknowledged",
  });
  assert.deepEqual(validationDecisionTransition("warning", "acknowledge", "acknowledge"), {
    create: false,
    status: "acknowledged",
  });
  assert.deepEqual(validationDecisionTransition("warning", "acknowledge", "reopen"), {
    create: true,
    status: "open",
  });
  assert.deepEqual(validationDecisionTransition("warning", "reopen", "reopen"), {
    create: false,
    status: "open",
  });
}

function testErrorsCannotBeWaived() {
  assert.throws(
    () => validationDecisionTransition("error", "", "acknowledge"),
    /Blocking payroll errors cannot be acknowledged/
  );
  assert.throws(
    () => validationDecisionTransition("warning", "", "ignore"),
    /Validation action must be acknowledge or reopen/
  );
}

function testRecommendedActions() {
  assert.match(validationIssueRecommendedAction("compensation", "missing_compensation_assignment"), /compensation effective/);
  assert.match(validationIssueRecommendedAction("attendance", "approved_overtime_requires_amount"), /one-time earning/);
  assert.match(validationIssueRecommendedAction("bank", "missing_bank_details"), /employee profile/);
}

testDecisionSchemaAndIndex();
testWarningTransitions();
testErrorsCannotBeWaived();
testRecommendedActions();

console.log("Payroll validation decision history, warning transitions, error guards, and remediation tests passed");
