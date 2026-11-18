import { createHash } from "crypto";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { getEmployeeRequestActor, resolveEmployeeRequestCompanyId } from "../leave/leaveAccess.utils";
import { canManageOnboardingAutomation } from "./onboardingAutomation.service";
import { objectId, pagination, text } from "./onboardingTemplate.utils";
import { attachedDocument, authorizedRetentionPeople, Audit, Document, documentDto, erasureDto, fenceUnlinked, fileContext, Instance, notifyRetention, Policy, policyDto, Request, retentionAudit, retentionDay, retentionPolicy, revisionNumber, sameRevision } from "./onboardingRetention.utils";

function context(req: any) {
  const actor = getEmployeeRequestActor(req);
  if (!canManageOnboardingAutomation(actor)) throw generateError("Company Admin or HR Admin with onboarding management permission is required", 403);
  return { actor, company: resolveEmployeeRequestCompanyId(actor, req.query?.companyId || req.body?.companyId, "onboarding retention") };
}
export const getRetentionPolicy = async (req: any, res: any, next: any) => {
  try { const { company } = context(req); res.json({ success: true, data: await retentionPolicy(company) }); } catch (error) { next(error); }
};
/** Project metadata before joining: paginated inventory must never materialize file contents. */
export const listRetentionDocuments = async (req: any, res: any, next: any) => {
  try {
    const { company } = context(req), policy = await retentionPolicy(company), { page, limit, skip } = pagination(req.query);
    const scope = req.query.scope || "eligible";
    if (!["eligible", "removed", "held", "all"].includes(scope)) throw generateError("Invalid document inventory scope", 422);
    const base: any = { company, $or: [...attachedDocument.$or, { storageStatus: { $in: ["erasing", "erased"] } }] };
    if (scope === "removed") base.retentionRemovedAt = { $ne: null };
    if (scope === "held") base["retentionHold.active"] = true;
    if (scope === "eligible") Object.assign(base, { retentionRemovedAt: { $lte: new Date(Date.now() - policy.retentionDays * retentionDay), $ne: null }, "retentionHold.active": { $ne: true }, erasureRequest: null, ...attachedDocument });
    const records = await Document.aggregate([
      { $match: base }, { $sort: { createdAt: -1, _id: -1 } }, { $project: { name: 1, size: 1, company: 1, onboarding: 1, storageProvider: 1, storageStatus: 1, retentionRemovedAt: 1, retentionRevision: 1, retentionHold: 1, erasureRequest: 1, createdAt: 1 } },
      { $lookup: { from: Instance.collection.name, let: { parent: "$onboarding", company: "$company" }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$_id", "$$parent"] }, { $eq: ["$company", "$$company"] }] } } }, { $project: { employeeNameSnapshot: 1, employeeCodeSnapshot: 1 } }], as: "parent" } },
      { $lookup: { from: Instance.collection.name, localField: "_id", foreignField: "tasks.documents.document", pipeline: [{ $match: { company } }, { $limit: 1 }, { $project: { _id: 1 } }], as: "links" } },
      ...(scope === "eligible" ? [{ $match: { "links.0": { $exists: false }, "parent.0": { $exists: true }, ...(policy.enabled ? {} : { _id: null }) } }] : []),
      { $facet: { data: [{ $skip: skip }, { $limit: limit }], total: [{ $count: "value" }] } },
    ]).allowDiskUse(true);
    const total = records[0]?.total[0]?.value || 0;
    res.json({ success: true, data: (records[0]?.data || []).map((doc: any) => documentDto(doc, Boolean(doc.links.length), policy, doc.parent[0])), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const listRetentionRequests = async (req: any, res: any, next: any) => {
  try {
    const { actor, company } = context(req), { page, limit, skip } = pagination(req.query);
    const data: any[] = await Request.find({ company }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Request.countDocuments({ company });
    res.json({ success: true, data: data.map((record) => erasureDto(record, actor, false)), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const getRetentionRequest = async (req: any, res: any, next: any) => {
  try {
    const { actor, company } = context(req), record = await Request.findOne({ _id: objectId(req.params.requestId, "erasure request"), company }).lean();
    if (!record) throw generateError("Erasure request not found", 404);
    res.json({ success: true, data: erasureDto(record, actor) });
  } catch (error) { next(error); }
};
export const listRetentionAudit = async (req: any, res: any, next: any) => {
  try {
    const { company } = context(req), { page, limit, skip } = pagination(req.query);
    const data = await Audit.find({ company }).select("entityType entityId actorName action reason before after createdAt").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Audit.countDocuments({ company });
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};

type Mutation = "policy" | "clock" | "hold" | "create" | "decision" | "withdraw" | "retry";
/** All HR writes are revision-checked, audited and retry-safe. Approval only queues durable work. */
export const mutateRetention = (kind: Mutation) => async (req: any, res: any, next: any) => {
  try {
    const { actor, company } = context(req), body = req.body || {};
    await ensureCompanyManagementAccess({ actor, requestedCompanyId: String(company), actionLabel: "manage document retention" });
    for (const model of [Policy, Request, Audit]) await model.init();
    const reason = text(body.reason, "Reason", 3, 1000), requestId = text(body.requestId, "Request id", 8, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 422);
    const revision = revisionNumber(kind === "create" ? body.policyRevision : body.revision);
    const target = kind === "clock" || kind === "hold" ? objectId(req.params.documentId, "document") : ["decision", "withdraw", "retry"].includes(kind) ? objectId(req.params.requestId, "erasure request") : null;
    const input: any = { kind, target: target ? String(target) : null, revision, reason };
    if (kind === "policy") {
      if (typeof body.enabled !== "boolean" || !Number.isSafeInteger(body.retentionDays) || body.retentionDays < 1 || body.retentionDays > 36500) throw generateError("Choose enabled and a retention period of 1-36500 whole days", 422);
      Object.assign(input, { enabled: body.enabled, retentionDays: body.retentionDays });
    }
    if (kind === "hold") { if (typeof body.active !== "boolean") throw generateError("Hold active must be true or false", 422); input.active = body.active; }
    if (kind === "create") {
      if (!Array.isArray(body.documents) || !body.documents.length || body.documents.length > 50) throw generateError("Choose 1-50 eligible documents", 422);
      input.documents = body.documents.map((entry: any) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw generateError("Choose valid document IDs and revisions", 422);
        return { documentId: String(objectId(entry.documentId, "document")), revision: revisionNumber(entry.revision) };
      });
      if (new Set(input.documents.map((entry: any) => entry.documentId)).size !== input.documents.length) throw generateError("Choose each document only once", 422);
    }
    if (kind === "decision") {
      if (!["approve", "reject"].includes(body.decision)) throw generateError("Choose approve or reject", 422);
      if (body.decision === "approve" && body.confirmErasure !== true) throw generateError("Explicit irreversible content erasure confirmation is required", 422);
      input.decision = body.decision; input.confirmErasure = body.confirmErasure === true;
    }
    if (kind === "retry") {
      if (body.confirmErasure !== true) throw generateError("Explicit irreversible content erasure confirmation is required", 422);
      input.confirmErasure = true;
    }
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    let entityId: any, entityType = "", replayed = false;
    const replay = async (session?: mongoose.ClientSession) => {
      const prior: any = await Audit.findOne({ company, actor: actor._id, requestId }).select("+requestHash").session(session || null).lean();
      if (!prior) return false;
      if (prior.requestHash !== requestHash) throw generateError("Request id already used for another retention change", 409);
      entityId = prior.entityId; entityType = prior.entityType; replayed = true; return true;
    };
    try { await mongoose.connection.transaction(async (session) => {
      if (await replay(session)) return;
      if (!(await authorizedRetentionPeople(company, session, [actor._id])).length) throw generateError("Retention management permission is no longer available", 403);
      const policy = await retentionPolicy(company, session);
      let before: any, after: any;
      if (kind === "policy") {
        if (policy.revision !== revision) throw generateError("Retention policy changed. Reload first.", 409);
        before = policy;
        after = revision === 0 ? (await Policy.create([{ company, enabled: input.enabled, retentionDays: input.retentionDays, updatedBy: actor._id }], { session }))[0]
          : await Policy.findOneAndUpdate({ company, revision }, { $set: { enabled: input.enabled, retentionDays: input.retentionDays, updatedBy: actor._id }, $inc: { revision: 1 } }, { session, new: true });
        if (!after) throw generateError("Retention policy changed. Reload first.", 409);
        entityId = after._id; entityType = "policy"; after = policyDto(after);
      } else if (kind === "clock" || kind === "hold") {
        const { doc, parent, linked } = await fileContext(company, target, session);
        before = documentDto(doc, linked, policy, parent);
        if (before.revision !== revision || !before.canChangeHold) throw generateError("Document changed or erasure already started. Reload first.", 409);
        if (kind === "clock" && !before.canStartClock) throw generateError("Only an unlinked document without a retention clock can start one", 409);
        if (kind === "clock") await fenceUnlinked(company, doc, session);
        const changed = await Document.updateOne({ _id: target, company, $and: [attachedDocument, sameRevision(revision)] }, { $set: kind === "clock" ? { retentionRemovedAt: new Date() } : { retentionHold: { active: input.active, reason, changedBy: actor._id, changedAt: new Date() } }, $inc: { retentionRevision: 1 } }, { session });
        if (!changed.matchedCount) throw generateError("Document changed. Reload first.", 409);
        entityId = target; entityType = "document"; after = { revision: revision + 1, ...(kind === "hold" ? { holdActive: input.active } : { clockStarted: true }) };
      } else if (kind === "create") {
        if (!policy.enabled || policy.revision !== revision) throw generateError("Enable and reload the current retention policy first", 409);
        const operators = await authorizedRetentionPeople(company, session), approvers = operators.filter((person) => String(person._id) !== String(actor._id));
        if (!approvers.length) throw generateError("A second active Company Admin or HR Admin with onboarding management access is required", 422);
        const policyFence = await Policy.updateOne({ company, revision, enabled: true }, { $inc: { executionFence: 1 } }, { session, timestamps: false });
        if (!policyFence.matchedCount) throw generateError("Retention policy changed. Reload first.", 409);
        entityId = new mongoose.Types.ObjectId(); entityType = "erasure_request";
        const items: any[] = [];
        for (const entry of input.documents) {
          const { doc, parent, linked } = await fileContext(company, entry.documentId, session), preview = documentDto(doc, linked, policy, parent);
          if (!preview.eligible || preview.revision !== entry.revision || !/^[a-f0-9]{64}$/i.test(doc.sha256)) throw generateError("A selected document changed or is not eligible. Reload the inventory.", 409);
          await fenceUnlinked(company, doc, session);
          const reserved = await Document.updateOne({ _id: doc._id, company, erasureRequest: null, "retentionHold.active": { $ne: true }, $and: [attachedDocument, sameRevision(entry.revision)] }, { $set: { erasureRequest: entityId }, $inc: { retentionRevision: 1 } }, { session });
          if (!reserved.matchedCount) throw generateError("A selected document changed. Reload the inventory.", 409);
          items.push({ document: doc._id, name: doc.name, size: doc.size, sha256: doc.sha256, removedAt: doc.retentionRemovedAt, revision: entry.revision + 1 });
        }
        after = (await Request.create([{ _id: entityId, company, requestedBy: actor._id, requesterName: actor.name || "HR", reason, policyRevision: revision, retentionDays: policy.retentionDays, items, expiresAt: new Date(Date.now() + 7 * retentionDay) }], { session }))[0];
        await notifyRetention(after, approvers.map((person) => person._id), "requested", `${after.requesterName} requested content erasure for ${items.length} removed onboarding document(s). Independent approval is required.`, session);
        after = erasureDto(after, actor);
      } else {
        const record: any = await Request.findOne({ _id: target, company }).session(session).lean();
        if (!record) throw generateError("Erasure request not found", 404);
        if (record.revision !== revision) throw generateError("Erasure request changed. Reload first.", 409);
        before = erasureDto(record, actor); entityId = target; entityType = "erasure_request";
        const changes: any = { decisionReason: reason };
        if (kind === "retry") {
          if (!record.active || record.status !== "failed") throw generateError("Only a failed approved erasure can be retried", 409);
          Object.assign(changes, { status: "approved", failures: 0, error: "", nextAttemptAt: null, lease: null, leaseUntil: null });
        } else {
          if (record.status !== "awaiting_approval") throw generateError("Only requests awaiting approval can be decided or withdrawn", 409);
          const own = String(record.requestedBy) === String(actor._id);
          if (kind === "withdraw" ? !own : own) throw generateError(kind === "withdraw" ? "Only the requester can withdraw this request" : "Another administrator must decide this request", 403);
          if (kind === "decision" && input.decision === "approve") {
            if (new Date(record.expiresAt).getTime() <= Date.now()) throw generateError("Request expired. Reject it and create a fresh request.", 409);
            if (!policy.enabled || policy.revision !== record.policyRevision) throw generateError("Retention policy changed. Reject and recreate this request.", 409);
            if (!(await authorizedRetentionPeople(company, session, [record.requestedBy])).length) throw generateError("The requester no longer has retention management access", 409);
            const policyFence = await Policy.updateOne({ company, revision: policy.revision, enabled: true }, { $inc: { executionFence: 1 } }, { session, timestamps: false });
            if (!policyFence.matchedCount) throw generateError("Retention policy changed. Reload first.", 409);
            for (const item of record.items) {
              const { doc, parent, linked } = await fileContext(company, item.document, session);
              const preview = documentDto({ ...doc, erasureRequest: null }, linked, policy, parent);
              if (!preview.eligible || String(doc.erasureRequest) !== String(record._id) || preview.revision !== item.revision || doc.sha256 !== item.sha256) throw generateError("Selected documents changed. Reject and recreate this request.", 409);
              await fenceUnlinked(company, doc, session);
            }
            Object.assign(changes, { status: "approved", approvedBy: actor._id, approverName: actor.name || "HR", approvedAt: new Date(), approvalExpiresAt: new Date(Date.now() + retentionDay) });
          } else {
            Object.assign(changes, { status: kind === "withdraw" ? "cancelled" : "rejected", active: false, completedAt: new Date() });
            await Document.updateMany({ company, erasureRequest: record._id, ...attachedDocument }, { $set: { erasureRequest: null }, $inc: { retentionRevision: 1 } }, { session });
          }
        }
        after = await Request.findOneAndUpdate({ _id: target, company, revision }, { $set: changes, $inc: { revision: 1 } }, { session, new: true });
        if (!after) throw generateError("Erasure request changed. Reload first.", 409);
        await notifyRetention(after, [record.requestedBy], changes.status, `Removed onboarding document erasure is now ${changes.status.replace(/_/g, " ")}.`, session);
        after = erasureDto(after, actor);
      }
      await retentionAudit(company, entityType, entityId, kind === "decision" ? input.decision : kind, reason, session, { actor: actor._id, actorName: actor.name || "HR", requestId, requestHash, before, after });
    }); } catch (error: any) {
      if (error.code !== 11000) throw error;
      if (!await replay()) throw generateError("Retention data changed. Reload first.", 409);
    }
    // Replays return current state rather than restoring an old approval or hold snapshot.
    let data: any;
    if (entityType === "policy") data = await retentionPolicy(company);
    else if (entityType === "document") { const value = await fileContext(company, entityId); data = documentDto(value.doc, value.linked, await retentionPolicy(company), value.parent); }
    else data = erasureDto(await Request.findOne({ _id: entityId, company }).lean(), actor);
    res.json({ success: true, data, replayed });
  } catch (error) { next(error); }
};
