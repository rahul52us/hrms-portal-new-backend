import assert from "node:assert/strict";
import mongoose from "mongoose";
import PayrollEmployeeSnapshot from "../../schemas/Payroll/PayrollEmployeeSnapshot.schema";
import {
  buildPayrollEmployeeSnapshots,
  serializePayrollEmployeeSnapshot,
} from "./payrollEmployeeSnapshot.service";

const objectId = () => new mongoose.Types.ObjectId();

function fixture() {
  const company = objectId();
  const runId = objectId();
  const actorId = objectId();
  const employee = objectId();
  const incompleteEmployee = objectId();
  const earningComponent = objectId();
  const run = {
    _id: runId,
    company,
    periodKey: "2026-09",
    cycleEndDate: "2026-09-25",
    currency: "INR",
    currencyMinorUnits: 2,
  };
  const payrollInputs = [
    {
      _id: objectId(),
      employee,
      employeeNameSnapshot: "Asha Sharma",
      employeeCodeSnapshot: "ACME-101",
      designationSnapshot: "Engineer",
      department: objectId(),
      departmentNameSnapshot: "Engineering",
      teamId: objectId(),
      teamNameSnapshot: "Platform",
      officeLocation: objectId(),
      officeLocationNameSnapshot: "Delhi",
      reportingManager: objectId(),
      reportingManagerNameSnapshot: "Manager One",
    },
    {
      _id: objectId(),
      employee: incompleteEmployee,
      employeeNameSnapshot: "Incomplete Employee",
      employeeCodeSnapshot: "ACME-102",
      designationSnapshot: "",
      departmentNameSnapshot: "",
    },
  ];
  const users = [{
    _id: employee,
    username: "asha@example.com",
    mobileNumber: "9876543210",
    role: "user",
    joiningDate: new Date("2025-01-01T00:00:00.000Z"),
  }];
  const banks = [{
    _id: objectId(),
    user: employee,
    nameAsPerBank: "Asha Sharma",
    name: "Example Bank",
    accountNo: "123456789012",
    branch: "Delhi",
    ifsc: "EXAM0001234",
  }];
  const profiles = [{
    _id: objectId(),
    user: employee,
    statutoryDetails: {
      aadharNumber: "123412341234",
      nameAsPerAadhar: "Asha Sharma",
      panNumber: "ABCDE1234F",
      nameAsPerPan: "Asha Sharma",
      nationality: "indian",
    },
  }];
  const compensationAssignments = [{
    _id: objectId(),
    employee,
    structureNameSnapshot: "India Standard",
    structureCodeSnapshot: "IND_STD",
    structureVersionNumber: 2,
    effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
    currency: "INR",
    currencyMinorUnits: 2,
    payFrequency: "monthly",
    roundingMode: "nearest",
    componentAmounts: [{
      salaryComponent: earningComponent,
      componentCodeSnapshot: "BASIC",
      componentNameSnapshot: "Basic Salary",
      categorySnapshot: "earning",
      taxableSnapshot: true,
      prorateOnUnpaidDaysSnapshot: true,
      monthlyAmountMinor: 5000000,
      annualAmountMinor: 60000000,
      overridden: false,
    }],
    totals: {
      monthlyGrossMinor: 5000000,
      monthlyDeductionsMinor: 0,
      monthlyReimbursementsMinor: 0,
      monthlyEmployerContributionsMinor: 0,
      monthlyNetMinor: 5000000,
      monthlyEmployerCostMinor: 5000000,
    },
  }];
  return { run, payrollInputs, users, banks, profiles, compensationAssignments, actorId };
}

function testBuildSnapshotsAndIssues() {
  const source = fixture();
  const built = buildPayrollEmployeeSnapshots({ ...source, snapshotVersion: 1 });
  assert.equal(built.documents.length, 2);
  assert.equal(built.issueCount, 1);
  assert.equal(built.errorCount, 1);
  assert.equal(built.warningCount, 1);
  assert.equal(built.compensationTotals.monthlyGrossMinor, 5000000);
  assert.equal(built.compensationTotals.monthlyNetMinor, 5000000);

  const complete = built.documents[0];
  assert.equal(complete.identity.name, "Asha Sharma");
  assert.equal(complete.organization.departmentName, "Engineering");
  assert.equal(complete.bank.accountNumber, "123456789012");
  assert.equal(complete.statutory.panNumber, "ABCDE1234F");
  assert.equal(complete.compensation.assigned, true);
  assert.equal(complete.compensation.componentAmounts.length, 1);
  assert.deepEqual(complete.issues, []);

  const incomplete = built.documents[1];
  assert.equal(incomplete.hasErrors, true);
  assert.equal(incomplete.hasWarnings, true);
  assert.ok(incomplete.issues.some((issue) => issue.code === "missing_compensation_assignment"));
  assert.ok(incomplete.issues.some((issue) => issue.code === "missing_bank_details"));
  assert.ok(incomplete.issues.some((issue) => issue.code === "missing_statutory_profile"));
}

function testSchemaAndVersionedIndex() {
  const source = fixture();
  const built = buildPayrollEmployeeSnapshots({ ...source, snapshotVersion: 2 });
  for (const snapshot of built.documents) {
    assert.equal(new PayrollEmployeeSnapshot(snapshot).validateSync(), undefined);
  }
  const versionedEmployee = PayrollEmployeeSnapshot.schema.indexes().find(([fields, options]) =>
    fields.company === 1
      && fields.payrollRun === 1
      && fields.snapshotVersion === 1
      && fields.employee === 1
      && options.unique
  );
  assert.ok(versionedEmployee, "employee snapshots must be unique inside each immutable run snapshot version");
}

function testSensitiveListSerialization() {
  const source = fixture();
  const built = buildPayrollEmployeeSnapshots({ ...source, snapshotVersion: 1 });
  const serialized: any = serializePayrollEmployeeSnapshot({ _id: objectId(), ...built.documents[0] });
  assert.equal(serialized.bank.accountNumberMasked, "********9012");
  assert.equal(serialized.statutory.aadharNumberMasked, "********1234");
  assert.equal(serialized.statutory.panNumberMasked, "*******34F");
  assert.equal(serialized.bank.accountNumber, undefined);
  assert.equal(serialized.statutory.panNumber, undefined);
  assert.equal(serialized.compensation.componentAmounts, undefined);
  assert.equal(serialized.compensation.componentCount, 1);
}

testBuildSnapshotsAndIssues();
testSchemaAndVersionedIndex();
testSensitiveListSerialization();

console.log("Payroll employee snapshot versioning, issues, compensation totals, and sensitive serialization tests passed");
