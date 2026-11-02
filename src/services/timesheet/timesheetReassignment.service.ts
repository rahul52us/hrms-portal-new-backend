import mongoose from "mongoose";
import { createHash } from "crypto";
import Submission from "../../schemas/Timesheet/TimesheetSubmission.schema";
import Timesheet from "../../schemas/Timesheet/Timesheet.schema";
import Revision from "../../schemas/Timesheet/TimesheetRevision.schema";
import User from "../../schemas/User/User";
import { generateError } from "../../config/Error/functions";
import { objectId, shortText } from "../project/project.utils";
import { ownContext } from "./timesheet.service";
import { timesheetPagination } from "./timesheetRules.utils";
import { fenceTimesheetDay } from "./timesheetDayControl.utils";
import { loadReassignmentState, reassignmentCandidateAllowed, reassignmentId as id } from "./timesheetReassignmentAccess.service";
import { reassignCurrentApprovalStep } from "../approval/approvalReassignment.utils";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { createRequestNotifications } from "../notification/notification.service";

const handler = (work: (req: any, res: any) => Promise<void>) => async (req: any, res: any, next: any) => { try { await work(req, res); } catch (error) { next(error); } };
export function reassignmentRequest(body: any) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw generateError("Provide a JSON object for approval reassignment", 400);
  if (Object.keys(body).some((key) => !["revision", "requestId", "stepOrder", "fromUserId", "toUserId", "reason"].includes(key))) throw generateError("Unexpected reassignment fields", 400);
  if (!Number.isSafeInteger(body.revision) || body.revision < 1 || !Number.isSafeInteger(body.stepOrder) || body.stepOrder < 1 || body.stepOrder > 10) throw generateError("Latest timesheet revision and current stepOrder are required", 400);
  const requestId = shortText(body.requestId, "Request id", 8, 100), reason = shortText(body.reason, "Reassignment reason", 3, 500);
  if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 400);
  const fromUserId = id(objectId(body.fromUserId, "current approver id")), toUserId = id(objectId(body.toUserId, "replacement approver id"));
  if (fromUserId === toUserId) throw generateError("Choose a different replacement approver", 422);
  return { revision: body.revision, requestId, stepOrder: body.stepOrder, fromUserId, toUserId, reason };
}
function requireAuthority(state: any, actor: any, submission: any, pending = true) {
  if (!state.capabilities.authorized || id(actor) === id(submission.employee)) throw generateError(state.capabilities.blockedReason || "You cannot reassign your own request", 403);
  if (pending && !state.capabilities.canReassign) throw generateError(state.capabilities.blockedReason, 409);
}

export const listTimesheetReassignmentOptions = handler(async (req, res) => {
  const ctx = ownContext(req), submission: any = await Submission.findOne({ company: ctx.company, _id: objectId(req.params.submissionId, "submission id") }).lean();
  if (!submission) throw generateError("Submission not found", 404);
  const state = await loadReassignmentState(submission, ctx.actor); requireAuthority(state, ctx.actor, submission);
  const { page, limit, skip } = timesheetPagination(req.query, 50); if (page > 100) throw generateError("Narrow the approver search instead of paging beyond 100", 400);
  const search = String(req.query.search || "").trim(); if (search.length > 100) throw generateError("Search is limited to 100 characters", 400);
  const excluded = [id(submission.employee), id(ctx.actor), ...state.instance.steps.flatMap((s: any) => s.approvers.map((a: any) => id(a.user)))].map((key) => new mongoose.Types.ObjectId(key));
  const data: any[] = []; let after: any = null, matched = 0;
  for (;;) {
    const match: any = { company: ctx.company, is_enabled: { $ne: false }, deletedAt: null, role: { $ne: "superadmin" }, _id: { $nin: excluded, ...(after ? { $gt: after } : {}) } };
    if (search) { const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); match.$or = [{ name: regex }, { code: regex }]; }
    const batch: any[] = await User.find(match).select("_id company name code username role hrScope department team officeLocation is_enabled deletedAt").sort({ _id: 1 }).limit(200).lean();
    if (!batch.length) break;
    for (const person of batch) {
      if (reassignmentCandidateAllowed(person, ctx.actor, submission, state.instance, state.organization) && matched++ >= skip) data.push({ _id: id(person), name: person.name || person.username, code: person.code || "", role: person.role });
      if (data.length > limit) break;
    }
    if (data.length > limit) break; after = batch[batch.length - 1]._id;
  }
  res.json({ success: true, data: data.slice(0, limit), pagination: { page, limit, hasMore: data.length > limit } });
});

