import assert from "node:assert/strict";
import mongoose from "mongoose";
import EmployeePayrollResult from "../../schemas/Payroll/EmployeePayrollResult.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import { buildDraftPayrollResults, prorateMinorAmount } from "./payrollCalculation.service";

const objectId = () => new mongoose.Types.ObjectId();

function fixture() {
  const company = objectId();
  const runId = objectId();
  const employee = objectId();
  const actorId = objectId();
  const payrollInputId = objectId();
  const snapshotId = objectId();
  const component = (code: string, category: string, monthlyAmountMinor: number, prorateOnUnpaidDays: boolean, taxable = false) => ({
    salaryComponent: objectId(),
    componentCode: code,
    componentName: code,
    category,
    taxable,
    prorateOnUnpaidDays,
    monthlyAmountMinor,
    annualAmountMinor: monthlyAmountMinor * 12,
    overridden: false,
  });
  const run = {
    _id: runId,
    company,
    periodKey: "2026-09",
    version: 5,
    employeeSnapshotVersion: 2,
    currency: "INR",
    currencyMinorUnits: 2,
    roundingMode: "nearest",
  };
  const payrollInputs = [{
    _id: payrollInputId,
    employee,
    employeeNameSnapshot: "Asha Sharma",
    employeeCodeSnapshot: "ACME-101",
    payrollAttendance: { paidDays: 20, unpaidDays: 10, approvedOvertimeMinutes: 60 },
    inputIssues: [],
  }];
  const employeeSnapshots: any[] = [{
    _id: snapshotId,
    employee,
    identity: { name: "Asha Sharma", code: "ACME-101", username: "asha@example.com" },
    organization: { designation: "Engineer", departmentName: "Engineering" },
    compensation: {
      assigned: true,
      currency: "INR",
      componentAmounts: [
        component("BASIC", "earning", 3000000, true, true),
        component("ALLOWANCE", "earning", 500000, false, true),
        component("DEDUCTION", "deduction", 300000, true),
        component("REIMBURSEMENT", "reimbursement", 90000, true),
        component("EMPLOYER", "employer_contribution", 150000, false),
      ],
    },
    issues: [],
  }];
  const oneTime = (inputType: string, amountMinor: number, taxable = false) => ({
    _id: objectId(),
    employee,
    salaryComponent: objectId(),
    componentNameSnapshot: inputType,
    componentCodeSnapshot: inputType.toUpperCase(),
    componentCategorySnapshot: ["earning", "arrear"].includes(inputType)
      ? "earning"
      : ["deduction", "recovery"].includes(inputType)
        ? "deduction"
        : "reimbursement",
    componentTaxableSnapshot: taxable,
    inputType,
    amountMinor,
    reason: `${inputType} reason`,
    reference: `${inputType}-1`,
  });
  const oneTimeInputs = [
    oneTime("earning", 100000, true),
    oneTime("arrear", 50000, true),
    oneTime("deduction", 20000),
    oneTime("recovery", 10000),
    oneTime("reimbursement", 30000),
  ];
  return { run, payrollInputs, employeeSnapshots, oneTimeInputs, actorId };
}

function testProrationAndTotals() {
  const built = buildDraftPayrollResults({ ...fixture(), calculationVersion: 1 });
  assert.equal(built.documents.length, 1);
  assert.equal(built.errorCount, 0);
  assert.equal(built.warningCount, 1);
  const result = built.documents[0];
  assert.equal(result.recurringComponents.find((item: any) => item.componentCode === "BASIC").payableAmountMinor, 2000000);
  assert.equal(result.recurringComponents.find((item: any) => item.componentCode === "ALLOWANCE").payableAmountMinor, 500000);
  assert.equal(result.totals.scheduledEarningsMinor, 3500000);
  assert.equal(result.totals.earningProrationReductionMinor, 1000000);
  assert.equal(result.totals.recurringEarningsMinor, 2500000);
  assert.equal(result.totals.grossEarningsMinor, 2650000);
  assert.equal(result.totals.totalDeductionsMinor, 230000);
  assert.equal(result.totals.totalReimbursementsMinor, 90000);
  assert.equal(result.totals.taxableEarningsMinor, 2650000);
  assert.equal(result.totals.netPayMinor, 2510000);
  assert.equal(result.totals.employerCostMinor, 2890000);
  assert.equal(built.totals.netPayMinor, 2510000);
  assert.ok(result.issues.some((issue: any) => issue.code === "approved_overtime_requires_amount"));
}

function testInvalidSourceBecomesResultIssue() {
  const source = fixture();
  source.payrollInputs[0].payrollAttendance.paidDays = 0;
  source.payrollInputs[0].payrollAttendance.unpaidDays = 0;
  source.employeeSnapshots[0].compensation.assigned = false;
  source.employeeSnapshots[0].compensation.componentAmounts = [];
  source.employeeSnapshots[0].issues = [{
    code: "missing_compensation_assignment",
    severity: "error",
    category: "compensation",
    message: "No compensation assignment is effective",
  }];
  const result = buildDraftPayrollResults({ ...source, calculationVersion: 2 }).documents[0];
  assert.equal(result.hasErrors, true);
  assert.equal(result.totals.netPayMinor, 150000);
  assert.ok(result.issues.some((issue: any) => issue.code === "missing_compensation_assignment"));
  assert.ok(result.issues.some((issue: any) => issue.code === "invalid_payroll_days"));
}

function testSchemaVersioningAndRunDefaults() {
  const built = buildDraftPayrollResults({ ...fixture(), calculationVersion: 3 });
  const document = new EmployeePayrollResult(built.documents[0]);
  assert.equal(document.validateSync(), undefined);
  const uniqueVersion = EmployeePayrollResult.schema.indexes().find(([fields, options]) =>
    fields.company === 1
      && fields.payrollRun === 1
      && fields.calculationVersion === 1
      && fields.employee === 1
      && options.unique
  );
  assert.ok(uniqueVersion, "payroll results must be unique per immutable calculation version and employee");
  assert.ok(PayrollRun.schema.path("calculationStatus"));
  assert.equal((PayrollRun.schema.path("calculationStatus") as any).defaultValue, "pending");
}

function testRoundingModes() {
  assert.equal(prorateMinorAmount(100, 100, 300, "floor"), 33);
  assert.equal(prorateMinorAmount(100, 100, 300, "nearest"), 33);
  assert.equal(prorateMinorAmount(100, 100, 300, "ceil"), 34);
}

testProrationAndTotals();
testInvalidSourceBecomesResultIssue();
testSchemaVersioningAndRunDefaults();
testRoundingModes();

console.log("Draft payroll proration, one-time inputs, validation issues, versioning, and totals tests passed");
