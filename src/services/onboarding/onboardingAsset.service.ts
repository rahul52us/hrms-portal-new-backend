import { createHash } from "crypto";
import mongoose, { ClientSession } from "mongoose";
import Instance from "../../schemas/Onboarding/EmployeeOnboarding.schema";
import Audit from "../../schemas/Onboarding/EmployeeOnboardingAudit.schema";
import { OnboardingAssetLink as Link, OnboardingAssetEvent as Event } from "../../schemas/Onboarding/OnboardingAsset.schema";
import { Asset, AssetAssignment as Assignment } from "../../schemas/Assets/Asset.schema";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { assetContext, AssetContext, canManageAssets } from "../assets/asset.utils";
import { attachEffectivePermissions } from "../permissions/permission.utils";
import { upsertRequestNotifications } from "../notification/notification.service";
import { objectId, pagination, searchRegex, text } from "./onboardingTemplate.utils";
import { managesOnboardingEmployee, onboardingStatus, ownsOnboardingTask, valueId, visibleOnboardingTask } from "./employeeOnboarding.utils";

export type OnboardingAssetReference = { instanceId: string; taskId: string; revision: number };
export async function initializeOnboardingAssets() { for (const model of [Link, Event, Audit]) await model.init(); }
export function parseOnboardingAssetReference(value: any): OnboardingAssetReference | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["instanceId", "taskId", "revision"].includes(key))) throw generateError("Provide the onboarding checklist, task and current revision", 422);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw generateError("Load the current onboarding revision first", 422);
  return { instanceId: valueId(objectId(value.instanceId, "onboarding id")), taskId: valueId(objectId(value.taskId, "task id")), revision: value.revision };
}
export function canControlOnboardingAssets(ctx: AssetContext, employee: any, task: any) {
  return valueId(ctx.actor) !== valueId(employee) && canManageAssets(ctx) && (managesOnboardingEmployee(ctx.actor, employee) || ownsOnboardingTask(ctx.actor, employee, task));
}
async function taskContext(ctx: AssetContext, instanceId: any, taskId: any, session?: ClientSession, control = false) {
  const instance: any = await Instance.findOne({ _id: objectId(valueId(instanceId), "onboarding id"), company: ctx.company }).session(session || null).lean();
  if (!instance) throw generateError("Onboarding checklist not found", 404);
  const employee: any = await User.findOne({ _id: instance.employee, company: ctx.company, role: { $ne: "superadmin" } }).select("_id name code department team officeLocation reportingManager").session(session || null).lean();
  const task = instance.tasks.find((item: any) => valueId(item) === valueId(objectId(valueId(taskId), "task id")));
  if (!employee || !task || task.kind !== "asset_provisioning" || !visibleOnboardingTask(ctx.actor, employee, task)) throw generateError("Asset provisioning task not found", 404);
  if (control && !canControlOnboardingAssets(ctx, employee, task)) throw generateError("View/Manage Assets and assigned-task or scoped onboarding management access are required; another operator must provision your assets", 403);
  return { instance, employee, task };
}

