import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import Policy from "../../schemas/WorkforcePolicy/TimesheetPolicy.schema";
import Version from "../../schemas/WorkforcePolicy/TimesheetPolicyVersion.schema";
import Assignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import User from "../../schemas/User/User";
import { dateKey, objectId, projectCode, shortText } from "../project/project.utils";
import { normalizeTimesheetRules, timesheetPagination as pagination } from "../timesheet/timesheetRules.utils";
import { resolveEffectiveApprovalWorkflowReference } from "../approval/approvalWorkflow.service";
import { ensurePolicyManager, ensurePolicyViewer, escapeRegex, getPolicyActorId, getVersionEffectiveTo, resolvePolicyCompany, writePolicyAudit } from "./workforcePolicy.utils";
import { buildOperationsDays } from "../timesheet/timesheetOperationsBatch.service";

export const previewTimesheetPolicy = async (req: any, res: any, next: any) => {
  try {
    ensurePolicyManager(req);
    const { companyObjectId: company } = await resolvePolicyCompany(req, req.body.companyId, true);
    const date = dateKey(req.body.effectiveFrom, "Preview date")!;
    const policy = req.body.policyId ? objectId(req.body.policyId, "policy id") : new mongoose.Types.ObjectId();
    if (req.body.policyId && !await Policy.exists({ company, _id: policy })) throw generateError("Timesheet policy not found", 404);
    const published: any = req.body.rules === undefined && req.body.policyId ? await Version.findOne({ company, policy, status: "published", effectiveFrom: { $lte: new Date(`${date}T00:00:00Z`) } }).sort({ effectiveFrom: -1, versionNumber: -1 }).lean() : null;
    if (req.body.rules === undefined && !published) throw generateError("No policy version is published for the preview date", 422);
    const rules = normalizeTimesheetRules(req.body.rules === undefined ? published.rules : req.body.rules);
    const scopeType = req.body.scopeType, scopeId = scopeType && scopeType !== "company" ? objectId(req.body.scopeId, "scope id") : null;
    if (scopeType && !["company", "location", "department", "team", "employee"].includes(scopeType)) throw generateError("Invalid preview scope", 422);
    const { page, limit, skip } = pagination(req.body, 20), match: any = { company, deletedAt: null, role: { $ne: "superadmin" } };
    if (req.body.search) { const expression = new RegExp(escapeRegex(shortText(req.body.search, "Employee search", 1, 100)), "i"); match.$or = [{ name: expression }, { code: expression }]; }
    const employees = await User.find(match).select("_id company name code joiningDate createdAt employmentEndDate department team officeLocation reportingManager").sort({ name: 1, _id: 1 }).skip(skip).limit(limit).lean();
    const version = { _id: new mongoose.Types.ObjectId(), policy, status: "published", effectiveFrom: new Date(`${date}T00:00:00Z`), versionNumber: Number.MAX_SAFE_INTEGER, rules };
    const assignment = scopeType ? { _id: new mongoose.Types.ObjectId(), company, resource: policy, resourceType: "timesheet_policy", scopeType, scopeId, effectiveFrom: version.effectiveFrom } : undefined;
    const rows = await buildOperationsDays(company, employees, [date], undefined, new Date(), true, undefined, { policy, version, assignment });
    const conflict = assignment ? Boolean(await Assignment.exists({ company, resourceType: "timesheet_policy", scopeType, scopeId, effectiveFrom: { $lte: version.effectiveFrom }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: version.effectiveFrom } }] })) : false;
    const data = rows.map((row) => ({ employee: row.employee, applies: String(row._day.context.policies.timesheetPolicy?.version?._id) === String(version._id), requiredMinutes: row._day.requirement.requiredMinutes, payrollMode: row._day.rules?.payrollMode || "report_only", deadlineAt: row._day.eligibility.deadlineAt, editableUntilAt: row._day.eligibility.editableUntilAt, setupIssues: row._day.eligibility.setupIssues }));
    const total = await User.countDocuments(match);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ success: true, data, conflict, summaryScope: "page", proposedAssignment: Boolean(assignment), pagination: { page, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};

const effectiveDate = (value: any) => new Date(`${dateKey(value, "Effective from date")}T00:00:00Z`);

function handler(action: (req: any, ctx: any, session: mongoose.ClientSession | null) => Promise<any>, write = false, status = 200) {
  return async (req: any, res: any, next: any) => {
    let session: mongoose.ClientSession | null = null;
    try {
      if (write) ensurePolicyManager(req); else ensurePolicyViewer(req);
      const { companyObjectId } = await resolvePolicyCompany(req, req.body?.companyId || req.query.companyId, write);
      const ctx = { company: companyObjectId, actor: getPolicyActorId(req) };
      let result: any;
      if (write) {
        session = await mongoose.startSession();
        await session.withTransaction(async () => { result = await action(req, ctx, session); });
      } else result = await action(req, ctx, null);
      res.status(status).json({ success: true, ...result });
    } catch (error: any) {
      next(error?.code === 11000 ? generateError("Policy code, draft, or published effective date already exists. Refresh before retrying.", 409) : error);
    } finally { await session?.endSession(); }
  };
}