export const reassignTimesheetApproval = handler(async (req, res) => {
  const ctx = ownContext(req), submissionId = objectId(req.params.submissionId, "submission id"), values = reassignmentRequest(req.body);
  await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: id(ctx.company), actionLabel: "reassign timesheet approvals" });
  const hash = createHash("sha256").update(JSON.stringify({ action: "reassign", target: id(submissionId), ...values })).digest("hex");
  const replay = (prior: any) => {
    if (prior.requestHash !== hash || id(prior.actor) !== id(ctx.actor)) throw generateError("Request id was already used for another action", 409);
    return { data: prior.snapshot, evidence: prior.actionEvidence, replayed: true, submissionId: id(submissionId) };
  };
  const session = await mongoose.startSession(); let result: any, retryMatch: any;
  try {
    await session.withTransaction(async () => {
      const submission: any = await Submission.findOne({ _id: submissionId, company: ctx.company }).session(session);
      if (!submission) throw generateError("Submission not found", 404);
      const state = await loadReassignmentState(submission, ctx.actor, session); requireAuthority(state, ctx.actor, submission, false);
      const match = { company: ctx.company, employee: submission.employee, attendanceDate: submission.attendanceDate };
      retryMatch = { ...match, requestId: values.requestId };
      const prior: any = await Revision.findOne(retryMatch).session(session).lean(); if (prior) { result = replay(prior); return; }
      await fenceTimesheetDay(match, session); requireAuthority(state, ctx.actor, submission);
      if (state.sheet.revision !== values.revision) throw generateError("Timesheet changed. Reload before reassigning approval.", 409);
      const replacement: any = await User.findOne({ _id: values.toUserId, company: ctx.company, is_enabled: { $ne: false }, deletedAt: null }).session(session).lean();
      if (!replacement) throw generateError("Replacement approver must be an active user in this company", 422);
      if ([id(ctx.actor), id(submission.employee)].includes(id(replacement))) throw generateError("You cannot assign approval to yourself or the employee", 403);
      if (!reassignmentCandidateAllowed(replacement, ctx.actor, submission, state.instance, state.organization)) throw generateError("Replacement is already in the workflow or outside the employee's HR scope", 422);
      const now = new Date(), evidence = reassignCurrentApprovalStep(state.instance, { actor: ctx.actor, replacement, fromUserId: values.fromUserId, stepOrder: values.stepOrder, reason: values.reason, now });
      await state.instance.save({ session });
      submission.currentApprovers = evidence.pendingAfter;
      submission.participantIds = [...new Set([...submission.participantIds.map(id), id(replacement)])];
      submission.reassignmentCount = (submission.reassignmentCount || 0) + 1;
      submission.sheetRevision = state.sheet.revision + 1;
      submission.history.push({ action: "approval_reassigned", actor: ctx.actor._id, actorNameSnapshot: ctx.actor.name || ctx.actor.username, comment: values.reason, reassignment: evidence, at: now });
      await submission.save({ session });
      const saved: any = await Timesheet.findOneAndUpdate({ ...match, revision: values.revision, status: "submitted", currentSubmission: submissionId, payrollLockedAt: null }, { $inc: { revision: 1 }, $set: { updatedBy: ctx.actor._id } }, { new: true, session, runValidators: true }).lean();
      if (!saved) throw generateError("Timesheet changed. Reload before reassigning approval.", 409);
      await Revision.create([{ ...retryMatch, timesheet: saved._id, revision: saved.revision, requestHash: hash, actor: ctx.actor._id, action: "reassign", actionEvidence: evidence, snapshot: saved }], { session });
      for (const [recipient, audience] of [[replacement._id, "new_reviewer"], [objectId(values.fromUserId, "previous approver"), "old_reviewer"], [submission.employee, "employee"]] as const) {
        await createRequestNotifications({ company: ctx.company, recipients: [recipient], actor: ctx.actor._id, entityType: "timesheet_submission", entityId: submission._id,
          eventType: `timesheet.approval_reassigned.${audience}`, title: audience === "new_reviewer" ? "Timesheet approval assigned to you" : audience === "old_reviewer" ? "Timesheet approval reassigned" : "Your timesheet approver changed",
          message: `${submission.attendanceDate}: ${evidence.from.name} to ${evidence.to.name}. ${values.reason}`,
          category: audience === "new_reviewer" ? "approval" : "request", actionUrl: audience === "employee" ? `/dashboard/calendar?workDate=${submission.attendanceDate}` : "/dashboard",
          metadata: { submissionId: id(submission), attendanceDate: submission.attendanceDate, stepOrder: values.stepOrder, sheetRevision: saved.revision }, dedupeEventKey: `reassigned:${saved.revision}:${audience}` }, session);
      }
      result = { data: saved, evidence, replayed: false, submissionId: id(submission), message: "Pending approval reassigned" };
    });
  } catch (error: any) {
    if (error?.code === 11000 && retryMatch) { const prior: any = await Revision.findOne(retryMatch).lean(); if (prior) result = replay(prior); else throw generateError("Timesheet changed. Reload before trying again.", 409); }
    else throw error?.name === "VersionError" ? generateError("Timesheet changed. Reload before trying again.", 409) : error;
  } finally { await session.endSession(); }
  res.json({ success: true, ...result });
});