/** At most 100 active bindings are inspected; snapshots never fetch another holder's profile or internal inventory notes. */
async function inspect(company: any, instance: any, task: any, links: any[], session?: ClientSession) {
  const assignments: any[] = links.length ? await Assignment.find({ company, _id: { $in: links.map((link) => link.assignment) } }).select("asset employee active status acknowledgedAt revision conditionOut issuedAt assetSnapshot").session(session || null).lean() : [];
  const assets: any[] = assignments.length ? await Asset.find({ company, _id: { $in: assignments.map((record) => record.asset) } }).select("status currentAssignment openIncident openService openWriteOff writtenOffRecord maintenanceReleaseBlocked").session(session || null).lean() : [];
  const people = new Map(assignments.map((record) => [valueId(record), record])), units = new Map(assets.map((asset) => [valueId(asset), asset]));
  return new Map(links.map((link) => {
    const assignment: any = people.get(valueId(link.assignment)), asset: any = assignment ? units.get(valueId(assignment.asset)) : null;
    const issued = Boolean(link.active && link.cycle === (task.assetCycle || 1) && assignment?.active && assignment.status === "issued" && valueId(assignment.employee) === valueId(instance.employee)
      && valueId(assignment.asset) === valueId(link.asset) && asset?.status === "issued" && !asset.openIncident && !asset.openService && !asset.openWriteOff && !asset.writtenOffRecord && !asset.maintenanceReleaseBlocked && valueId(asset.currentAssignment) === valueId(assignment)
      && assignment.assetSnapshot?.category === task.assetRequirement.category && assignment.conditionOut !== "damaged");
    return [valueId(link), { assignment, issued, acknowledged: issued && Boolean(assignment.acknowledgedAt) }] as const;
  }));
}
async function progress(company: any, instance: any, task: any, session?: ClientSession) {
  const links: any[] = await Link.find({ company, onboarding: instance._id, task: task._id, cycle: task.assetCycle || 1, active: true }).limit(101).session(session || null).lean();
  if (links.length > 100) throw generateError("Too many active asset links. Review provisioning history before continuing.", 409);
  const inspected = await inspect(company, instance, task, links, session), seen = new Set<string>();
  let issued = 0, acknowledged = 0;
  for (const link of links) {
    const state = inspected.get(valueId(link));
    if (!state?.issued || seen.has(valueId(link.asset))) continue;
    seen.add(valueId(link.asset)); issued++; if (state.acknowledged) acknowledged++;
  }
  return { linked: links.length, issued, acknowledged, fulfilled: task.assetRequirement.receiptRequired ? acknowledged : issued,
    required: task.assetRequirement.quantity, receiptRequired: task.assetRequirement.receiptRequired, evaluatedAt: new Date() };
}
export const emptyAssetProvision = (task: any) => ({ linked: 0, issued: 0, acknowledged: 0, fulfilled: 0, required: task.assetRequirement.quantity, receiptRequired: task.assetRequirement.receiptRequired, evaluatedAt: new Date() });
async function event(ctx: AssetContext, instance: any, task: any, input: any, session: ClientSession) {
  return (await Event.create([{ company: ctx.company, onboarding: instance._id, task: task._id, cycle: task.assetCycle || 1,
    actor: ctx.actor._id, actorName: ctx.actor.name || "Employee", ...input }], { session }))[0].toObject();
}

