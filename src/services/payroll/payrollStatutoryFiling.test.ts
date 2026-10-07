import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  buildEpfoEcrFiling,
  renderEpfoEcrText,
  serializeEpfoEcrPreview,
} from "./payrollStatutoryFiling.service";

const employee = new mongoose.Types.ObjectId();
const run = {
  _id: new mongoose.Types.ObjectId(),
  periodKey: "2026-09",
  statutoryProviderKey: "india_standard",
  statutoryProviderImplementationVersion: "1.5.0",
  statutoryEnabledModules: ["provident_fund"],
  statutoryConfigurationSnapshot: {
    providentFundEstablishmentCode: "DLCPM0012345000",
    providentFundContributionRate: "12",
  },
  currency: "INR",
  currencyMinorUnits: 2,
};

const result: any = {
  employee,
  employeeSnapshotVersion: 2,
  identity: { name: "Asha Sharma", code: "ACME-001" },
  payrollDays: { paidDays: 30, unpaidDays: 0, totalDays: 30 },
  totals: { grossEarningsMinor: 10000000 },
  statutoryContributions: [
    { moduleKey: "provident_fund", code: "EPF_EMPLOYEE", wageBaseMinor: 2500000, amountMinor: 300000 },
    { moduleKey: "provident_fund", code: "EPS_EMPLOYER", wageBaseMinor: 1500000, amountMinor: 125000 },
    { moduleKey: "provident_fund", code: "EPF_EMPLOYER", wageBaseMinor: 2500000, amountMinor: 175000 },
    { moduleKey: "provident_fund", code: "EDLI_EMPLOYER", wageBaseMinor: 2500000, amountMinor: 12500 },
  ],
};

const snapshot: any = {
  employee,
  snapshotVersion: 2,
  statutory: { uan: "100200300400", nameAsPerUan: "ASHA SHARMA", applicability: { providentFund: true, employeesPensionScheme: true } },
};

const filing = buildEpfoEcrFiling({ run, finalizationVersion: 1, results: [result], snapshots: [snapshot] });
assert.equal(filing.ready, true);
assert.equal(filing.employeeCount, 1);
assert.equal(filing.rows[0].grossWages, 100000);
assert.equal(filing.rows[0].epfWages, 25000);
assert.equal(filing.rows[0].epsWages, 15000);
assert.equal(filing.rows[0].employeePfContribution, 3000);
assert.equal(filing.rows[0].employerEpsContribution, 1250);
assert.equal(filing.rows[0].employerPfContribution, 1750);
assert.equal(
  renderEpfoEcrText(filing.rows),
  "100200300400#~#ASHA SHARMA#~#100000#~#25000#~#15000#~#25000#~#3000#~#1250#~#1750#~#0#~#0\r\n"
);

const preview = serializeEpfoEcrPreview(filing);
assert.equal(preview.rows[0].uanMasked, "********0400");
assert.equal((preview.rows[0] as any).uan, undefined);
assert.equal((preview.rows[0] as any).memberName, undefined);

const blocked = buildEpfoEcrFiling({
  run: { ...run, statutoryProviderImplementationVersion: "1.4.0" },
  finalizationVersion: 1,
  results: [{ ...result, payrollDays: { ...result.payrollDays, unpaidDays: 0.5 } }],
  snapshots: [{ ...snapshot, statutory: { ...snapshot.statutory, nameAsPerUan: "" } }],
});
assert.equal(blocked.ready, false);
assert.ok(blocked.blockers.some((item) => item.code === "provider_upgrade_required"));
assert.ok(blocked.blockers.some((item) => item.code === "missing_name_as_per_uan"));
assert.ok(blocked.blockers.some((item) => item.code === "invalid_ncp_days"));

const mismatched = buildEpfoEcrFiling({
  run,
  finalizationVersion: 1,
  results: [{
    ...result,
    statutoryContributions: result.statutoryContributions.map((item: any) => item.code === "EPF_EMPLOYER" ? { ...item, amountMinor: 170000 } : item),
  }],
  snapshots: [snapshot],
});
assert.ok(mismatched.blockers.some((item) => item.code === "employer_split_mismatch"));

console.log("EPFO ECR readiness, masking, reconciliation, and text format tests passed");
