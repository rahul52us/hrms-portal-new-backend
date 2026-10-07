import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import {
  buildStatutoryReportData,
  buildStatutoryReportWorkbook,
  serializeStatutoryReportEmployee,
} from "./payrollStatutoryReport.service";

const employee = new mongoose.Types.ObjectId();
const run = {
  _id: new mongoose.Types.ObjectId(),
  companyNameSnapshot: "Acme Private Limited",
  companyCodeSnapshot: "ACME",
  periodKey: "2026-09",
  cycleStartDate: "2026-08-26",
  cycleEndDate: "2026-09-25",
  finalizedAt: new Date("2026-09-27T10:00:00.000Z"),
  statutoryProviderKey: "india_standard",
  statutoryProviderImplementationVersion: "1.4.0",
  statutoryProfileVersionNumber: 3,
  statutoryEnabledModules: ["provident_fund", "income_tax_withholding"],
  statutoryConfigurationSnapshot: {
    registeredLegalName: "Acme Private Limited",
    providentFundEstablishmentCode: "DLCPM0012345000",
    taxDeductionAccountNumber: "DELA12345B",
  },
  currency: "INR",
  currencyMinorUnits: 2,
};

const results: any[] = [{
  _id: new mongoose.Types.ObjectId(),
  employee,
  employeeSnapshotVersion: 2,
  identity: { name: "Kavya Singh", code: "ACME-001", username: "kavya@example.com" },
  organization: { departmentName: "Engineering", teamName: "Platform", officeLocationName: "Delhi", officeLocationState: "Delhi" },
  payrollDays: { paidDays: 30, unpaidDays: 0 },
  totals: { grossEarningsMinor: 10000000 },
  statutoryContributions: [
    { moduleKey: "provident_fund", code: "EPF_EMPLOYEE", name: "Employee provident fund", side: "employee_deduction", wageBaseMinor: 1500000, rateBps: 1200, amountMinor: 180000, ruleVersion: "IN_SOCIAL_SECURITY_2025_11", ruleEffectiveFrom: "2025-11-01" },
    { moduleKey: "provident_fund", code: "EPF_EMPLOYER", name: "Employer provident fund", side: "employer_contribution", wageBaseMinor: 1500000, rateBps: 1200, amountMinor: 180000, ruleVersion: "IN_SOCIAL_SECURITY_2025_11", ruleEffectiveFrom: "2025-11-01" },
    { moduleKey: "income_tax_withholding", code: "IN_TDS_SALARY", name: "Salary income-tax withholding", side: "employee_deduction", wageBaseMinor: 120000000, rateBps: 0, amountMinor: 125000, ruleVersion: "IN_TAX_2026_27", ruleEffectiveFrom: "2026-04-01" },
  ],
  snapshotHash: "a".repeat(64),
}];

const snapshots: any[] = [{
  employee,
  snapshotVersion: 2,
  statutory: {
    panNumber: "ABCDE1234F",
    uan: "100200300400",
    pfMemberId: "DLCPM001234500000001",
    esiInsuranceNumber: "1234567890",
  },
}];

const report = buildStatutoryReportData({ run, results, snapshots, finalizationVersion: 1 });
assert.equal(report.employeeCount, 1);
assert.equal(report.employeeDeductionMinor, 305000);
assert.equal(report.employerContributionMinor, 180000);
assert.equal(report.modules.find((module) => module.key === "provident_fund")?.registerReady, true);
assert.equal(report.modules.find((module) => module.key === "income_tax_withholding")?.registerReady, true);

const serialized = serializeStatutoryReportEmployee(results[0], snapshots[0], "all");
assert.equal(serialized.identifiers.panMasked, "*******34F");
assert.equal(serialized.identifiers.uanMasked, "********0400");
assert.equal((serialized as any).identifiers.panNumber, undefined);

const missingReport = buildStatutoryReportData({
  run: { ...run, statutoryConfigurationSnapshot: {} },
  results,
  snapshots: [{ employee, snapshotVersion: 2, statutory: {} }],
  finalizationVersion: 1,
});
assert.ok(missingReport.modules.find((module) => module.key === "provident_fund")?.blockers.some((blocker) => blocker.includes("registration")));
assert.equal(missingReport.modules.find((module) => module.key === "provident_fund")?.missingIdentifierCount, 1);

async function testWorkbook() {
  const buffer = await buildStatutoryReportWorkbook({ run, results, snapshots, finalizationVersion: 1 });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  assert.ok(workbook.getWorksheet("Report information"));
  assert.ok(workbook.getWorksheet("Readiness"));
  const contributions = workbook.getWorksheet("All contributions");
  assert.equal(contributions?.getRow(2).getCell(10).value, "ABCDE1234F");
  assert.equal(contributions?.rowCount, 4);
}

testWorkbook().then(() => console.log("Payroll statutory report tests passed"));
