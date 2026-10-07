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
    statutoryWageBases: [],
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
    cycleEndDate: "2026-09-25",
    statutoryProviderKey: "",
    statutoryEnabledModules: [] as string[],
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
    componentStatutoryWageBasesSnapshot: [],
    inputType,
    amountMinor,
    reason: `${inputType} reason`,
    reference: `${inputType}-1`,
  });
  const correctionSourceRun = objectId();
  const correctionSourceResult = objectId();
  const arrear = {
    ...oneTime("arrear", 50000, true),
    sourceType: "finalized_correction",
    sourcePayrollRun: correctionSourceRun,
    sourcePeriodKey: "2026-08",
    sourceFinalizationVersion: 1,
    sourceFinalizedResult: correctionSourceResult,
  };
  const oneTimeInputs = [
    oneTime("earning", 100000, true),
    arrear,
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
  const routedArrear = result.oneTimeInputs.find((item: any) => item.inputType === "arrear");
  assert.ok(routedArrear);
  assert.equal(routedArrear.sourceType, "finalized_correction");
  assert.equal(routedArrear.sourcePeriodKey, "2026-08");
  assert.equal(routedArrear.sourceFinalizationVersion, 1);
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

function testStatutoryContributionsAffectNetPayAndEmployerCost() {
  const source = fixture();
  source.run.cycleEndDate = "2026-09-25";
  source.run.statutoryProviderKey = "india_standard";
  source.run.statutoryEnabledModules = ["provident_fund"];
  source.employeeSnapshots[0].statutory = {
    providerKey: "india_standard",
    enabledModules: ["provident_fund"],
    applicability: { providentFund: true, providentFundHigherWages: false, employeesPensionScheme: true },
  };
  source.employeeSnapshots[0].compensation.componentAmounts[0].statutoryWageBases = ["provident_fund"];
  const result = buildDraftPayrollResults({ ...source, calculationVersion: 4 }).documents[0];
  assert.equal(result.statutoryContributions.length, 4);
  assert.equal(result.totals.statutoryEmployeeDeductionsMinor, 240000);
  assert.equal(result.totals.statutoryEmployerContributionsMinor, 250000);
  assert.equal(result.totals.netPayMinor, 2270000);
  assert.equal(result.totals.employerCostMinor, 3140000);
  assert.equal(result.statutoryContributions[0].ruleVersion, "IN_SOCIAL_SECURITY_2025_11");
}

function testIncomeTaxUsesProjectionAndPriorFinalizedWithholding() {
  const source = fixture();
  source.run.statutoryProviderKey = "india_standard";
  source.run.statutoryEnabledModules = ["income_tax_withholding"];
  (source.run as any).statutoryConfigurationSnapshot = { incomeTaxDefaultRegime: "new" };
  source.employeeSnapshots[0].identity.dateOfBirth = "1990-01-01";
  source.employeeSnapshots[0].statutory = {
    providerKey: "india_standard",
    enabledModules: ["income_tax_withholding"],
    panNumber: "ABCDE1234F",
    applicability: {},
    taxDeclaration: {
      taxYear: "2026-27",
      versionNumber: 1,
      taxRegime: "new",
      declarations: {},
    },
  };
  source.employeeSnapshots[0].compensation.componentAmounts[0].monthlyAmountMinor = 15000000;
  source.employeeSnapshots[0].compensation.componentAmounts[1].monthlyAmountMinor = 1000000;
  const priorTaxHistoryByEmployee = new Map([[String(source.payrollInputs[0].employee), {
    taxableEarningsMinor: 70000000,
    taxWithheldMinor: 2000000,
  }]]);
  const result = buildDraftPayrollResults({
    ...source,
    calculationVersion: 5,
    priorTaxHistoryByEmployee,
  }).documents[0];
  const tds = result.statutoryContributions.find((item: any) => item.code === "IN_TDS_SALARY");
  assert.ok(tds);
  assert.ok(tds.amountMinor > 0);
  assert.equal(tds.metadata.priorCurrentEmployerWithholdingMinor, 2000000);
  assert.equal(result.totals.incomeTaxWithholdingMinor, tds.amountMinor);
  assert.ok(result.totals.statutoryEmployeeDeductionsMinor >= result.totals.incomeTaxWithholdingMinor);
}

function testStateStatutoryContributionsUseSnapshottedOfficeState() {
  const source = fixture();
  source.run.cycleEndDate = "2026-12-25";
  source.run.statutoryProviderKey = "india_standard";
  source.run.statutoryEnabledModules = ["professional_tax", "labour_welfare_fund"];
  source.employeeSnapshots[0].identity.gender = 1;
  source.employeeSnapshots[0].organization.officeLocationState = "Karnataka";
  source.employeeSnapshots[0].organization.officeLocationCountry = "India";
  source.employeeSnapshots[0].statutory = {
    providerKey: "india_standard",
    enabledModules: ["professional_tax", "labour_welfare_fund"],
    applicability: { professionalTax: true, labourWelfareFund: true },
  };
  const result = buildDraftPayrollResults({ ...source, calculationVersion: 6 }).documents[0];
  assert.equal(result.statutoryContributions.find((item: any) => item.code === "IN_PT_EMPLOYEE")?.amountMinor, 20000);
  assert.equal(result.statutoryContributions.find((item: any) => item.code === "IN_LWF_EMPLOYEE")?.amountMinor, 5000);
  assert.equal(result.statutoryContributions.find((item: any) => item.code === "IN_LWF_EMPLOYER")?.amountMinor, 10000);
  assert.equal(result.totals.statutoryEmployeeDeductionsMinor, 25000);
  assert.equal(result.totals.statutoryEmployerContributionsMinor, 10000);
  assert.equal(result.totals.netPayMinor, 2485000);
  assert.equal(result.totals.employerCostMinor, 2900000);
}

function testStatutoryProviderVersionMismatchBlocksCalculation() {
  const source = fixture();
  source.run.statutoryProviderKey = "india_standard";
  source.run.statutoryEnabledModules = ["income_tax_withholding"];
  (source.run as any).statutoryProviderImplementationVersion = "1.2.0";
  source.employeeSnapshots[0].statutory = {
    providerKey: "india_standard",
    enabledModules: ["income_tax_withholding"],
    panNumber: "ABCDE1234F",
    applicability: {},
  };
  const result = buildDraftPayrollResults({ ...source, calculationVersion: 6 }).documents[0];
  assert.equal(result.statutoryContributions.length, 0);
  assert.ok(result.issues.some((issue: any) => issue.code === "statutory_provider_implementation_mismatch" && issue.severity === "error"));
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
testStatutoryContributionsAffectNetPayAndEmployerCost();
testIncomeTaxUsesProjectionAndPriorFinalizedWithholding();
testStateStatutoryContributionsUseSnapshottedOfficeState();
testStatutoryProviderVersionMismatchBlocksCalculation();
testSchemaVersioningAndRunDefaults();
testRoundingModes();

console.log("Draft payroll proration, one-time inputs, validation issues, versioning, and totals tests passed");
