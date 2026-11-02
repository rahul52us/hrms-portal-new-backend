import mongoose from "mongoose";
import { createHash } from "crypto";
import Timesheet from "../../schemas/Timesheet/Timesheet.schema";
import Submission from "../../schemas/Timesheet/TimesheetSubmission.schema";
import Revision from "../../schemas/Timesheet/TimesheetRevision.schema";
import Project from "../../schemas/project/Project.schema";
import WorkType from "../../schemas/project/ProjectWorkType.schema";
import Assignment from "../../schemas/project/ProjectAssignment.schema";
import User from "../../schemas/User/User";
import { ownContext } from "./timesheet.service";
import { generateError } from "../../config/Error/functions";
import { dateKey, objectId, shortText } from "../project/project.utils";
import { timesheetPagination } from "./timesheetRules.utils";
import { historicalProjectStates, resolveTimesheetDay, timesheetContextSnapshot, timesheetWorkFingerprint } from "./timesheetContext.service";
import { validateTimesheetEntries } from "./timesheet.utils";
import { approveApprovalInstance, cancelApprovalInstance, createApprovalInstance, createReportingManagerTimesheetApproval, rejectApprovalInstance } from "../approval/approvalEngine.service";
import { resolveEffectiveApprovalWorkflowReference } from "../approval/approvalWorkflow.service";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { createRequestNotifications } from "../notification/notification.service";
import History from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import { timesheetOrganizationAllowed } from "./timesheetOperationsAccess.service";
import { fenceTimesheetDay } from "./timesheetDayControl.utils";
import { loadReassignmentState } from "./timesheetReassignmentAccess.service";