/** Derived progress is part of the custody transaction, so returns cannot leave a completed task backed by closed custody. */
async function evaluate(ctx: AssetContext, instance: any, employee: any, task: any, cause: any, session: ClientSession) {
  const before = JSON.parse(JSON.stringify(instance)), previous = task.status, counts = await progress(ctx.company, instance, task, session);
  task.assetProvision = counts;
  if (task.status !== "waived") {
    if (counts.fulfilled >= counts.required) {
      task.status = "completed"; task.ownerIssue = "";
      if (previous !== "completed") { task.completedAt = new Date(); task.completedBy = ctx.actor._id; }
      task.completionNote = `${counts.fulfilled}/${counts.required} ${task.assetRequirement.categoryName || task.assetRequirement.category} unit(s) ${counts.receiptRequired ? "received and acknowledged" : "handed over"}.`;
    } else {
      task.status = task.assignees.length ? "pending" : "blocked"; task.completedAt = null; task.completedBy = null; task.completionNote = "";
      task.ownerIssue = task.assignees.length ? "" : "No eligible provisioning owner is assigned. HR must review this task.";
    }
  }
  const after: any = await Instance.findOneAndUpdate({ _id: instance._id, company: ctx.company, revision: instance.revision, status: { $ne: "cancelled" }, isCurrent: true }, { $set: { tasks: instance.tasks, status: onboardingStatus(instance.tasks), updatedBy: ctx.actor._id }, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
  if (!after) throw generateError("Onboarding changed. Reload before updating asset evidence.", 409);
  const action = previous !== "completed" && task.status === "completed" ? "task_asset_fulfilled" : previous === "completed" && task.status !== "completed" ? "task_asset_reopened" : "task_asset_evidence_updated";
  const recorded = await event(ctx, instance, task, { ...cause, before: { status: previous, revision: before.revision, progress: before.tasks.find((entry: any) => valueId(entry) === valueId(task))?.assetProvision || null }, after: { status: task.status, revision: after.revision, progress: counts } }, session);
  await Audit.create([{ company: ctx.company, onboarding: instance._id, task: task._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Employee", action, reason: cause.reason,
    requestId: `asset-event-${recorded._id}`, requestHash: createHash("sha256").update(cause.eventKey).digest("hex"), before, after }], { session });
  if (previous !== task.status) {
    const ids = [employee._id, instance.createdBy, ...task.assignees.map((person: any) => person.user)];
    const company = await Company.findById(ctx.company).select("rolePermissions").session(session).lean();
    const people: any[] = await User.find({ company: ctx.company, _id: { $in: ids }, deletedAt: null, is_enabled: { $ne: false } }).select("_id role company permissions accessRole department team officeLocation hrScope").session(session).lean();
    const recipients = people.filter((person) => visibleOnboardingTask(attachEffectivePermissions({ user: person, company }), employee, task)).map((person) => person._id);
    await upsertRequestNotifications({ company: ctx.company, actor: ctx.actor._id, recipients, entityType: "employee_onboarding", entityId: instance._id, eventType: `onboarding.${action}`,
      title: task.status === "completed" ? "Onboarding equipment requirement fulfilled" : "Onboarding equipment needs attention", message: `${instance.employeeNameSnapshot}: ${task.title}. ${counts.fulfilled}/${counts.required} qualifying unit(s).`,
      category: "system", priority: task.status === "completed" ? "medium" : "high", actionUrl: `/dashboard/onboarding?instanceId=${instance._id}`, dedupeEventKey: `asset-evidence:${recorded._id}` }, session);
  }
  return { onboardingId: after._id, taskId: task._id, revision: after.revision, status: task.status, assetProvision: counts };
}

/** Shared by explicit link and issue-with-checklist: no additional physical custody is manufactured. */
export async function linkOnboardingAsset(ctx: AssetContext, reference: OnboardingAssetReference, assignment: any, reason: string, eventKey: string, session: ClientSession, request?: { requestId: string; requestHash: string }) {
  const { instance, employee, task } = await taskContext(ctx, reference.instanceId, reference.taskId, session, true);
  if (instance.revision !== reference.revision) throw generateError("Onboarding changed. Reload the task before linking equipment.", 409);
  if (!instance.isCurrent || instance.status === "cancelled" || !["pending", "blocked"].includes(task.status)) throw generateError("Only a current pending asset task can receive new evidence. Reopen it first if needed.", 409);
  if (valueId(assignment.company) !== valueId(ctx.company) || valueId(assignment.employee) !== valueId(employee) || !assignment.active || assignment.status !== "issued" || assignment.assetSnapshot?.category !== task.assetRequirement.category || assignment.conditionOut === "damaged") throw generateError("Choose a currently issued, matching-category handover belonging to this employee", 422);
  const asset: any = await Asset.findOne({ _id: assignment.asset, company: ctx.company, status: "issued", currentAssignment: assignment._id, openIncident: null, openService: null, openWriteOff: null, writtenOffRecord: null, maintenanceReleaseBlocked: { $ne: true } }).select("_id").session(session).lean();
  if (!asset) throw generateError("The handover no longer matches current inventory custody", 409);
  const counts = await progress(ctx.company, instance, task, session);
  if (counts.linked >= 100 || counts.issued >= task.assetRequirement.quantity) throw generateError("This task already has its required issued units. Await receipt or detach/replace existing evidence.", 409);
  if (await Link.exists({ company: ctx.company, assignment: assignment._id, active: true }).session(session)) throw generateError("This handover is already linked to an onboarding requirement", 409);
  // This write serializes linking with receipt/return/void operations without changing custody's public revision.
  const fenced = await Assignment.updateOne({ _id: assignment._id, company: ctx.company, revision: assignment.revision, active: true, status: "issued" }, { $inc: { onboardingFence: 1 } }, { session, timestamps: false });
  if (!fenced.matchedCount) throw generateError("Asset handover changed. Reload before linking.", 409);
  const link = (await Link.create([{ company: ctx.company, onboarding: instance._id, task: task._id, cycle: task.assetCycle || 1, employee: employee._id, assignment: assignment._id, asset: assignment.asset,
    assetSnapshot: assignment.assetSnapshot, issuedAt: assignment.issuedAt, linkedBy: ctx.actor._id, linkedByName: ctx.actor.name || "Asset manager", linkedAt: new Date(), reason }], { session }))[0];
  return evaluate(ctx, instance, employee, task, { action: "linked", reason, eventKey, link: link._id, assignment: assignment._id, ...request }, session);
}

/** Existing custody actions may reconcile scoped onboarding, but gain no right to read or edit unrelated checklist content. */
export async function syncOnboardingAssetCustody(ctx: AssetContext, assignment: any, action: string, sourceAuditId: any, session: ClientSession) {
  const link: any = await Link.findOne({ company: ctx.company, assignment: assignment._id, active: true }).session(session).lean();
  if (!link) return;
  const instance: any = await Instance.findOne({ _id: link.onboarding, company: ctx.company }).session(session).lean();
  const task = instance?.tasks.find((item: any) => valueId(item) === valueId(link.task));
  const valid = instance && instance.isCurrent && instance.status !== "cancelled" && task?.kind === "asset_provisioning" && task.assetRequirement && task.status !== "waived" && (task.assetCycle || 1) === link.cycle;
  const closed = !assignment.active || ["returned", "voided"].includes(assignment.status);
  // A replacement may already fulfill the task when the original unit is found; clearing a case must not silently relink it.
  const incidentHold = action === "incident_reported";
  if (!valid || closed || incidentHold) await Link.updateOne({ _id: link._id, company: ctx.company, active: true }, { $set: { active: false, status: closed ? "custody_closed" : "released", endedAt: new Date(), endedBy: ctx.actor._id, endReason: !valid ? "Checklist cancelled, missing, waived or superseded" : incidentHold ? "Asset incident hold; explicit relinking is required after resolution" : `Custody ${action}` } }, { session });
  if (!valid) {
    await event(ctx, { _id: link.onboarding }, { _id: link.task, assetCycle: link.cycle }, {
      action: "released_stale_binding", reason: "Checklist cancelled, missing, waived or superseded", eventKey: `custody:${sourceAuditId}:${link._id}`,
      link: link._id, assignment: assignment._id, before: { active: true }, after: { active: false },
    }, session);
    return; // Physical asset recovery must not depend on an obsolete checklist remaining actionable.
  }
  const employee: any = await User.findOne({ _id: instance.employee, company: ctx.company }).select("_id name code department team officeLocation reportingManager").session(session).lean();
  if (!employee) return;
  await evaluate(ctx, instance, employee, task, { action: `custody_${action}`, reason: `Linked asset handover ${action.replace(/_/g, " ")}`, eventKey: `custody:${sourceAuditId}:${link._id}`, link: link._id, assignment: assignment._id }, session);
}

/** Release evidence only. Waiver/reopen/cancellation never issues, returns, voids or alters equipment custody. */
export async function releaseOnboardingAssetLinks(ctx: AssetContext, instance: any, task: any | null, cause: string, reason: string, requestId: string, session: ClientSession) {
  const targets = task ? [task] : instance.tasks.filter((item: any) => item.kind === "asset_provisioning");
  for (const item of targets) {
    if (item.kind !== "asset_provisioning") continue;
    const released = await Link.updateMany({ company: ctx.company, onboarding: instance._id, task: item._id, active: true }, { $set: { active: false, status: "released", endedAt: new Date(), endedBy: ctx.actor._id, endReason: `${cause}: ${reason}` } }, { session });
    await event(ctx, instance, item, {
      action: cause === "waive" ? "requirement_waived" : cause === "reopen" ? "requirement_reopened" : "checklist_cancelled",
      reason, eventKey: `release:${ctx.actor._id}:${requestId}:${instance._id}:${item._id}:${item.assetCycle || 1}`, after: { releasedLinks: released.matchedCount },
    }, session);
    if (cause !== "cancel") item.assetProvision = emptyAssetProvision(item);
  }
}

async function details(ctx: AssetContext, instanceId: any, taskId: any) {
  const { instance, employee, task } = await taskContext(ctx, instanceId, taskId), counts = instance.status === "cancelled" ? task.assetProvision || emptyAssetProvision(task) : await progress(ctx.company, instance, task);
  const control = canControlOnboardingAssets(ctx, employee, task) && instance.isCurrent && instance.status !== "cancelled" && task.status !== "waived";
  return { instance, employee, task, meta: { onboardingId: instance._id, taskId: task._id, revision: instance.revision, status: task.status, cycle: task.assetCycle || 1, requirement: task.assetRequirement, progress: counts,
    cancelled: instance.status === "cancelled", canLink: Boolean(control && ["pending", "blocked"].includes(task.status) && counts.linked < 100 && counts.issued < task.assetRequirement.quantity), canDetach: Boolean(control) } };
}
export const getOnboardingAssets = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req), { instance, task, meta } = await details(ctx, req.params.instanceId, req.params.taskId), { page, limit, skip } = pagination(req.query);
    if (req.query.history !== undefined && !["true", "false"].includes(req.query.history)) throw generateError("History must be true or false", 400);
    const match = { company: ctx.company, onboarding: instance._id, task: task._id, ...(req.query.history === "true" ? {} : { active: true, cycle: task.assetCycle || 1 }) };
    const links: any[] = await Link.find(match).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Link.countDocuments(match), inspected = await inspect(ctx.company, instance, task, links);
    const data = links.map((link) => {
      const state = inspected.get(valueId(link)), assignment = state?.assignment;
      return { _id: link._id, cycle: link.cycle, active: link.active, status: link.status, assetSnapshot: link.assetSnapshot, assignmentId: link.assignment, issuedAt: link.issuedAt,
        linkedAt: link.linkedAt, linkedByName: link.linkedByName, reason: link.reason, endedAt: link.endedAt, endReason: link.endReason,
        assignmentStatus: assignment?.status || "missing", acknowledgedAt: assignment?.acknowledgedAt || null, assignmentRevision: assignment?.revision || null,
        qualifyingIssued: state?.issued || false, fulfilled: Boolean(state?.issued && (!task.assetRequirement.receiptRequired || state.acknowledged)),
        canAcknowledge: Boolean(!meta.cancelled && task.status !== "waived" && state?.issued && !assignment?.acknowledgedAt && valueId(assignment?.employee) === valueId(ctx.actor)), canDetach: meta.canDetach && link.active && link.cycle === (task.assetCycle || 1) };
    });
    res.json({ success: true, data, meta, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const onboardingAssetOptions = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "manage"), { instance, task } = await taskContext(ctx, req.params.instanceId, req.params.taskId, undefined, true), source = req.query.source || "assigned";
    const { page, limit, skip } = pagination(req.query), search = searchRegex(req.query.search);
    if (!["available", "assigned"].includes(source)) throw generateError("Choose available stock or employee handovers", 400);
    if (!instance.isCurrent || instance.status === "cancelled" || !["pending", "blocked"].includes(task.status)) throw generateError("This task cannot receive new asset evidence", 409);
    if (source === "available") {
      const match = { company: ctx.company, status: "available", currentAssignment: null, openIncident: null, openService: null, openWriteOff: null, writtenOffRecord: null, maintenanceReleaseBlocked: { $ne: true }, category: task.assetRequirement.category, condition: { $ne: "damaged" }, ...(search ? { $or: [{ name: search }, { tag: search }, { serialNumber: search }] } : {}) };
      const data = await Asset.find(match).select("_id name tag serialNumber condition revision").sort({ name: 1, _id: 1 }).skip(skip).limit(limit).lean(), total = await Asset.countDocuments(match);
      res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } }); return;
    }
    const [result] = await Assignment.aggregate([
      { $match: { company: ctx.company, employee: instance.employee, active: true, status: "issued", conditionOut: { $ne: "damaged" }, "assetSnapshot.category": task.assetRequirement.category, ...(search ? { $or: [{ "assetSnapshot.name": search }, { "assetSnapshot.tag": search }, { "assetSnapshot.serialNumber": search }] } : {}) } },
      { $lookup: { from: Link.collection.name, localField: "_id", foreignField: "assignment", pipeline: [{ $match: { company: ctx.company, active: true } }, { $limit: 1 }, { $project: { _id: 1 } }], as: "binding" } }, { $match: { "binding.0": { $exists: false } } },
      { $lookup: { from: Asset.collection.name, localField: "asset", foreignField: "_id", let: { assignment: "$_id" }, pipeline: [{ $match: { company: ctx.company, status: "issued", openIncident: null, openService: null, openWriteOff: null, writtenOffRecord: null, maintenanceReleaseBlocked: { $ne: true }, $expr: { $eq: ["$currentAssignment", "$$assignment"] } } }, { $project: { _id: 1 } }], as: "unit" } }, { $match: { "unit.0": { $exists: true } } },
      { $facet: { data: [{ $sort: { issuedAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit }, { $project: { _id: 1, name: "$assetSnapshot.name", tag: "$assetSnapshot.tag", serialNumber: "$assetSnapshot.serialNumber", revision: 1, acknowledgedAt: 1, issuedAt: 1 } }], total: [{ $count: "value" }] } },
    ]);
    const total = result?.total[0]?.value || 0; res.json({ success: true, data: result?.data || [], pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const onboardingAssetHistory = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req), { instance, task } = await taskContext(ctx, req.params.instanceId, req.params.taskId), { page, limit, skip } = pagination(req.query), match = { company: ctx.company, onboarding: instance._id, task: task._id };
    const data = await Event.find(match).select("cycle actorName action reason before after createdAt link assignment").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Event.countDocuments(match);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const mutateOnboardingAsset = (action: "link" | "detach") => async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "manage"), body = req.body || {}, reference = parseOnboardingAssetReference({ instanceId: req.params.instanceId, taskId: req.params.taskId, revision: body.revision })!;
    await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: valueId(ctx.company), actionLabel: "update onboarding equipment evidence" });
    await initializeOnboardingAssets();
    const reason = text(body.reason, "Reason", 3, 1000), requestId = text(body.requestId, "Request id", 8, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 422);
    const target = objectId(action === "link" ? body.assignmentId : req.params.linkId, action === "link" ? "handover id" : "asset link id");
    if (action === "link" && (!Number.isSafeInteger(body.assignmentRevision) || body.assignmentRevision < 1)) throw generateError("Load the current handover revision first", 422);
    const requestHash = createHash("sha256").update(JSON.stringify({ action, reference, target, reason, ...(action === "link" ? { assignmentRevision: body.assignmentRevision } : {}) })).digest("hex");
    let replayed = false;
    const replay = async (session?: ClientSession) => {
      const prior: any = await Event.findOne({ company: ctx.company, actor: ctx.actor._id, requestId }).select("+requestHash").session(session || null).lean();
      if (!prior) return false;
      if (prior.requestHash !== requestHash) throw generateError("Request id already used for another onboarding asset change", 409);
      replayed = true; return true;
    };
    try { await mongoose.connection.transaction(async (session) => {
      const current = await taskContext(ctx, reference.instanceId, reference.taskId, session, true);
      if (await replay(session)) return;
      if (action === "link") {
        const assignment: any = await Assignment.findOne({ _id: target, company: ctx.company }).session(session).lean();
        if (!assignment) throw generateError("Asset handover not found", 404);
        if (assignment.revision !== body.assignmentRevision) throw generateError("Asset handover changed. Reload before linking.", 409);
        await linkOnboardingAsset(ctx, reference, assignment, reason, `link:${ctx.actor._id}:${requestId}`, session, { requestId, requestHash });
      } else {
        const { instance, task, employee } = current;
        if (instance.revision !== reference.revision || !instance.isCurrent || instance.status === "cancelled" || task.status === "waived") throw generateError("Onboarding changed or task no longer accepts evidence changes. Reload first.", 409);
        const detached: any = await Link.findOneAndUpdate({ _id: target, company: ctx.company, onboarding: instance._id, task: task._id, cycle: task.assetCycle || 1, active: true }, { $set: { active: false, status: "detached", endedAt: new Date(), endedBy: ctx.actor._id, endReason: reason } }, { session, new: true }).lean();
        if (!detached) throw generateError("Asset evidence was already detached or changed. Reload first.", 409);
        await evaluate(ctx, instance, employee, task, { action: "detached", reason, eventKey: `detach:${ctx.actor._id}:${requestId}`, link: detached._id, assignment: detached.assignment, requestId, requestHash }, session);
      }
    }); } catch (error: any) {
      if (error.code !== 11000) throw error;
      if (!await replay()) throw generateError("The handover is already linked, or onboarding changed. Reload first.", 409);
    }
    res.json({ success: true, data: (await details(ctx, reference.instanceId, reference.taskId)).meta, replayed });
  } catch (error) { next(error); }
};
