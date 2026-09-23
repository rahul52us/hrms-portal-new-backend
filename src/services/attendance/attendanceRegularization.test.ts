import assert from "node:assert/strict";
import mongoose from "mongoose";
import ApprovalInstance from "../../schemas/Approval/ApprovalInstance.schema";
import ApprovalWorkflow from "../../schemas/Approval/ApprovalWorkflow.schema";
import AttendanceRegularizationRequest from "../../schemas/Attendance/AttendanceRegularizationRequest.schema";
import { localAttendanceTimeToUtc } from "./attendanceRegularization.service";

const id = () => new mongoose.Types.ObjectId();

async function run() {
  const company = id();
  const employee = id();
  const request = new AttendanceRegularizationRequest({
    company,
    employee,
    attendanceDate: "2026-09-20",
    correctionType: "missing_punch_out",
    reason: "The browser was closed before the final punch-out.",
    originalRevisionNumber: 2,
    originalSnapshot: { revisionNumber: 2 },
    requestedChanges: { punchOut: new Date("2026-09-20T13:30:00.000Z") },
    attendancePolicyAssignment: id(),
    attendancePolicy: id(),
    attendancePolicyVersion: id(),
    attendancePolicyVersionNumber: 3,
    history: [{ action: "submitted", actor: employee, actorRole: "employee", at: new Date() }],
    createdBy: employee,
  });
  assert.equal(request.validateSync(), undefined);

  request.correctionType = "unknown" as any;
  assert.match(request.validateSync()?.message || "", /correctionType/i);

  const overnight = localAttendanceTimeToUtc("2026-09-20", "02:15", "Asia/Kolkata", true);
  assert.equal(overnight.toISOString(), "2026-09-20T20:45:00.000Z");
  const punchIn = localAttendanceTimeToUtc("2026-09-20", "19:00", "Asia/Kolkata");
  assert.equal(punchIn.toISOString(), "2026-09-20T13:30:00.000Z");

  const workflow = new ApprovalWorkflow({
    company,
    name: "Attendance approval",
    code: "ATT-REG",
    applicableTo: ["attendance_regularization_request"],
    createdBy: employee,
  });
  assert.equal(workflow.validateSync(), undefined);

  const instance = new ApprovalInstance({
    company,
    requestType: "attendance_regularization_request",
    requestModel: "AttendanceRegularizationRequest",
    request: id(),
    employee,
    workflow: id(),
    workflowVersion: id(),
    workflowVersionNumber: 1,
    workflowNameSnapshot: "Attendance approval",
  });
  assert.equal(instance.validateSync(), undefined);

  console.log("Attendance regularization tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
