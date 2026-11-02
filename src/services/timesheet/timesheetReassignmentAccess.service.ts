import History from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import Timesheet from "../../schemas/Timesheet/Timesheet.schema";
import Control from "../../schemas/Timesheet/TimesheetDayControl.schema";
import ApprovalInstance from "../../schemas/Approval/ApprovalInstance.schema";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { calendarOrganizationAccess } from "../calendar/calendar.utils";
import { timesheetOrganizationAllowed } from "./timesheetOperationsAccess.service";
import { normalizeLeaveRole } from "../leave/leaveAccess.utils";
export const reassignmentId = (value: any) => String(value?._id || value || "");

export function reassignmentAuthority(actor: any, submission: any, organization: any) {
  if (!hasPermission(actor, PERMISSION_KEYS.REASSIGN_TIMESHEET_APPROVALS) || !hasPermission(actor, PERMISSION_KEYS.VIEW_TIMESHEETS) || actor.role === "superadmin") return { authorized: false, blockedReason: "Approval reassignment permission is required" };
  if ((["hr", "departmenthead"].includes(actor.role) && !organization?._id) || !timesheetOrganizationAllowed(actor, organization || {})) return { authorized: false, blockedReason: "Employee is outside your HR timesheet scope" };
  return { authorized: true, blockedReason: reassignmentId(submission.employee) === reassignmentId(actor) ? "Another authorized HR user must reassign your own request" : "" };
}
export function reassignmentCandidateAllowed(candidate: any, actor: any, submission: any, instance: any, organization: any) {
  const key = reassignmentId(candidate);
  const role = normalizeLeaveRole(candidate?.role);
  return Boolean(key && candidate.is_enabled !== false && !candidate.deletedAt && role !== "superadmin"
    && reassignmentId(candidate.company) === reassignmentId(submission.company)
    && ![reassignmentId(submission.employee), reassignmentId(actor)].includes(key)
    && !instance.steps.some((s: any) => s.approvers.some((a: any) => reassignmentId(a.user) === key))
    && (!["hr", "departmenthead"].includes(role) || Boolean(organization?._id && calendarOrganizationAccess({ ...candidate, role }, organization))));
}
export async function loadReassignmentState(submission: any, actor: any, session: any = null) {
  if (!hasPermission(actor, PERMISSION_KEYS.REASSIGN_TIMESHEET_APPROVALS)) return { capabilities: { authorized: false, canReassign: false, blockedReason: "Approval reassignment permission is required" }, instance: null, sheet: null, control: null, organization: null };
  const match = { company: submission.company, employee: submission.employee?._id || submission.employee, attendanceDate: submission.attendanceDate }, at = new Date(`${submission.attendanceDate}T00:00:00Z`);
  const [organization, sheet, control, instance]: any[] = await Promise.all([
    History.findOne({ company: match.company, employee: match.employee, effectiveFrom: { $lte: at }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }] }).sort({ effectiveFrom: -1 }).session(session).lean(),
    Timesheet.findOne(match).select("revision status currentSubmission payrollLockedAt").session(session).lean(),
    Control.findOne(match).select("payrollLockedAt").session(session).lean(),
    submission.approvalInstance?.steps ? submission.approvalInstance : ApprovalInstance.findOne({ _id: submission.approvalInstance, company: match.company, requestModel: "TimesheetSubmission", request: submission._id }).session(session),
  ]);
  const authority = reassignmentAuthority(actor, submission, organization);
  const blockedReason = authority.blockedReason || (!sheet || reassignmentId(sheet.currentSubmission) !== reassignmentId(submission) ? "This submission has been superseded"
    : sheet.payrollLockedAt || control?.payrollLockedAt ? "Payroll-locked timesheets cannot be reassigned"
    : submission.status !== "submitted" || sheet.status !== "submitted" || instance?.status !== "pending" ? "Only a pending timesheet approval can be reassigned"
    : (submission.reassignmentCount || 0) >= 50 ? "Reassignment limit reached; return this day for a new submission" : "");
  return { capabilities: { ...authority, canReassign: !blockedReason, blockedReason }, organization, sheet, control, instance };
}
