import assert from "node:assert/strict";
import mongoose from "mongoose";
import ApprovalInstance from "../Approval/ApprovalInstance.schema";
import LeaveEncashmentRequest from "./LeaveEncashmentRequest.schema";

function encashment(overrides: Record<string, unknown> = {}) {
  return new LeaveEncashmentRequest({
    company: new mongoose.Types.ObjectId(),
    employee: new mongoose.Types.ObjectId(),
    leaveType: new mongoose.Types.ObjectId(),
    leaveTypeCodeSnapshot: "PL",
    leaveTypeNameSnapshot: "Privilege Leave",
    leaveUnit: "days",
    leaveYearKey: "2026-01-01:2026-12-31",
    leaveYearStart: "2026-01-01",
    leaveYearEnd: "2026-12-31",
    requestedUnits: 2,
    maxEncashmentPerYearSnapshot: 10,
    availableBalanceSnapshot: 8,
    reason: "Annual leave encashment",
    status: "submitted",
    payoutStatus: "not_ready",
    history: [
      {
        action: "submitted",
        actor: new mongoose.Types.ObjectId(),
        actorRole: "user",
        at: new Date(),
      },
    ],
    createdBy: new mongoose.Types.ObjectId(),
    ...overrides,
  });
}

function testValidRequest() {
  assert.equal(encashment().validateSync(), undefined);
}

function testUnitsMustBePositive() {
  const validation = encashment({ requestedUnits: 0 }).validateSync();
  assert.ok(validation?.errors.requestedUnits);
}

function testPayoutCurrency() {
  const validation = encashment({ payoutCurrency: "RUPEES" }).validateSync();
  assert.ok(validation?.errors.payoutCurrency);
}

function testApprovalInstanceAcceptsEncashmentModel() {
  const instance = new ApprovalInstance({
    company: new mongoose.Types.ObjectId(),
    requestType: "leave_encashment_request",
    requestModel: "LeaveEncashmentRequest",
    request: new mongoose.Types.ObjectId(),
    employee: new mongoose.Types.ObjectId(),
    workflow: new mongoose.Types.ObjectId(),
    workflowVersion: new mongoose.Types.ObjectId(),
    workflowVersionNumber: 1,
    workflowNameSnapshot: "Encashment approval",
    status: "pending",
  });
  assert.equal(instance.validateSync(), undefined);
}

testValidRequest();
testUnitsMustBePositive();
testPayoutCurrency();
testApprovalInstanceAcceptsEncashmentModel();

console.log("Leave encashment request schema tests passed");
