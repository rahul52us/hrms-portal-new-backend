import assert from "node:assert/strict";
import mongoose from "mongoose";
import PayrollEmployeeInput from "../../schemas/Payroll/PayrollEmployeeInput.schema";
import {
  buildPayrollEmployeeInputs,
  validatePayrollEmployeeInputReconciliation,
} from "./payrollEmployeeInput.service";

const objectId = () => new mongoose.Types.ObjectId();

function fixture() {
  const company = objectId();
  const employee = objectId();
  const priorEmployee = objectId();
  const payrollRun = objectId();
  const attendancePayrollInput = objectId();
  const actorId = objectId();
  const summaries = [{
    _id: objectId(),
    employee,
    employeeNameSnapshot: "Asha Sharma",
    employeeCodeSnapshot: "ACME-101",
    designationSnapshot: "Engineer",
    department: objectId(),
    departmentNameSnapshot: "Engineering",
    teamNameSnapshot: "Platform",
    officeLocationNameSnapshot: "Delhi",
    calendarDays: 30,
    expectedDays: 22,
    paidDays: 20,
    unpaidDays: 2,
    presentDays: 18,
    halfDays: 0,
    absentDays: 2,
    paidLeaveDays: 2,
    unpaidLeaveDays: 0,
    holidayDays: 2,
    weeklyOffDays: 6,
    wfhDays: 1,
    incompleteDays: 0,
    pendingDays: 0,
    workedMinutes: 9_600,
    rawOvertimeMinutes: 100,
    approvedOvertimeMinutes: 60,
    lateMinutes: 15,
    earlyExitMinutes: 5,
    lateDays: 1,
    earlyExitDays: 1,
    missingPunchDays: 0,
    overtimeDays: 2,
    regularizationDays: 0,
    exceptionCount: 4,
    sourceRecordCount: 30,
  }];
  const adjustments = [
    {
      _id: objectId(),
      employee,
      employeeNameSnapshot: "Asha Sharma",
      employeeCodeSnapshot: "ACME-101",
      sourcePeriodKey: "2026-08",
      deltas: { paidDays: 1, unpaidDays: -1, approvedOvertimeMinutes: 30 },
    },
    {
      _id: objectId(),
      employee: priorEmployee,
      employeeNameSnapshot: "Former Employee",
      employeeCodeSnapshot: "ACME-099",
      sourcePeriodKey: "2026-07",
      deltas: { paidDays: 1, unpaidDays: -1 },
    },
  ];
  const run = {
    _id: payrollRun,
    company,
    periodKey: "2026-09",
    attendancePayrollInput,
    attendancePeriodVersion: 3,
    attendanceSummaryCount: 1,
    attendanceAdjustmentCount: 2,
    attendanceTotals: {
      payroll: {
        paidDays: 22,
        unpaidDays: 0,
        workedMinutes: 9_600,
        approvedOvertimeMinutes: 90,
        lateMinutes: 15,
        earlyExitMinutes: 5,
        absentDays: 2,
        exceptionCount: 4,
      },
    },
  };
  return { run, summaries, adjustments, actorId, employee, priorEmployee };
}

function testBuildAndReconciliation() {
  const source = fixture();
  const built = buildPayrollEmployeeInputs(source);
  assert.equal(built.documents.length, 2);
  assert.equal(built.issueCount, 1);

  const employee = built.documents.find((item) => String(item.employee) === String(source.employee));
  assert.ok(employee);
  assert.equal(employee.currentAttendance.paidDays, 20);
  assert.equal(employee.attendanceAdjustments.paidDays, 1);
  assert.equal(employee.attendanceAdjustments.unpaidDays, -1);
  assert.equal(employee.payrollAttendance.paidDays, 21);
  assert.equal(employee.payrollAttendance.unpaidDays, 1);
  assert.equal(employee.payrollAttendance.approvedOvertimeMinutes, 90);
  assert.deepEqual(employee.inputIssues, []);

  const adjustmentOnly = built.documents.find((item) => String(item.employee) === String(source.priorEmployee));
  assert.ok(adjustmentOnly);
  assert.deepEqual(adjustmentOnly.inputIssues, ["missing_monthly_summary", "negative_unpaid_days"]);
  assert.equal(adjustmentOnly.payrollAttendance.paidDays, 1);
  assert.equal(built.totals.paidDays, 22);
  assert.equal(built.totals.unpaidDays, 0);

  assert.doesNotThrow(() => validatePayrollEmployeeInputReconciliation({
    run: source.run,
    summaries: source.summaries,
    adjustments: source.adjustments,
    totals: built.totals,
  }));
  assert.throws(() => validatePayrollEmployeeInputReconciliation({
    run: source.run,
    summaries: source.summaries,
    adjustments: source.adjustments,
    totals: { ...built.totals, paidDays: 999 },
  }), /do not reconcile/);
}

function testSchemaAndIndexes() {
  const source = fixture();
  const built = buildPayrollEmployeeInputs(source);
  for (const input of built.documents) {
    assert.equal(new PayrollEmployeeInput(input).validateSync(), undefined);
  }
  const uniqueEmployee = PayrollEmployeeInput.schema.indexes().find(([fields, options]) =>
    fields.company === 1 && fields.payrollRun === 1 && fields.employee === 1 && options.unique
  );
  assert.ok(uniqueEmployee, "one attendance input per employee and payroll run is required");
}

testBuildAndReconciliation();
testSchemaAndIndexes();

console.log("Payroll employee attendance input snapshots and reconciliation tests passed");
