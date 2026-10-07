import assert from "node:assert/strict";
import mongoose from "mongoose";
import * as XLSX from "@e965/xlsx";
import PayrollStatutoryFilingInput from "../../schemas/Payroll/PayrollStatutoryFilingInput.schema";
import {
  buildEsicMonthlyContributionFiling,
  renderEsicMonthlyContributionXls,
  serializeEsicMonthlyPreview,
} from "./payrollEsicFiling.service";

const employee = new mongoose.Types.ObjectId();
const exitedEmployee = new mongoose.Types.ObjectId();
const zeroWageEmployee = new mongoose.Types.ObjectId();
const run = {
  _id: new mongoose.Types.ObjectId(),
  periodKey: "2026-09",
  cycleEndDate: "2026-09-30",
  statutoryProviderKey: "india_standard",
  statutoryProviderImplementationVersion: "1.6.0",
  statutoryEnabledModules: ["employee_state_insurance"],
  statutoryConfigurationSnapshot: { employeeStateInsuranceCode: "11001234560001001" },
  currency: "INR",
  currencyMinorUnits: 2,
};

const result = {
  employee,
  employeeSnapshotVersion: 2,
  identity: { name: "Asha Sharma", code: "ACME-001" },
  payrollDays: { paidDays: 26.25, unpaidDays: 3.75, totalDays: 30 },
  statutoryContributions: [
    { moduleKey: "employee_state_insurance", code: "ESI_EMPLOYEE", wageBaseMinor: 1800000, amountMinor: 13500 },
    { moduleKey: "employee_state_insurance", code: "ESI_EMPLOYER", wageBaseMinor: 1800000, amountMinor: 58500 },
  ],
};
const exitedResult = {
  employee: exitedEmployee,
  employeeSnapshotVersion: 2,
  identity: { name: "Bharat Singh", code: "ACME-002" },
  payrollDays: { paidDays: 10, unpaidDays: 20, totalDays: 30 },
  statutoryContributions: [
    { moduleKey: "employee_state_insurance", code: "ESI_EMPLOYEE", wageBaseMinor: 800000, amountMinor: 6000 },
    { moduleKey: "employee_state_insurance", code: "ESI_EMPLOYER", wageBaseMinor: 800000, amountMinor: 26000 },
  ],
};
const zeroWageResult = {
  employee: zeroWageEmployee,
  employeeSnapshotVersion: 2,
  identity: { name: "Charu Nair", code: "ACME-003" },
  payrollDays: { paidDays: 0, unpaidDays: 30, totalDays: 30 },
  statutoryContributions: [],
};
const snapshots = [
  { employee, snapshotVersion: 2, identity: {}, statutory: { esiInsuranceNumber: "1234567890", nameAsPerEsi: "ASHA SHARMA", applicability: { employeeStateInsurance: true } } },
  { employee: exitedEmployee, snapshotVersion: 2, identity: { employmentEndDate: "2026-09-15" }, statutory: { esiInsuranceNumber: "2234567890", nameAsPerEsi: "BHARAT SINGH", applicability: { employeeStateInsurance: true } } },
  { employee: zeroWageEmployee, snapshotVersion: 2, identity: {}, statutory: { esiInsuranceNumber: "3234567890", nameAsPerEsi: "CHARU NAIR", applicability: { employeeStateInsurance: true } } },
];

const blocked = buildEsicMonthlyContributionFiling({ run, finalizationVersion: 1, results: [result, exitedResult, zeroWageResult], snapshots });
assert.equal(blocked.ready, false);
assert.ok(blocked.blockers.some((item) => item.code === "missing_zero_wage_reason" && item.employeeCode === "ACME-003"));
assert.equal(blocked.rows[0].paidDays, 27);
assert.equal(blocked.rows[1].reasonCode, 2);
assert.equal(blocked.rows[1].lastWorkingDay, "2026-09-15");
assert.equal(blocked.rows[1].reasonSource, "employment_exit");

const filing = buildEsicMonthlyContributionFiling({
  run,
  finalizationVersion: 1,
  results: [result, exitedResult, zeroWageResult],
  snapshots,
  filingInputs: [{ employee: zeroWageEmployee, revisionNumber: 1, reasonCode: 1 }],
});
assert.equal(filing.ready, true);
assert.equal(filing.employeeCount, 3);
assert.equal(filing.zeroWageEmployeeCount, 1);
assert.equal(filing.employeeContributionTotal, 195);
assert.equal(filing.employerContributionTotal, 845);

const preview = serializeEsicMonthlyPreview(filing);
assert.equal(preview.rows[0].insuranceNumberMasked, "******7890");
assert.equal((preview.rows[0] as any).insuranceNumber, undefined);
assert.equal((preview.rows[0] as any).insuredPersonName, undefined);

const workbookBuffer = renderEsicMonthlyContributionXls(filing.rows);
const workbook = XLSX.read(workbookBuffer, { type: "buffer", raw: true });
const worksheet = workbook.Sheets.MC;
const values = XLSX.utils.sheet_to_json<string[]>(worksheet, { header: 1, raw: false });
assert.equal(values[0].length, 6);
assert.deepEqual(values[1], ["1234567890", "ASHA SHARMA", "27", "18000", "0", ""]);
assert.deepEqual(values[2], ["2234567890", "BHARAT SINGH", "10", "8000", "2", "15/09/2026"]);
assert.deepEqual(values[3], ["3234567890", "CHARU NAIR", "0", "0", "1", ""]);

const invalid = buildEsicMonthlyContributionFiling({
  run: { ...run, statutoryProviderImplementationVersion: "1.5.0" },
  finalizationVersion: 1,
  results: [result],
  snapshots: [{ ...snapshots[0], statutory: { ...snapshots[0].statutory, nameAsPerEsi: "ASHA S." } }],
});
assert.ok(invalid.blockers.some((item) => item.code === "provider_upgrade_required"));
assert.ok(invalid.blockers.some((item) => item.code === "invalid_name_as_per_esi"));

const inputDocument = new PayrollStatutoryFilingInput({
  company: new mongoose.Types.ObjectId(),
  payrollRun: run._id,
  periodKey: run.periodKey,
  finalizationVersion: 1,
  adapterKey: "esic_monthly_contribution",
  employee: zeroWageEmployee,
  employeeSnapshotVersion: 2,
  revisionNumber: 1,
  reasonCode: 1,
  changeReason: "Employee was on unpaid leave",
  createdBy: new mongoose.Types.ObjectId(),
});
assert.equal(inputDocument.validateSync(), undefined);
assert.ok(PayrollStatutoryFilingInput.schema.indexes().some(([fields, options]) =>
  fields.company === 1 && fields.payrollRun === 1 && fields.finalizationVersion === 1 && fields.employee === 1 && fields.revisionNumber === 1 && options.unique
));

console.log("ESIC monthly contribution readiness, reasons, masking, and BIFF8 workbook tests passed");
