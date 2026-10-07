import assert from "node:assert/strict";
import mongoose from "mongoose";
import EmployeeStatutoryAssignment from "../../schemas/Payroll/EmployeeStatutoryAssignment.schema";
import EmployeeTaxDeclaration from "../../schemas/Payroll/EmployeeTaxDeclaration.schema";
import { PAYROLL_AUDIT_ENTITY_TYPES } from "../../schemas/Payroll/PayrollAuditLog.schema";
import { PERMISSION_KEYS, getDefaultPermissionsForRole } from "../permissions/permission.utils";
import { buildPayrollEmployeeSnapshots } from "./payrollEmployeeSnapshot.service";
import { deriveStatutoryAssignmentRanges, taxYearForDate } from "./employeeStatutory.service";
import { getStatutoryProvider, listStatutoryProviders } from "./statutory/statutoryProvider.registry";

const objectId = () => new mongoose.Types.ObjectId();

function testProviderEmployeeValidation() {
  const provider = getStatutoryProvider("india_standard");
  assert.ok(provider);
  assert.equal(provider.implementationVersion, "1.6.0");
  assert.ok(listStatutoryProviders()[0].employeeIdentifierFields.some((field) => field.key === "uan"));
  assert.ok(listStatutoryProviders()[0].employeeIdentifierFields.some((field) => field.key === "nameAsPerUan"));
  assert.ok(listStatutoryProviders()[0].employeeIdentifierFields.some((field) => field.key === "nameAsPerEsi"));
  const identifiers = provider.validateEmployeeStatutory({
    identifiers: { panNumber: "abcde1234f", aadhaarNumber: "123412341234", uan: "100200300400", nameAsPerUan: "Asha Sharma" },
    applicability: { providentFund: true, employeesPensionScheme: true, employeeStateInsurance: true },
    enabledModules: ["income_tax_withholding", "provident_fund"],
  });
  assert.equal(identifiers.identifiers.panNumber, "ABCDE1234F");
  assert.equal(identifiers.applicability.providentFund, true);
  assert.equal(identifiers.applicability.employeesPensionScheme, true);
  assert.ok(identifiers.errors.some((error) => error.includes("Employee State Insurance")));
  const declaration = provider.validateTaxDeclaration({
    taxRegime: "old",
    declarations: { section80CMinor: 15000000 },
    forSubmit: true,
  });
  assert.deepEqual(declaration.errors, []);
  assert.equal(declaration.declarations.section80CMinor, 15000000);
  assert.equal(declaration.declarations.section80DMinor, 0);
}

function testSchemasIndexesPermissionsAndTaxYear() {
  const company = objectId();
  const employee = objectId();
  const actor = objectId();
  const profile = objectId();
  const profileVersion = objectId();
  const assignment = new EmployeeStatutoryAssignment({
    company,
    employee,
    employeeNameSnapshot: "Asha Sharma",
    employeeCodeSnapshot: "ACME-101",
    statutoryProfile: profile,
    statutoryProfileVersion: profileVersion,
    statutoryProfileVersionNumber: 2,
    countryCode: "IN",
    providerKey: "india_standard",
    providerImplementationVersion: "1.1.0",
    enabledModulesSnapshot: ["income_tax_withholding", "provident_fund"],
    effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
    identifiers: { panNumber: "ABCDE1234F", uan: "100200300400", nameAsPerUan: "Asha Sharma" },
    applicability: { providentFund: true, employeesPensionScheme: true },
    assignmentReason: "Initial statutory onboarding",
    createdBy: actor,
  });
  assert.equal(assignment.validateSync(), undefined);
  const declaration = new EmployeeTaxDeclaration({
    company,
    employee,
    employeeNameSnapshot: "Asha Sharma",
    employeeCodeSnapshot: "ACME-101",
    taxYear: "2026-27",
    versionNumber: 1,
    statutoryProfile: profile,
    statutoryProfileVersion: profileVersion,
    statutoryProfileVersionNumber: 2,
    countryCode: "IN",
    providerKey: "india_standard",
    providerImplementationVersion: "1.1.0",
    currency: "INR",
    currencyMinorUnits: 2,
    taxRegime: "new",
    declarations: {},
    changeReason: "Initial employee declaration",
    createdBy: actor,
    updatedBy: actor,
  });
  assert.equal(declaration.validateSync(), undefined);
  assert.ok(EmployeeStatutoryAssignment.schema.indexes().some(([fields, options]) =>
    fields.company === 1 && fields.employee === 1 && fields.effectiveFrom === 1 && options.unique
  ));
  assert.ok(EmployeeTaxDeclaration.schema.indexes().some(([fields, options]) =>
    fields.company === 1 && fields.employee === 1 && fields.taxYear === 1 && fields.versionNumber === 1 && options.unique
  ));
  assert.equal(getDefaultPermissionsForRole("admin")[PERMISSION_KEYS.MANAGE_EMPLOYEE_STATUTORY], true);
  assert.equal(getDefaultPermissionsForRole("hradmin")[PERMISSION_KEYS.MANAGE_EMPLOYEE_STATUTORY], true);
  assert.equal(getDefaultPermissionsForRole("hr")[PERMISSION_KEYS.MANAGE_EMPLOYEE_STATUTORY], false);
  assert.ok(PAYROLL_AUDIT_ENTITY_TYPES.includes("employee_statutory"));
  assert.ok(PAYROLL_AUDIT_ENTITY_TYPES.includes("employee_tax_declaration"));
  assert.ok(PAYROLL_AUDIT_ENTITY_TYPES.includes("statutory_filing"));
  assert.equal(taxYearForDate("2026-03-31"), "2025-26");
  assert.equal(taxYearForDate("2026-04-01"), "2026-27");
}

