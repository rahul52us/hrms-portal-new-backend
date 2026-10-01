import assert from "node:assert/strict";
import mongoose from "mongoose";
import EmployeeCompensationAssignment from "../../schemas/Payroll/EmployeeCompensationAssignment.schema";
import { getDefaultPermissionsForRole, PERMISSION_KEYS } from "../permissions/permission.utils";
import { normalizeSettings, settingsFromCompany } from "./salaryStructure.service";
import {
  buildEmployeeCompensationProfile,
  deriveCompensationAssignmentRanges,
  serializeEmployeeCompensationAssignment,
} from "./employeeCompensation.service";

const objectId = () => new mongoose.Types.ObjectId();

function validAssignment() {
  const component = objectId();
  return new EmployeeCompensationAssignment({
    company: objectId(),
    employee: objectId(),
    employeeNameSnapshot: "Payroll Employee",
    employeeCodeSnapshot: "ACME-101",
    salaryStructure: objectId(),
    salaryStructureVersion: objectId(),
    structureNameSnapshot: "Standard India",
    structureCodeSnapshot: "STD_IN",
    structureVersionNumber: 1,
    structureEffectiveFromSnapshot: new Date("2026-01-01T00:00:00.000Z"),
    currency: "INR",
    currencyMinorUnits: 2,
    payFrequency: "monthly",
    roundingMode: "nearest",
    effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
    status: "assigned",
    assignmentReason: "Annual compensation revision",
    overrides: [],
    componentAmounts: [{
      salaryComponent: component,
      componentCodeSnapshot: "BASIC",
      componentNameSnapshot: "Basic Salary",
      categorySnapshot: "earning",
      taxableSnapshot: true,
      prorateOnUnpaidDaysSnapshot: true,
      monthlyAmountMinor: 5000000,
      annualAmountMinor: 60000000,
      overridden: false,
    }],
    totals: { monthlyGrossMinor: 5000000, monthlyNetMinor: 5000000 },
    createdBy: objectId(),
  });
}

function testValidSnapshotAndIndex() {
  const assignment = validAssignment();
  assert.equal(assignment.validateSync(), undefined);
  const uniqueEffectiveEdge = EmployeeCompensationAssignment.schema.indexes().find(([fields, options]) =>
    fields.company === 1 && fields.employee === 1 && fields.effectiveFrom === 1 && options.unique
  );
  assert.ok(uniqueEffectiveEdge, "effective-dated assignment uniqueness index is required");
  assert.deepEqual(uniqueEffectiveEdge?.[1].partialFilterExpression, { status: "assigned" });
}

function testInvalidSnapshot() {
  const assignment = validAssignment();
  assignment.assignmentReason = "x";
  assignment.componentAmounts[0].monthlyAmountMinor = -1;
  const validation = assignment.validateSync();
  assert.ok(validation?.errors.assignmentReason);
  assert.ok(validation?.errors["componentAmounts.0.monthlyAmountMinor"]);
}

function testDerivedEffectiveRanges() {
  const firstId = objectId();
  const secondId = objectId();
  const cancelledId = objectId();
  const ranges = deriveCompensationAssignmentRanges([
    { _id: firstId, status: "assigned", effectiveFrom: new Date("2026-01-01T00:00:00.000Z") },
    { _id: secondId, status: "assigned", effectiveFrom: new Date("2026-10-01T00:00:00.000Z") },
    { _id: cancelledId, status: "cancelled", effectiveFrom: new Date("2026-08-01T00:00:00.000Z") },
  ], "2026-09-29");
  const first = ranges.find((item) => String(item._id) === String(firstId));
  const second = ranges.find((item) => String(item._id) === String(secondId));
  const cancelled = ranges.find((item) => String(item._id) === String(cancelledId));
  assert.equal(first.effectiveTo, "2026-09-30");
  assert.equal(first.isCurrent, true);
  assert.equal(second.isUpcoming, true);
  assert.equal(cancelled.isCurrent, false);
  assert.equal(cancelled.effectiveTo, null);
}

