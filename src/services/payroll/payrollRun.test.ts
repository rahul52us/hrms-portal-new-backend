import assert from "node:assert/strict";
import mongoose from "mongoose";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import { getDefaultPermissionsForRole, PERMISSION_KEYS } from "../permissions/permission.utils";
import { buildPayrollRunDocument } from "./payrollRun.service";

const objectId = () => new mongoose.Types.ObjectId();

function validRunDocument() {
  const companyId = objectId();
  const actorId = objectId();
  const inputId = objectId();
  const data = buildPayrollRunDocument({
    company: {
      _id: companyId,
      company_name: "Acme Private Limited",
      companyCode: "ACME",
      payrollSettings: {
        currency: "INR",
        currencyMinorUnits: 2,
        payDay: 31,
        roundingMode: "nearest",
      },
    },
    input: {
      _id: inputId,
      company: companyId,
      attendancePeriod: objectId(),
      periodKey: "2026-09",
      cycleStartDate: "2026-08-26",
      cycleEndDate: "2026-09-25",
      attendanceCutoffDay: 25,
      version: 1,
      attendancePeriodVersion: 3,
      summaryCount: 10,
      adjustmentCount: 1,
      totals: { payroll: { paidDays: 280, unpaidDays: 4, approvedOvertimeMinutes: 120 } },
      lockedAt: new Date("2026-09-26T00:00:00.000Z"),
      lockedBy: actorId,
    },
    actorId,
    reason: "Prepare September payroll",
  });
  return { document: new PayrollRun(data), data, companyId, inputId };
}

function testSchemaAndSnapshots() {
  const { document, data, companyId, inputId } = validRunDocument();
  assert.equal(document.validateSync(), undefined);
  assert.equal(String(data.company), String(companyId));
  assert.equal(String(data.attendancePayrollInput), String(inputId));
  assert.equal(data.periodKey, "2026-09");
  assert.equal(data.attendancePeriodVersion, 3);
  assert.equal(data.attendanceSummaryCount, 10);
  assert.equal(data.currency, "INR");
  assert.equal(data.status, "draft");
  assert.equal(data.attendanceInputStatus, "pending");
  assert.equal(data.employeeInputCount, 0);
  assert.equal(data.oneTimeInputCount, 0);
  assert.equal(data.oneTimeInputTotals.netImpactMinor, 0);
  assert.equal(data.employeeSnapshotStatus, "pending");
  assert.equal(data.employeeSnapshotVersion, 0);
  assert.equal(data.employeeSnapshotCount, 0);
  assert.equal(data.calculationStatus, "pending");
  assert.equal(data.calculationVersion, 0);
  assert.equal(data.payrollResultCount, 0);
}

function testRequiredFieldsAndIndexes() {
  const { document } = validRunDocument();
  document.preparationReason = "x";
  assert.ok(document.validateSync()?.errors.preparationReason);
  const uniquePeriod = PayrollRun.schema.indexes().find(([fields, options]) =>
    fields.company === 1 && fields.periodKey === 1 && options.unique
  );
  assert.ok(uniquePeriod, "one payroll run per company period is required");
  assert.equal(PayrollRun.schema.path("attendancePayrollInput").options.unique, true);
}

function testPermissions() {
  assert.equal(getDefaultPermissionsForRole("admin")[PERMISSION_KEYS.MANAGE_PAYROLL_RUNS], true);
  assert.equal(getDefaultPermissionsForRole("hradmin")[PERMISSION_KEYS.MANAGE_PAYROLL_RUNS], true);
  assert.equal(getDefaultPermissionsForRole("hr")[PERMISSION_KEYS.MANAGE_PAYROLL_RUNS], false);
}

testSchemaAndSnapshots();
testRequiredFieldsAndIndexes();
testPermissions();

console.log("Payroll run schema, snapshots, indexes, and permission tests passed");