type Action = "submit" | "approve" | "return" | "reject" | "withdraw" | "reopen";
const editable = ["draft", "returned", "rejected"];
const isAdmin = (actor: any) => ["admin", "hradmin"].includes(actor.role);
const id = (value: any) => String(value?._id || value || "");
const event = (actor: any, action: string, comment = "") => ({ action, actor: actor._id, actorNameSnapshot: actor.name || actor.username || "Employee", comment, at: new Date() });
async function validatedWork(sheet: any, day: any, session: mongoose.ClientSession) {
  const entries = sheet.entries.map((e: any) => ({ entryId: e.entryId, projectId: id(e.project), workTypeId: id(e.workType), startDate: e.startDate, startTime: e.startTime, endDate: e.endDate, endTime: e.endTime, notes: e.notes }));
  const ids = entries.map((e: any) => objectId(e.projectId, "project id")), types = entries.map((e: any) => objectId(e.workTypeId, "work type id"));
  const [projects, workTypes, assignments] = await Promise.all([
    Project.find({ company: sheet.company, _id: { $in: ids } }).session(session).lean(),
    WorkType.find({ company: sheet.company, _id: { $in: types } }).session(session).lean(),
    Assignment.find({ company: sheet.company, employee: sheet.employee, project: { $in: ids }, status: "assigned", effectiveFrom: { $lte: sheet.attendanceDate }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: sheet.attendanceDate } }] }).session(session).lean(),
  ]);
  const states = await historicalProjectStates(sheet.company, [...projects, ...workTypes], sheet.attendanceDate, day.context.timezone, session);
  return validateTimesheetEntries({ input: entries, existingEntries: sheet.entries, rules: day.rules, context: day.context, requirement: day.requirement, record: day.record, now: new Date(), projects: new Map(projects.map((p: any) => [id(p), states.get(id(p))])), workTypes: new Map(workTypes.map((t: any) => [id(t), states.get(id(t))])), assignments: new Map(assignments.map((a: any) => [id(a.project), a])) });
}
async function notify(submission: any, recipients: any[], action: string, actor: any, session: mongoose.ClientSession, step?: number) {
  if (!recipients.length) return;
  await createRequestNotifications({ company: submission.company, recipients, actor: actor._id, eventType: `timesheet.${action}`, entityType: "timesheet_submission", entityId: submission._id,
    title: action === "awaiting_approval" ? "Timesheet needs approval" : `Timesheet ${action.replace(/_/g, " ")}`,
    message: action === "awaiting_approval" ? `${submission.employeeNameSnapshot}'s timesheet for ${submission.attendanceDate} needs your decision.` : `Timesheet for ${submission.attendanceDate}: ${action.replace(/_/g, " ")}.`,
    actionUrl: action === "awaiting_approval" ? "/dashboard" : `/dashboard/calendar?workDate=${submission.attendanceDate}`,
    category: action === "awaiting_approval" ? "approval" : "request", metadata: { attendanceDate: submission.attendanceDate, submissionId: id(submission), requestType: "timesheet_submission" },
    dedupeEventKey: action === "awaiting_approval" ? `${action}:step:${step}` : `${action}:revision:${submission.sheetRevision}`,
  }, session);
}
function populate(query: any) { return query.populate("employee", "name code username").populate("approvalInstance"); }
function approvalTiming(submission: any) {
  return { ...submission, approvalOverdue: Boolean(submission.status === "submitted" && submission.approvalDeadlineAt && new Date() > new Date(submission.approvalDeadlineAt)) };
}
async function canRead(submission: any, actor: any) {
  if (id(submission.employee) === id(actor) || isAdmin(actor) || submission.participantIds.some((user: any) => id(user) === id(actor))) return true;
  const at = new Date(`${submission.attendanceDate}T00:00:00Z`);
  const organization = await History.findOne({ company: submission.company, employee: submission.employee?._id || submission.employee, effectiveFrom: { $lte: at }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }] }).sort({ effectiveFrom: -1 }).lean();
  return Boolean(organization && (id((organization as any).reportingManager) === id(actor) || timesheetOrganizationAllowed(actor, organization)));
}
export const listTimesheetSubmissions = async (req: any, res: any, next: any) => {
  try {
    const ctx = ownContext(req), scope = req.query.scope || "approvals", { page, limit, skip } = timesheetPagination(req.query, 50);
    if (!["mine", "approvals"].includes(scope)) throw generateError("Choose mine or approvals scope", 400);
    const match: any = { company: ctx.company, ...(scope === "mine" ? { employee: ctx.employee } : { currentApprovers: ctx.employee, status: "submitted" }) };
    if (scope === "mine" && req.query.status) { if (!["submitted", "approved", "returned", "rejected", "withdrawn", "reopened"].includes(req.query.status)) throw generateError("Invalid submission status", 400); match.status = req.query.status; }
    const [data, total] = await Promise.all([populate(Submission.find(match).select("-snapshot").sort({ submittedAt: -1, _id: -1 }).skip(skip).limit(limit)).lean(), Submission.countDocuments(match)]);
    res.json({ success: true, data: data.map(approvalTiming), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const getTimesheetSubmission = async (req: any, res: any, next: any) => {
  try {
    const ctx = ownContext(req), submission: any = await populate(Submission.findOne({ company: ctx.company, _id: objectId(req.params.submissionId, "submission id") })).lean();
    if (!submission) throw generateError("Submission not found", 404);
    if (!await canRead(submission, ctx.actor)) throw generateError("This timesheet is outside your approval scope", 403);
    const reassignment = (await loadReassignmentState(submission, ctx.actor)).capabilities;
    res.json({ success: true, data: { ...approvalTiming(submission), reassignment } });
  } catch (error) { next(error); }
};

export const actOnTimesheet = (action: Action) => async (req: any, res: any, next: any) => {
  let session: mongoose.ClientSession | undefined;
  try {
    const ctx = ownContext(req);
    await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: id(ctx.company), actionLabel: "update timesheets" });
    const requestId = shortText(req.body.requestId, "Request id", 8, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId) || !Number.isSafeInteger(req.body.revision) || req.body.revision < 1) throw generateError("A valid requestId and latest timesheet revision are required", 400);
    const comment = shortText(req.body.comment || "", "Decision reason", ["return", "reject", "reopen"].includes(action) ? 3 : 0, 500);
    const target = action === "submit" ? dateKey(req.params.date, "Attendance date")! : id(objectId(req.params.submissionId, "submission id"));
    const hash = createHash("sha256").update(JSON.stringify({ action, target, revision: req.body.revision, comment, acknowledgeShortfall: req.body.acknowledgeShortfall === true })).digest("hex");
    let result: any;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      let submission: any = action === "submit" ? null : await Submission.findOne({ _id: target, company: ctx.company }).session(session!);
      if (action !== "submit" && !submission) throw generateError("Submission not found", 404);
      if (submission && !await canRead(submission, ctx.actor)) throw generateError("This timesheet is outside your approval scope", 403);
      const match = { company: ctx.company, employee: submission?.employee || ctx.employee, attendanceDate: submission?.attendanceDate || target };
      const prior: any = await Revision.findOne({ ...match, requestId }).session(session!).lean();
      if (prior) {
        if (prior.requestHash !== hash || id(prior.actor) !== id(ctx.actor)) throw generateError("Request id was already used for another action", 409);
        result = { data: prior.snapshot, replayed: true }; return;
      }
      const control = await fenceTimesheetDay(match, session!);
      const sheet: any = await Timesheet.findOne(match).session(session!).lean();
      if (!sheet || sheet.revision !== req.body.revision) throw generateError("Timesheet changed. Reload before taking action.", 409);
      if (sheet.payrollLockedAt) throw generateError("Payroll-locked timesheets cannot be changed", 409);
      const oldApprovers = (submission?.currentApprovers || []).map(id);
      let changes: any = {}, notice = action === "submit" ? "submitted" : action;
      if (action === "submit") {
        if (!editable.includes(sheet.status) || !sheet.entries.length) throw generateError("Save an editable timesheet with work entries before submitting", 409);
        const day = await resolveTimesheetDay(ctx.company, ctx.employee, match.attendanceDate, new Date(), undefined, false, control);
        const issues = [...day.eligibility.setupIssues, ...day.eligibility.saveIssues, ...day.eligibility.submissionIssues];
        if (issues.length) throw generateError(issues[0].message, 422);
        const validated = await validatedWork(sheet, day, session!);
        const shortfall = Math.max(0, (day.requirement.requiredMinutes || 0) - validated.loggedMinutes);
        if (shortfall && req.body.acknowledgeShortfall !== true) throw generateError("Confirm the short hours before submitting this day", 422);
        const employee: any = await User.findOne({ _id: ctx.employee, company: ctx.company, is_enabled: { $ne: false }, deletedAt: null }).session(session!).lean();
        if (!employee) throw generateError("Employee is not active", 422);
        const submissionId = new mongoose.Types.ObjectId(), options = { company: ctx.company, requestId: submissionId, employee, actorId: ctx.actor._id, session: session! };
        const workflowId = day.rules.approvalWorkflowId;
        const routing = workflowId ? await resolveEffectiveApprovalWorkflowReference({ company: ctx.company, workflowId, requestType: "timesheet_submission", setupLabel: "timesheets" }) : null;
        const approval = routing ? await createApprovalInstance({ ...options, requestType: "timesheet_submission", requestModel: "TimesheetSubmission", workflowId: routing.workflow, workflowVersionId: routing.version }) : await createReportingManagerTimesheetApproval(options);
        changes = { ...validated, requiredMinutes: day.requirement.requiredMinutes, shortfallMinutes: shortfall, contextSnapshot: timesheetContextSnapshot(day), status: approval.finalApproved ? "approved" : "submitted", currentSubmission: submissionId, submissionCount: (sheet.submissionCount || 0) + 1 };
        const snapshot = { ...sheet, ...changes, revision: sheet.revision + 1 };
        [submission] = await Submission.create([{ _id: submissionId, ...match, timesheet: sheet._id, employeeNameSnapshot: employee.name || employee.username, employeeCodeSnapshot: employee.code || "", submissionNumber: changes.submissionCount, sheetRevision: snapshot.revision,
          snapshot, loggedMinutes: validated.loggedMinutes, requiredMinutes: day.requirement.requiredMinutes || 0, shortfallMinutes: shortfall,
          status: changes.status, submittedAt: new Date(), approvalDeadlineAt: day.eligibility.payrollCycle?.approvalAt || null, shortfallAcknowledged: Boolean(shortfall), approvalInstance: approval.instance._id, currentApprovers: approval.currentApprovers,
          participantIds: [...new Set(approval.instance.steps.flatMap((step: any) => step.approvers.map((a: any) => id(a.user))))], history: [event(ctx.actor, "submitted"), ...(approval.finalApproved ? [event(ctx.actor, "auto_approved")] : [])] }], { session });
        if (approval.currentApprovers.length) await notify(submission, approval.currentApprovers, "awaiting_approval", ctx.actor, session!, approval.instance.currentStepOrder!);
        if (approval.finalApproved) notice = "approved";
      } else {
        if (id(sheet.currentSubmission) !== id(submission)) throw generateError("This submission has been superseded", 409);
        const own = id(submission.employee) === id(ctx.actor);
        if (action === "withdraw") {
          if (!own || submission.status !== "submitted") throw generateError("Only your pending submission can be withdrawn", 403);
          const instance: any = await mongoose.model("ApprovalInstance").findById(submission.approvalInstance).session(session!);
          if (instance.history.some((h: any) => h.action === "step_approved")) throw generateError("A decision has already been recorded; ask the approver to return it", 409);
          await cancelApprovalInstance({ company: ctx.company, requestModel: "TimesheetSubmission", requestId: submission._id, actor: ctx.actor, comment, session: session! });
          submission.status = "withdrawn"; changes.status = "draft"; notice = "withdrawn";
        } else if (action === "reopen") {
          if (!isAdmin(ctx.actor) || submission.status !== "approved") throw generateError("Only Company Admin / HR Admin can reopen an approved timesheet", 403);
          await cancelApprovalInstance({ company: ctx.company, requestModel: "TimesheetSubmission", requestId: submission._id, actor: ctx.actor, comment, session: session! });
          submission.status = "reopened"; changes.status = "draft"; notice = "reopened";
        } else {
          if (own || submission.status !== "submitted" || !oldApprovers.includes(id(ctx.actor))) throw generateError("This timesheet is not awaiting your decision", 403);
          if (action === "approve") {
            const day = await resolveTimesheetDay(ctx.company, submission.employee, submission.attendanceDate, new Date(), undefined, false, control);
            if (day.eligibility.setupIssues.length || day.requirement.requiredMinutes !== submission.requiredMinutes || timesheetWorkFingerprint(timesheetContextSnapshot(day)) !== timesheetWorkFingerprint(submission.snapshot.contextSnapshot)) throw generateError("Attendance, leave or policy changed after submission. Return this day for correction.", 409);
            await validatedWork(sheet, day, session!);
            const approval = await approveApprovalInstance({ company: ctx.company, requestModel: "TimesheetSubmission", requestId: submission._id, actor: ctx.actor, comment, session: session! });
            submission.currentApprovers = approval.currentApprovers;
            submission.status = approval.finalApproved ? "approved" : "submitted"; changes.status = submission.status;
            const newApprovers = approval.currentApprovers.filter((user: any) => !oldApprovers.includes(id(user)));
            await notify(submission, newApprovers, "awaiting_approval", ctx.actor, session!, approval.instance.currentStepOrder!);
            notice = approval.finalApproved ? "approved" : "step_approved";
          } else {
            if (action === "reject") await rejectApprovalInstance({ company: ctx.company, requestModel: "TimesheetSubmission", requestId: submission._id, actor: ctx.actor, comment, session: session! });
            else await cancelApprovalInstance({ company: ctx.company, requestModel: "TimesheetSubmission", requestId: submission._id, actor: ctx.actor, comment, session: session! });
            submission.status = action === "return" ? "returned" : "rejected"; changes.status = submission.status; notice = submission.status;
          }
        }
        if (submission.status !== "submitted") submission.currentApprovers = [];
        submission.sheetRevision = sheet.revision + 1; submission.history.push(event(ctx.actor, action, comment)); await submission.save({ session });
      }
      const saved: any = await Timesheet.findOneAndUpdate({ ...match, revision: sheet.revision, payrollLockedAt: null }, { $set: { ...changes, updatedBy: ctx.actor._id }, $inc: { revision: 1 } }, { new: true, session, runValidators: true }).lean();
      if (!saved) throw generateError("Timesheet changed. Reload before taking action.", 409);
      await Revision.create([{ ...match, timesheet: sheet._id, revision: saved.revision, requestId, requestHash: hash, actor: ctx.actor._id, action, snapshot: saved }], { session });
      if (notice !== "step_approved") await notify(submission, [submission.employee], notice, ctx.actor, session!);
      if (["withdraw", "reopen"].includes(action)) await notify(submission, oldApprovers, notice, ctx.actor, session!);
      result = { data: saved, replayed: false, submissionId: id(submission), message: `Timesheet ${notice.replace(/_/g, " ")}` };
    });
    res.json({ success: true, ...result });
  } catch (error: any) { next(error?.code === 11000 || error?.name === "VersionError" ? generateError("Timesheet changed. Reload before trying again.", 409) : error); }
  finally { await session?.endSession(); }
};
