import assert from "assert";
import {
  approveCurrentApprovalStep,
  rejectCurrentApprovalStep,
} from "./approvalDecision.utils";

function instance(rule: "any" | "all" = "any") {
  return {
    employee: "employee-1",
    status: "pending",
    currentStepOrder: 1,
    completedAt: null,
    history: [],
    steps: [
      {
        order: 1,
        status: "pending",
        approvalRule: rule,
        approvers: [
          { user: "manager-1", status: "pending" },
          { user: "manager-2", status: "pending" },
        ],
      },
      {
        order: 2,
        status: "waiting",
        approvalRule: "any",
        approvers: [{ user: "hr-1", status: "waiting" }],
      },
    ],
  };
}

const now = new Date("2026-08-27T10:00:00.000Z");

const anyFlow = instance("any");
approveCurrentApprovalStep(anyFlow, { _id: "manager-1", name: "Manager One" }, "Looks good", now);
assert.equal(anyFlow.steps[0].status, "approved");
assert.equal(anyFlow.steps[0].approvers[1].status, "skipped");
assert.equal(anyFlow.currentStepOrder, 2);
assert.equal(anyFlow.steps[1].approvers[0].status, "pending");

rejectCurrentApprovalStep(anyFlow, { _id: "hr-1", name: "HR One" }, "Insufficient evidence", now);
assert.equal(anyFlow.status, "rejected");
assert.equal(anyFlow.currentStepOrder, null);
assert.equal(anyFlow.steps[1].status, "rejected");

const allFlow = instance("all");
approveCurrentApprovalStep(allFlow, { _id: "manager-1" }, "First approval", now);
assert.equal(allFlow.status, "pending");
assert.equal(allFlow.currentStepOrder, 1);
assert.equal(allFlow.steps[0].status, "pending");
approveCurrentApprovalStep(allFlow, { _id: "manager-2" }, "Second approval", now);
assert.equal(allFlow.currentStepOrder, 2);

assert.throws(
  () => approveCurrentApprovalStep(instance(), { _id: "outsider" }, "", now),
  /not awaiting your approval/i
);
assert.throws(
  () => approveCurrentApprovalStep(instance(), { _id: "employee-1" }, "", now),
  /cannot approve your own request/i
);

console.log("Approval decision tests passed (13 assertions)");