function testPermissions() {
  assert.equal(getDefaultPermissionsForRole("admin")[PERMISSION_KEYS.MANAGE_EMPLOYEE_COMPENSATION], true);
  assert.equal(getDefaultPermissionsForRole("hradmin")[PERMISSION_KEYS.MANAGE_EMPLOYEE_COMPENSATION], true);
  assert.equal(getDefaultPermissionsForRole("hr")[PERMISSION_KEYS.MANAGE_EMPLOYEE_COMPENSATION], false);
}

function testEmployeeSafeSerialization() {
  const assignment = validAssignment().toObject();
  const serialized: any = serializeEmployeeCompensationAssignment({
    ...assignment,
    effectiveTo: "2026-12-31",
  });
  assert.equal(serialized.structureName, "Standard India");
  assert.equal(serialized.effectiveFrom, "2026-04-01");
  assert.equal(serialized.effectiveTo, "2026-12-31");
  assert.equal(serialized.components[0].code, "BASIC");
  assert.equal(serialized.totals.monthlyGrossMinor, 5000000);
  assert.equal(serialized.assignmentReason, undefined);
  assert.equal(serialized.createdBy, undefined);
  assert.equal(serialized.salaryStructure, undefined);
  assert.equal(serialized.components[0].salaryComponent, undefined);
}

function testCompensationVisibilitySettings() {
  assert.equal(settingsFromCompany({ payrollSettings: {} }).employeeCompensationVisibility, "hidden");
  const existingSettings = settingsFromCompany({ payrollSettings: { employeeCompensationVisibility: "history" } });
  assert.equal(normalizeSettings({
    currency: "INR",
    currencyMinorUnits: 2,
    payDay: 31,
    roundingMode: "nearest",
  }, existingSettings).employeeCompensationVisibility, "history");
  assert.equal(normalizeSettings({
    currency: "inr",
    currencyMinorUnits: 2,
    payDay: 31,
    roundingMode: "nearest",
    employeeCompensationVisibility: "history",
  }).employeeCompensationVisibility, "history");
  assert.throws(() => normalizeSettings({
    currency: "INR",
    currencyMinorUnits: 2,
    payDay: 31,
    roundingMode: "nearest",
    employeeCompensationVisibility: "everyone",
  }), /Invalid employee compensation visibility/);
}

function testSelfProfileExcludesFutureAndCancelledAssignments() {
  const current = validAssignment().toObject();
  const previous = { ...current, _id: objectId(), effectiveFrom: new Date("2025-04-01T00:00:00.000Z") };
  const future = { ...current, _id: objectId(), effectiveFrom: new Date("2026-10-01T00:00:00.000Z") };
  const cancelled = { ...current, _id: objectId(), effectiveFrom: new Date("2026-02-01T00:00:00.000Z"), status: "cancelled" };
  const profile = buildEmployeeCompensationProfile(
    [previous, current, future, cancelled],
    "history",
    "2026-09-29"
  );
  assert.equal(profile.currentAssignment?.effectiveFrom, "2026-04-01");
  assert.equal(profile.currentAssignment?.effectiveTo, null);
  assert.deepEqual(profile.history.map((item) => item.effectiveFrom), ["2025-04-01"]);

  const currentOnly = buildEmployeeCompensationProfile([previous, current], "current", "2026-09-29");
  assert.equal(currentOnly.history.length, 0);
  assert.equal(buildEmployeeCompensationProfile([current], "hidden", "2026-09-29").currentAssignment, null);
}

testValidSnapshotAndIndex();
testInvalidSnapshot();
testDerivedEffectiveRanges();
testPermissions();
testEmployeeSafeSerialization();
testCompensationVisibilitySettings();
testSelfProfileExcludesFutureAndCancelledAssignments();

console.log("Employee compensation schema, history, and permission tests passed");
