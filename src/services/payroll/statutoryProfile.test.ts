import assert from "node:assert/strict";
import mongoose from "mongoose";
import PayrollAuditLog, { PAYROLL_AUDIT_ENTITY_TYPES } from "../../schemas/Payroll/PayrollAuditLog.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import StatutoryProfile from "../../schemas/Payroll/StatutoryProfile.schema";
import StatutoryProfileVersion from "../../schemas/Payroll/StatutoryProfileVersion.schema";
import { buildPayrollRunDocument } from "./payrollRun.service";
import { getStatutoryProvider, listStatutoryProviders } from "./statutory/statutoryProvider.registry";

const objectId = () => new mongoose.Types.ObjectId();

function testIndiaProviderValidation() {
  const provider = getStatutoryProvider("india_standard");
  assert.ok(provider);
  assert.equal(provider.countryCode, "IN");
  assert.ok(listStatutoryProviders().some((item) => item.key === "india_standard"));
  const draft = provider.validateAndNormalize({
    configuration: {
      registeredLegalName: "Acme Private Limited",
      registrationState: "Delhi",
      taxDeductionAccountNumber: "abcd12345e",
    },
    enabledModules: ["income_tax_withholding", "income_tax_withholding"],
    forPublish: false,
  });
  assert.deepEqual(draft.errors, []);
  assert.equal(draft.configuration.taxDeductionAccountNumber, "ABCD12345E");
  assert.deepEqual(draft.enabledModules, ["income_tax_withholding"]);
  const incomplete = provider.validateAndNormalize({ configuration: {}, enabledModules: [], forPublish: true });
  assert.ok(incomplete.errors.some((error) => error.includes("Registered legal name")));
  assert.ok(incomplete.errors.some((error) => error.includes("at least one")));
}

function testSchemasAndIndexes() {
  const company = objectId();
  const actor = objectId();
  const profile = new StatutoryProfile({
    company,
    name: "India statutory profile",
    code: "INDIA_MAIN",
    countryCode: "IN",
    providerKey: "india_standard",
    latestVersionNumber: 1,
    revision: 1,
    createdBy: actor,
    updatedBy: actor,
  });
  assert.equal(profile.validateSync(), undefined);
  const version = new StatutoryProfileVersion({
    company,
    statutoryProfile: profile._id,
    versionNumber: 1,
    status: "draft",
    countryCode: "IN",
    providerKey: "india_standard",
    providerImplementationVersion: "1.0.0",
    enabledModules: ["provident_fund"],
    configuration: { registeredLegalName: "Acme Private Limited", registrationState: "Delhi" },
    revision: 1,
    createdBy: actor,
  });
  assert.equal(version.validateSync(), undefined);
  const oneDraft = StatutoryProfileVersion.schema.indexes().find(([fields, options]) =>
    fields.company === 1 && fields.statutoryProfile === 1 && fields.status === 1 && options.unique
  );
  assert.ok(oneDraft, "a statutory profile can have only one draft");
  assert.ok(PAYROLL_AUDIT_ENTITY_TYPES.includes("statutory_profile"));
  assert.equal(new PayrollAuditLog({ company, entityType: "statutory_profile", entityId: profile._id, action: "created", actor }).validateSync(), undefined);
}

function testPayrollRunStatutorySnapshot() {
  const company = objectId();
  const actorId = objectId();
  const profileId = objectId();
  const versionId = objectId();
  const data = buildPayrollRunDocument({
    company: {
      _id: company,
      company_name: "Acme Private Limited",
      companyCode: "ACME",
      payrollSettings: { currency: "INR", currencyMinorUnits: 2, payDay: 31, roundingMode: "nearest" },
    },
    input: {
      _id: objectId(),
      attendancePeriod: objectId(),
      periodKey: "2026-09",
      cycleStartDate: "2026-08-26",
      cycleEndDate: "2026-09-25",
      attendanceCutoffDay: 25,
      version: 1,
      attendancePeriodVersion: 1,
      summaryCount: 1,
      adjustmentCount: 0,
      totals: {},
      lockedAt: new Date(),
      lockedBy: actorId,
    },
    actorId,
    reason: "Prepare payroll",
    statutorySnapshot: {
      statutoryProfile: profileId,
      statutoryProfileVersion: versionId,
      statutoryProfileVersionNumber: 2,
      statutoryCountryCode: "IN",
      statutoryProviderKey: "india_standard",
      statutoryProviderImplementationVersion: "1.0.0",
      statutoryEnabledModules: ["provident_fund"],
      statutoryConfigurationSnapshot: { registeredLegalName: "Acme Private Limited", registrationState: "Delhi" },
    },
  });
  const run = new PayrollRun(data);
  assert.equal(run.validateSync(), undefined);
  assert.equal(String(run.statutoryProfile), String(profileId));
  assert.equal(String(run.statutoryProfileVersion), String(versionId));
  assert.equal(run.statutoryProfileVersionNumber, 2);
  assert.deepEqual(run.statutoryEnabledModules, ["provident_fund"]);
  assert.equal((run.statutoryConfigurationSnapshot as any).registeredLegalName, "Acme Private Limited");
}

testIndiaProviderValidation();
testSchemasAndIndexes();
testPayrollRunStatutorySnapshot();

console.log("Statutory provider, version schema, audit, and payroll-run snapshot tests passed");