async function policyFor(req: any, ctx: any, session: mongoose.ClientSession | null, active = false) {
  const policy: any = await Policy.findOne({ _id: objectId(req.params.policyId, "policy id"), company: ctx.company }).session(session).lean();
  if (!policy) throw generateError("Timesheet policy not found", 404);
  if (active && policy.status !== "active") throw generateError("Archived timesheet policies cannot be changed", 409);
  return policy;
}
async function touch(policy: any, ctx: any, session: any, changes: any = {}) {
  const result = await Policy.updateOne({ _id: policy._id, company: ctx.company, revision: policy.revision }, { $set: changes, $inc: { revision: 1 } }, { session });
  if (!result.modifiedCount) throw generateError("Policy changed. Refresh before trying again.", 409);
}
async function audit(ctx: any, session: any, entityType: "timesheet_policy" | "timesheet_version", entityId: any, action: string, details: any) {
  await writePolicyAudit({ company: ctx.company, actor: ctx.actor, entityType, entityId, action, details }, session);
}

export const listTimesheetPolicies = handler(async (req, ctx) => {
  const { page, limit, skip } = pagination(req.query);
  const match: any = { company: ctx.company };
  if (req.query.status) {
    if (!["active", "archived"].includes(req.query.status)) throw generateError("Invalid policy status", 400);
    match.status = req.query.status;
  }
  if (req.query.search) {
    const expression = new RegExp(escapeRegex(shortText(req.query.search, "Search", 1, 100)), "i");
    match.$or = [{ name: expression }, { code: expression }];
  }
  const policies: any[] = await Policy.find(match).sort({ name: 1, _id: 1 }).skip(skip).limit(limit).lean();
  const ids = policies.map((item) => item._id);
  const [total, versions, counts] = await Promise.all([
    Policy.countDocuments(match),
    Version.aggregate([{ $match: { company: ctx.company, policy: { $in: ids }, status: { $in: ["draft", "published"] } } },
      { $sort: { effectiveFrom: -1, versionNumber: -1 } }, { $group: { _id: { policy: "$policy", status: "$status" }, version: { $first: "$$ROOT" } } }]),
    Assignment.aggregate([{ $match: { company: ctx.company, resourceType: "timesheet_policy", resource: { $in: ids }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }] } }, { $group: { _id: "$resource", count: { $sum: 1 } } }]),
  ]);
  return { data: policies.map((policy) => ({ ...policy,
    draftVersion: versions.find((v) => String(v._id.policy) === String(policy._id) && v._id.status === "draft")?.version || null,
    latestPublishedVersion: versions.find((v) => String(v._id.policy) === String(policy._id) && v._id.status === "published")?.version || null,
    assignmentCount: counts.find((c) => String(c._id) === String(policy._id))?.count || 0,
  })), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});

export const getTimesheetPolicy = handler(async (req, ctx) => {
  const policy = await policyFor(req, ctx, null);
  const versions: any[] = await Version.find({ company: ctx.company, policy: policy._id }).sort({ versionNumber: -1 }).lean();
  return { data: { policy, versions: versions.map((version) => ({ ...version, effectiveTo: getVersionEffectiveTo(version, versions.filter((v) => v.status === "published")) })) } };
});

export const createTimesheetPolicy = handler(async (req, ctx, session) => {
  const rules = normalizeTimesheetRules(req.body.rules);
  if (rules.approvalWorkflowId) await resolveEffectiveApprovalWorkflowReference({ company: ctx.company, workflowId: rules.approvalWorkflowId, requestType: "timesheet_submission", at: effectiveDate(req.body.effectiveFrom) });
  const [policy]: any[] = await Policy.create([{ company: ctx.company, name: shortText(req.body.name, "Policy name", 2, 120),
    code: projectCode(req.body.code, req.body.name), description: shortText(req.body.description || "", "Description", 0, 1000), createdBy: ctx.actor }], { session });
  const [version] = await Version.create([{ company: ctx.company, policy: policy._id, versionNumber: 1,
    effectiveFrom: effectiveDate(req.body.effectiveFrom), rules,
    changeReason: shortText(req.body.changeReason || "Initial timesheet policy", "Change reason", 3, 500), createdBy: ctx.actor }], { session });
  await audit(ctx, session, "timesheet_policy", policy._id, "created", { versionId: version._id, rules: version.rules });
  return { data: { policy, version }, message: "Timesheet policy draft created" };
}, true, 201);

