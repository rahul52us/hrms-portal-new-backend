import assert from "node:assert/strict";
import mongoose from "mongoose";
import ApprovalInstance from "../../schemas/Approval/ApprovalInstance.schema";
import { reassignCurrentApprovalStep } from "../approval/approvalReassignment.utils";
import { approveCurrentApprovalStep } from "../approval/approvalDecision.utils";
import { reassignmentAuthority, reassignmentCandidateAllowed } from "./timesheetReassignmentAccess.service";
import { reassignmentRequest } from "./timesheetReassignment.service";
import { getDefaultPermissionsForRole, PERMISSION_KEYS, validateUserPermissionOverrides } from "../permissions/permission.utils";

const id = () => new mongoose.Types.ObjectId(), company = id(), employee = id(), hrId = id(), a = id(), b = id(), c = id(), d = id();
const actor = { _id: hrId, company, role: "hradmin", name: "HR Admin" }, replacement = { _id: c, company, role: "user", name: "Replacement", is_enabled: true };
const reviewer = (user: any, status = "pending") => ({ user, nameSnapshot: String(user), roleSnapshot: "user", status, actedAt: status === "approved" ? new Date("2026-10-30") : null });
const workflow = (rule = "all") => ({ company, employee, status: "pending", currentStepOrder: 1, steps: [
  { order: 1, nameSnapshot: "Review", status: "pending", approvalRule: rule, approverType: "specific_users", approvers: [reviewer(a), reviewer(b)] },
  { order: 2, nameSnapshot: "Final review", status: "waiting", approvalRule: "any", approverType: "specific_users", approvers: [reviewer(d, "waiting")] },
], history: [] as any[] });
const options = { actor, replacement, fromUserId: String(b), stepOrder: 1, reason: "Reviewer is unavailable" };
const all = workflow(); all.steps[0].approvers[0] = reviewer(a, "approved"); const completed = JSON.stringify(all.steps[0].approvers[0]);
const evidence = reassignCurrentApprovalStep(all, options);
assert.equal(all.status, "pending"); assert.equal(all.currentStepOrder, 1); assert.equal(all.steps[0].approvalRule, "all");
assert.equal(JSON.stringify(all.steps[0].approvers[0]), completed, "Existing decisions stay intact");
assert.equal(all.steps[0].approvers[1].status, "skipped"); assert.deepEqual(evidence.pendingAfter, [String(c)]); assert.equal(all.steps[1].status, "waiting");
approveCurrentApprovalStep(all, replacement); assert.equal(all.currentStepOrder, 2); assert.equal(all.status, "pending");
approveCurrentApprovalStep(all, { _id: d }); assert.equal(all.status, "approved");
const any = workflow("any"); reassignCurrentApprovalStep(any, options); approveCurrentApprovalStep(any, { _id: a });
assert.equal(any.currentStepOrder, 2); assert.equal(any.steps[0].approvers.find((p: any) => String(p.user) === String(c))!.status, "skipped");
assert.throws(() => reassignCurrentApprovalStep(workflow(), { ...options, replacement: { ...replacement, _id: d } }), /already/);
assert.throws(() => reassignCurrentApprovalStep(workflow(), { ...options, replacement: { ...replacement, _id: employee } }), /yourself|employee/);
assert.throws(() => reassignCurrentApprovalStep(workflow(), { ...options, replacement: { ...replacement, _id: hrId } }), /yourself/);
assert.throws(() => reassignCurrentApprovalStep(workflow(), { ...options, stepOrder: 2 }), /level/);
assert.throws(() => reassignCurrentApprovalStep(all, options), /level/);
const done = workflow(); done.steps[0].approvers[1].status = "approved";
assert.throws(() => reassignCurrentApprovalStep(done, options), /no longer pending/);
const body = { revision: 2, requestId: "reassign-test-request", stepOrder: 1, fromUserId: String(b), toUserId: String(c), reason: "Manager on leave" };
assert.equal(reassignmentRequest(body).toUserId, String(c));
for (const input of [null, undefined, [], "invalid", 1]) assert.throws(() => reassignmentRequest(input), /JSON object/);
for (const invalid of [{ revision: 0 }, { stepOrder: 11 }, { reason: "x" }, { toUserId: String(b) }, { toUserId: "wrong" }, { other: true }]) assert.throws(() => reassignmentRequest({ ...body, ...invalid }));
const submission = { employee, company }, organization = { _id: id(), departmentNameSnapshot: "Engineering", teamNameSnapshot: "Platform", officeLocation: "delhi" };
const hr = { ...actor, role: "hr", hrScope: { departments: ["Engineering"], teams: ["Platform"], officeLocations: ["delhi"] }, permissions: { reassign_timesheet_approvals: true } };
assert.equal(reassignmentAuthority(hr, submission, organization).authorized, true);
assert.equal(reassignmentAuthority(hr, submission, { ...organization, officeLocation: "outside" }).authorized, false);
assert.equal(reassignmentAuthority(hr, submission, null).authorized, false);
assert.ok(reassignmentAuthority({ ...actor, _id: employee }, submission, organization).blockedReason);
assert.equal(reassignmentCandidateAllowed(replacement, actor, submission, workflow(), organization), true);
for (const person of [{ ...replacement, is_enabled: false }, { ...replacement, company: id() }, { ...replacement, _id: employee }, { ...replacement, _id: a }, { ...replacement, role: "hr", hrScope: { departments: ["Sales"] } }]) assert.equal(reassignmentCandidateAllowed(person, actor, submission, workflow(), organization), false);
assert.equal(reassignmentCandidateAllowed({ ...replacement, role: "HR Executive", hrScope: { departments: ["Sales"] } }, actor, submission, workflow(), organization), false);
assert.equal(getDefaultPermissionsForRole("hr")[PERMISSION_KEYS.REASSIGN_TIMESHEET_APPROVALS], false);
assert.equal(getDefaultPermissionsForRole("hradmin")[PERMISSION_KEYS.REASSIGN_TIMESHEET_APPROVALS], true);
assert.equal(validateUserPermissionOverrides({ role: "hr", permissions: { reassign_timesheet_approvals: true } }).valid, true);
async function schemaCheck() {
  const instance = new ApprovalInstance({ ...workflow(), requestType: "timesheet_submission", requestModel: "TimesheetSubmission", request: id(), routingSource: "reporting_manager", workflowNameSnapshot: "Reporting manager", workflowVersionNumber: 1 });
  reassignCurrentApprovalStep(instance, options); await instance.validate();
  assert.equal(instance.history[0].action, "approver_reassigned");
  console.log("Timesheet reassignment checks passed: any/all decisions, current-level replacement, future-level preservation, self/duplicate/scope guards, permissions and schema history");
}
schemaCheck().catch((error) => { console.error(error); process.exitCode = 1; });
