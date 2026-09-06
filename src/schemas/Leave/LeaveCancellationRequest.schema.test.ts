import assert from "node:assert/strict";
import mongoose from "mongoose";
import ApprovalInstance from "../Approval/ApprovalInstance.schema";
import LeaveCancellationRequest from "./LeaveCancellationRequest.schema";

function cancellation(reason = "Approved leave is no longer required") {
  return new LeaveCancellationRequest({
    company: new mongoose.Types.ObjectId(),
    leaveRequest: new mongoose.Types.ObjectId(),
    employee: new mongoose.Types.ObjectId(),
    reason,
    status: "submitted",
    currentApprovers: [new mongoose.Types.ObjectId()],
    history: [
      {
        action: "submitted",
        actor: new mongoose.Types.ObjectId(),
        actorRole: "user",
        comment: reason,
        at: new Date(),
      },
    ],
    createdBy: new mongoose.Types.ObjectId(),
  });
}

function testValidCancellationRequest() {
  assert.equal(cancellation().validateSync(), undefined);
}

function testCancellationReasonIsRequired() {
  const validation = cancellation("x").validateSync();
  assert.ok(validation?.errors.reason);
}

function testApprovalInstanceAcceptsCancellationModel() {
  const instance = new ApprovalInstance({
    company: new mongoose.Types.ObjectId(),
    requestType: "leave_request",
    requestModel: "LeaveCancellationRequest",
    request: new mongoose.Types.ObjectId(),
    employee: new mongoose.Types.ObjectId(),
    workflow: new mongoose.Types.ObjectId(),
    workflowVersion: new mongoose.Types.ObjectId(),
    workflowVersionNumber: 1,
    workflowNameSnapshot: "Manager approval",
    status: "pending",
  });
  assert.equal(instance.validateSync(), undefined);
}

testValidCancellationRequest();
testCancellationReasonIsRequired();
testApprovalInstanceAcceptsCancellationModel();

console.log("Leave cancellation request schema tests passed");