export const createTimesheetPolicyVersion = handler(async (req, ctx, session) => {
  const policy = await policyFor(req, ctx, session, true);
  if (await Version.exists({ company: ctx.company, policy: policy._id, status: "draft" }).session(session)) throw generateError("Finish or cancel the existing draft before creating another version", 409);
  const source: any = await Version.findOne({ company: ctx.company, policy: policy._id, status: "published" }).sort({ effectiveFrom: -1, versionNumber: -1 }).session(session).lean();
  await touch(policy, ctx, session, { latestVersionNumber: policy.latestVersionNumber + 1 });
  const [version] = await Version.create([{ company: ctx.company, policy: policy._id, versionNumber: policy.latestVersionNumber + 1,
    effectiveFrom: effectiveDate(req.body.effectiveFrom), rules: normalizeTimesheetRules(req.body.rules, source?.rules),
    changeReason: shortText(req.body.changeReason, "Change reason", 3, 500), createdBy: ctx.actor }], { session });
  await audit(ctx, session, "timesheet_version", version._id, "draft_created", { policyId: policy._id, versionNumber: version.versionNumber });
  return { data: version, message: "Timesheet policy version draft created" };
}, true, 201);

export const changeTimesheetPolicyVersion = (action: "update" | "publish" | "cancel") => handler(async (req, ctx, session) => {
  const policy = await policyFor(req, ctx, session, true);
  const version: any = await Version.findOne({ _id: objectId(req.params.versionId, "version id"), company: ctx.company, policy: policy._id }).session(session).lean();
  if (!version) throw generateError("Timesheet policy version not found", 404);
  if (version.status !== "draft") throw generateError("Only draft timesheet policy versions can be changed", 409);
  if (!Number.isSafeInteger(req.body.revision) || req.body.revision !== version.revision) throw generateError("Draft changed. Refresh before saving.", 409);
  const changes: any = {};
  if (action === "update") {
    changes.rules = normalizeTimesheetRules(req.body.rules, version.rules);
    if (req.body.effectiveFrom !== undefined) changes.effectiveFrom = effectiveDate(req.body.effectiveFrom);
    if (req.body.changeReason !== undefined) changes.changeReason = shortText(req.body.changeReason, "Change reason", 3, 500);
  } else if (action === "publish") {
    changes.rules = normalizeTimesheetRules({}, version.rules);
    changes.status = "published"; changes.publishedAt = new Date(); changes.publishedBy = ctx.actor;
    changes.effectiveFrom = effectiveDate(req.body.effectiveFrom || version.effectiveFrom?.toISOString().slice(0, 10));
  } else {
    changes.status = "cancelled"; changes.cancelledAt = new Date(); changes.cancelledBy = ctx.actor;
    changes.cancellationReason = shortText(req.body.reason, "Cancellation reason", 3, 500);
  }
  if (action !== "cancel" && changes.rules?.approvalWorkflowId) await resolveEffectiveApprovalWorkflowReference({ company: ctx.company, workflowId: changes.rules.approvalWorkflowId, requestType: "timesheet_submission", at: changes.effectiveFrom || version.effectiveFrom });
  await touch(policy, ctx, session);
  const updated = await Version.findOneAndUpdate({ _id: version._id, company: ctx.company, revision: version.revision, status: "draft" }, { $set: changes, $inc: { revision: 1 } }, { new: true, runValidators: true, session }).lean();
  if (!updated) throw generateError("Draft changed. Refresh before saving.", 409);
  await audit(ctx, session, "timesheet_version", version._id, action === "update" ? "draft_updated" : action === "publish" ? "published" : "draft_cancelled", { policyId: policy._id, before: version, after: updated });
  return { data: updated, message: `Timesheet policy ${action === "publish" ? "published" : action === "cancel" ? "draft cancelled" : "draft updated"}` };
}, true);

export const archiveTimesheetPolicy = handler(async (req, ctx, session) => {
  const policy = await policyFor(req, ctx, session, true);
  const reason = shortText(req.body.reason, "Archive reason", 3, 500);
  if (await Assignment.exists({ company: ctx.company, resourceType: "timesheet_policy", resource: policy._id, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }] }).session(session)) throw generateError("End active or scheduled assignments before archiving this policy", 409);
  await touch(policy, ctx, session, { status: "archived", archivedAt: new Date(), archivedBy: ctx.actor, archiveReason: reason });
  await audit(ctx, session, "timesheet_policy", policy._id, "archived", { reason });
  return { message: "Timesheet policy archived" };
}, true);
