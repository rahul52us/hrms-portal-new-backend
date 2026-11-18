import { ClientSession } from "mongoose";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import Document from "../../schemas/Onboarding/OnboardingDocument.schema";
import Instance from "../../schemas/Onboarding/EmployeeOnboarding.schema";
import { OnboardingRetentionPolicy as Policy, OnboardingErasureRequest as Request, OnboardingRetentionAudit as Audit } from "../../schemas/Onboarding/OnboardingRetention.schema";
import { generateError } from "../../config/Error/functions";
import { attachEffectivePermissions } from "../permissions/permission.utils";
import { canManageOnboardingAutomation } from "./onboardingAutomation.service";
import { upsertRequestNotifications } from "../notification/notification.service";
import { ACTIVE_USER_PASSWORD_MATCH } from "../auth/utils/userAccountStatus";

export { Policy, Request, Audit, Document, Instance };
export const retentionDay = 86400000;
export const attachedDocument = { $or: [{ storageStatus: "attached" }, { storageStatus: { $exists: false }, storageProvider: { $ne: "r2" } }] };
export const sameRevision = (revision: number) => revision === 0 ? { $or: [{ retentionRevision: 0 }, { retentionRevision: { $exists: false } }] } : { retentionRevision: revision };
export function policyDto(record: any) {
  return { enabled: record?.enabled ?? false, retentionDays: record?.retentionDays ?? 365, revision: record?.revision || 0, updatedAt: record?.updatedAt || null };
}
export async function retentionPolicy(company: any, session?: ClientSession) {
  return policyDto(await Policy.findOne({ company }).session(session || null).lean());
}
export async function authorizedRetentionPeople(company: any, session: ClientSession, ids?: any[]) {
  const organization: any = await Company.findOne({ _id: company, is_active: true, deletedAt: null }).select("rolePermissions").session(session).lean();
  if (!organization) return [];
  const people: any[] = [];
  let after: any = null;
  for (;;) {
    const batch: any[] = await User.find({ company, role: { $in: ["admin", "hradmin"] }, is_enabled: { $ne: false }, deletedAt: null, password: ACTIVE_USER_PASSWORD_MATCH,
      ...(ids ? { _id: { $in: ids } } : after ? { _id: { $gt: after } } : {}) })
      .select("_id company name code role accessRole permissions permissionOverrides").sort({ _id: 1 }).limit(100).session(session).lean();
    people.push(...batch.filter((user) => canManageOnboardingAutomation(attachEffectivePermissions({ user, company: organization }))));
    if (batch.length < 100 || ids) return people;
    after = batch[batch.length - 1]._id;
  }
}
export function documentDto(doc: any, linked: boolean, policy: ReturnType<typeof policyDto>, parent: any = null) {
  const issues: string[] = [], removedAt = doc.retentionRemovedAt || null;
  if (linked) issues.push("Still linked to a checklist");
  if (!parent) issues.push("Parent checklist missing");
  if (!removedAt) issues.push("Retention clock not started");
  else if (new Date(removedAt).getTime() + policy.retentionDays * retentionDay > Date.now()) issues.push("Retention period has not ended");
  if (doc.retentionHold?.active) issues.push("Legal hold");
  if (doc.erasureRequest) issues.push("Reserved for an erasure request");
  if (doc.storageStatus && doc.storageStatus !== "attached") issues.push(doc.storageStatus === "erased" ? "Content erased" : "Erasure already started");
  if (!policy.enabled) issues.push("Erasure policy disabled");
  return { _id: doc._id, name: doc.name, size: doc.size, provider: doc.storageProvider || "mongodb", status: doc.storageStatus || "attached",
    createdAt: doc.createdAt, removedAt, eligibleAt: removedAt ? new Date(new Date(removedAt).getTime() + policy.retentionDays * retentionDay) : null,
    revision: doc.retentionRevision || 0, hold: doc.retentionHold || { active: false }, linked, eligible: !issues.length, issues,
    employeeName: parent?.employeeNameSnapshot || "Unknown employee", employeeCode: parent?.employeeCodeSnapshot || "",
    canStartClock: !linked && Boolean(parent) && !removedAt && !doc.erasureRequest && (!doc.storageStatus || doc.storageStatus === "attached"),
    canChangeHold: !doc.storageStatus || doc.storageStatus === "attached" };
}
export async function fileContext(company: any, id: any, session?: ClientSession) {
  const doc: any = await Document.findOne({ _id: id, company }).session(session || null).lean();
  if (!doc) throw generateError("Onboarding document not found", 404);
  const parent: any = await Instance.findOne({ _id: doc.onboarding, company }).select("employeeNameSnapshot employeeCodeSnapshot").session(session || null).lean();
  const linked = Boolean(await Instance.exists({ company, "tasks.documents.document": doc._id }).session(session || null));
  return { doc, parent, linked };
}
/** A parent write coordinates with normal task edits before an irreversible erasure claim. */
export async function fenceUnlinked(company: any, doc: any, session: ClientSession) {
  if (await Instance.exists({ company, "tasks.documents.document": doc._id }).session(session)) throw generateError("Linked documents cannot be erased", 409);
  const result = await Instance.updateOne({ _id: doc.onboarding, company, "tasks.documents.document": { $ne: doc._id } }, { $inc: { retentionFence: 1 } }, { session, timestamps: false });
  if (!result.matchedCount) throw generateError("The parent checklist changed or is missing", 409);
}
export function erasureDto(record: any, actor: any, details = true) {
  const pending = record.status === "awaiting_approval", own = String(record.requestedBy) === String(actor._id), expired = new Date(record.expiresAt).getTime() <= Date.now();
  const { _id, status, revision, requesterName, requestedBy, reason, policyRevision, retentionDays, approverName, approvedAt, approvalExpiresAt, decisionReason, expiresAt, erasedCount, skippedCount, error, createdAt, completedAt, attempts } = record;
  return { _id, status, revision, requesterName, requestedBy, reason, policyRevision, retentionDays, approverName, approvedAt, approvalExpiresAt, decisionReason, expiresAt,
    erasedCount, skippedCount, error, createdAt, completedAt, attempts, itemCount: record.items.length,
    canApprove: pending && !own && !expired, canReject: pending && !own, canWithdraw: pending && own, canRetry: record.active && record.status === "failed",
    ...(details ? { items: record.items.map((item: any) => ({ documentId: item.document, name: item.name, size: item.size, removedAt: item.removedAt, status: item.status, detail: item.detail, erasedAt: item.erasedAt })) } : {}) };
}
export async function retentionAudit(company: any, entityType: string, entityId: any, action: string, reason: string, session: ClientSession, extra: any = {}) {
  await Audit.create([{ company, entityType, entityId, actorName: "Retention worker", action, reason, ...extra }], { session });
}
export async function notifyRetention(record: any, recipients: any[], event: string, message: string, session: ClientSession) {
  await upsertRequestNotifications({ company: record.company, recipients, entityType: "onboarding_erasure", entityId: record._id,
    eventType: `onboarding.erasure.${event}`, title: event === "requested" ? "Document erasure approval required" : "Document erasure update", message,
    category: "system", priority: "high", actionUrl: "/dashboard/onboarding?tab=security", dedupeEventKey: `erasure:${record._id}:${event}:${record.revision}` }, session);
}
export function revisionNumber(value: any) {
  if (!Number.isSafeInteger(value) || value < 0) throw generateError("Load the current revision before saving", 422);
  return value as number;
}
