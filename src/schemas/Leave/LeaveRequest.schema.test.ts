import assert from "node:assert/strict";
import mongoose from "mongoose";
import LeaveRequest from "./LeaveRequest.schema";

function request(documentRequirementSnapshot: Record<string, unknown>, documentStatus: string) {
  return new LeaveRequest({
    company: new mongoose.Types.ObjectId(),
    employee: new mongoose.Types.ObjectId(),
    leaveType: new mongoose.Types.ObjectId(),
    leaveTypeCodeSnapshot: "CL",
    leaveTypeNameSnapshot: "Casual Leave",
    leaveUnit: "days",
    paid: true,
    balanceTracked: true,
    entitlementModeSnapshot: "fixed",
    fromDate: "2026-09-03",
    toDate: "2026-09-03",
    requestedUnits: 1,
    chargedUnits: 1,
    dayBreakdown: [
      {
        attendanceDate: "2026-09-03",
        dayType: "working_day",
        portion: "full",
        requestedUnits: 1,
        chargedUnits: 1,
        chargeReason: "working_day",
        leaveYearKey: "2026",
        leaveYearStart: "2026-01-01",
        leaveYearEnd: "2026-12-31",
      },
    ],
    reason: "Schema validation test",
    documentRequirementSnapshot,
    documentStatus,
    createdBy: new mongoose.Types.ObjectId(),
  });
}

function testNonRequiredDocumentSnapshot() {
  const leaveRequest = request(
    {
      required: false,
      thresholdUnits: 2,
      submissionMode: null,
      dueDaysAfterLeaveEnd: null,
      dueDate: null,
    },
    "not_required"
  );

  assert.equal(leaveRequest.validateSync(), undefined);
  assert.equal(leaveRequest.documentRequirementSnapshot.submissionMode, null);
}

function testRequiredDocumentSnapshot() {
  const leaveRequest = request(
    {
      required: true,
      thresholdUnits: 2,
      submissionMode: "allow_later",
      dueDaysAfterLeaveEnd: 2,
      dueDate: "2026-09-05",
    },
    "pending"
  );

  assert.equal(leaveRequest.validateSync(), undefined);
}

function testInvalidDocumentSubmissionMode() {
  const leaveRequest = request(
    {
      required: true,
      thresholdUnits: 2,
      submissionMode: "eventually",
    },
    "pending"
  );
  const validation = leaveRequest.validateSync();

  assert.ok(validation?.errors["documentRequirementSnapshot.submissionMode"]);
}

testNonRequiredDocumentSnapshot();
testRequiredDocumentSnapshot();
testInvalidDocumentSubmissionMode();

console.log("LeaveRequest schema tests passed");