function testRangesAndPayrollSnapshotResolution() {
  const employee = objectId();
  const first = { _id: objectId(), employee, status: "assigned", effectiveFrom: new Date("2026-04-01T00:00:00.000Z") };
  const second = { _id: objectId(), employee, status: "assigned", effectiveFrom: new Date("2026-09-01T00:00:00.000Z") };
  const ranges = deriveStatutoryAssignmentRanges([second, first], "2026-09-25");
  assert.equal(ranges.find((item) => String(item._id) === String(first._id))?.effectiveTo, "2026-08-31");
  assert.equal(ranges.find((item) => String(item._id) === String(second._id))?.isCurrent, true);

  const company = objectId();
  const input = {
    _id: objectId(),
    employee,
    employeeNameSnapshot: "Asha Sharma",
    employeeCodeSnapshot: "ACME-101",
    designationSnapshot: "Engineer",
    departmentNameSnapshot: "Engineering",
  };
  const assignment = {
    _id: second._id,
    employee,
    countryCode: "IN",
    providerKey: "india_standard",
    providerImplementationVersion: "1.1.0",
    statutoryProfileVersionNumber: 2,
    enabledModulesSnapshot: ["income_tax_withholding", "provident_fund"],
    effectiveFrom: second.effectiveFrom,
    identifiers: { panNumber: "ABCDE1234F", uan: "100200300400", nameAsPerUan: "Asha Sharma", nationality: "indian" },
    applicability: { providentFund: true, employeesPensionScheme: true },
  };
  const taxDeclaration = {
    _id: objectId(),
    employee,
    taxYear: "2026-27",
    versionNumber: 1,
    taxRegime: "new",
    currency: "INR",
    currencyMinorUnits: 2,
    declarations: { otherIncomeMinor: 100000 },
  };
  const compensation = {
    _id: objectId(),
    employee,
    structureNameSnapshot: "Standard",
    structureCodeSnapshot: "STD",
    structureVersionNumber: 1,
    effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
    currency: "INR",
    currencyMinorUnits: 2,
    payFrequency: "monthly",
    roundingMode: "nearest",
    componentAmounts: [{ salaryComponent: objectId(), componentCodeSnapshot: "BASIC", componentNameSnapshot: "Basic", categorySnapshot: "earning", taxableSnapshot: true, prorateOnUnpaidDaysSnapshot: true, monthlyAmountMinor: 100000, annualAmountMinor: 1200000, overridden: false }],
    totals: {},
  };
  const built = buildPayrollEmployeeSnapshots({
    run: { _id: objectId(), company, periodKey: "2026-09", cycleEndDate: "2026-09-25", currency: "INR" },
    payrollInputs: [input],
    users: [{ _id: employee, username: "asha@example.com", role: "user" }],
    banks: [],
    profiles: [],
    statutoryAssignments: [assignment],
    taxDeclarations: [taxDeclaration],
    taxYear: "2026-27",
    compensationAssignments: [compensation],
    actorId: objectId(),
    snapshotVersion: 1,
  });
  assert.equal(built.documents[0].statutory.source, "effective_assignment");
  assert.equal(built.documents[0].statutory.panNumber, "ABCDE1234F");
  assert.equal(built.documents[0].statutory.nameAsPerUan, "Asha Sharma");
  assert.equal((built.documents[0].statutory as any).taxDeclaration.taxRegime, "new");
  assert.equal(built.documents[0].employeeStatutoryAssignment?.toString(), second._id.toString());
  assert.ok(!built.documents[0].issues.some((issue) => issue.code === "missing_verified_tax_declaration"));
}

testProviderEmployeeValidation();
testSchemasIndexesPermissionsAndTaxYear();
testRangesAndPayrollSnapshotResolution();

console.log("Employee statutory identifiers, tax declarations, permissions, and payroll snapshot tests passed");
