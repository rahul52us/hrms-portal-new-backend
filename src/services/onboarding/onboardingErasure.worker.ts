import { randomUUID } from "crypto";
import mongoose from "mongoose";
import cron from "node-cron";
import { erasePrivateDocument, privateDocumentKey } from "../storage/privateObjectStorage";
import { attachedDocument, authorizedRetentionPeople, Document, documentDto, fenceUnlinked, fileContext, notifyRetention, Policy, Request, retentionAudit, retentionPolicy } from "./onboardingRetention.utils";

const leaseDuration = 600000;
export function erasureWorkFilter(now = new Date()) {
  return { active: true, $or: [{ status: "approved" }, { status: "running", leaseUntil: { $lt: now } }, { status: "failed", failures: { $lt: 5 }, nextAttemptAt: { $lte: now } }] };
}
/** Only this transaction may cross the point of no return. No provider I/O runs in a retried transaction. */
async function claimItem(id: any, lease: string) {
  let claimed: any = null;
  await mongoose.connection.transaction(async (session) => {
    claimed = null;
    const record: any = await Request.findOne({ _id: id, active: true, lease, leaseUntil: { $gt: new Date() } }).session(session).lean();
    if (!record) return;
    if (record.cursor >= record.items.length) {
      await Request.updateOne({ _id: id, lease }, { $set: { status: "completed", active: false, completedAt: new Date(), lease: null, leaseUntil: null }, $inc: { revision: 1 } }, { session });
      await retentionAudit(record.company, "erasure_request", id, "completed", `${record.erasedCount} document(s) erased; ${record.skippedCount} skipped.`, session);
      await notifyRetention(record, [record.requestedBy, record.approvedBy], "completed", `Onboarding content erasure completed: ${record.erasedCount} erased; ${record.skippedCount} skipped.`, session);
      return;
    }
    const index = record.cursor, item = record.items[index];
    const doc: any = await Document.findOne({ _id: item.document, company: record.company }).session(session).lean();
    if (item.status === "erasing") {
      // Once claimed, recovery must finish even if a hold/permission/policy changes afterwards.
      if (!doc || doc.storageStatus !== "erasing" || String(doc.erasureRequest) !== String(id) || doc.sha256 !== item.sha256) throw new Error("Erasure journal mismatch; administrator investigation required");
      claimed = { doc, index }; return;
    }
    if (item.status !== "reserved") throw new Error("Invalid erasure cursor state");
    let issue = "";
    const policy = await retentionPolicy(record.company, session);
    if (!policy.enabled || policy.revision !== record.policyRevision) issue = "Retention policy disabled or changed";
    else if (!record.approvedBy || String(record.approvedBy) === String(record.requestedBy) || !record.approvalExpiresAt || new Date(record.approvalExpiresAt).getTime() <= Date.now()) issue = "Independent approval missing or expired";
    else if ((await authorizedRetentionPeople(record.company, session, [record.requestedBy, record.approvedBy])).length !== 2) issue = "Requester or approver access is no longer active";
    if (!issue && !doc) issue = "Document metadata missing";
    if (!issue) {
      const { parent, linked } = await fileContext(record.company, doc._id, session);
      const preview = documentDto({ ...doc, erasureRequest: null }, linked, policy, parent);
      if (!preview.eligible || doc.retentionRevision !== item.revision || String(doc.erasureRequest) !== String(id) || doc.sha256 !== item.sha256 || new Date(doc.retentionRemovedAt).getTime() !== new Date(item.removedAt).getTime()) issue = "Document changed, held, linked, or no longer eligible";
      else if (!["mongodb", "r2"].includes(doc.storageProvider || "mongodb")) issue = "Unknown storage provider";
    }
    if (issue) {
      await Document.updateOne({ _id: item.document, company: record.company, erasureRequest: id, ...attachedDocument }, { $set: { erasureRequest: null }, $inc: { retentionRevision: 1 } }, { session });
      await Request.updateOne({ _id: id, lease }, { $set: { [`items.${index}.status`]: "skipped", [`items.${index}.detail`]: issue, leaseUntil: new Date(Date.now() + leaseDuration) }, $inc: { cursor: 1, skippedCount: 1, revision: 1 } }, { session });
      await retentionAudit(record.company, "document", item.document, "skipped", issue, session, { after: { erasureRequest: id } });
      claimed = { skipped: true }; return;
    }
    // A policy write and parent/document writes serialize disable, hold, and checklist edits with the claim.
    const fenced = await Policy.updateOne({ company: record.company, enabled: true, revision: record.policyRevision }, { $inc: { executionFence: 1 } }, { session, timestamps: false });
    if (!fenced.matchedCount) throw new Error("Retention policy changed during erasure claim");
    await fenceUnlinked(record.company, doc, session);
    const reserved = await Document.updateOne({ _id: doc._id, company: record.company, erasureRequest: id, retentionRevision: item.revision, "retentionHold.active": { $ne: true }, ...attachedDocument }, { $set: { storageStatus: "erasing" }, $inc: { retentionRevision: 1 } }, { session });
    if (!reserved.matchedCount) throw new Error("Document changed during erasure claim");
    await Request.updateOne({ _id: id, lease }, { $set: { [`items.${index}.status`]: "erasing", leaseUntil: new Date(Date.now() + leaseDuration) }, $inc: { revision: 1 } }, { session });
    await retentionAudit(record.company, "document", doc._id, "erasure_started", "Independent approval verified. Content erasure is now irreversible in HRMS.", session, { after: { erasureRequest: id, approvedBy: record.approvedBy } });
    claimed = { doc: { ...doc, storageStatus: "erasing" }, index };
  });
  return claimed;
}
/** Preserve tombstone and audit; unset only content, using the raw collection to bypass immutable upload bytes. */
async function finishItem(id: any, lease: string, claimed: any) {
  const doc = claimed.doc;
  if (!["mongodb", "r2"].includes(doc.storageProvider || "mongodb")) throw new Error("Unknown storage provider");
  if (doc.storageProvider === "r2") {
    const expected = privateDocumentKey(String(doc.company), String(doc.onboarding), String(doc.task), String(doc._id));
    if (doc.storageKey !== expected) throw new Error("Invalid private storage namespace");
    await erasePrivateDocument(doc);
  }
  await mongoose.connection.transaction(async (session) => {
    const record: any = await Request.findOne({ _id: id, active: true, lease, cursor: claimed.index, leaseUntil: { $gt: new Date() } }).session(session).lean();
    if (!record || record.items[claimed.index]?.status !== "erasing") throw new Error("Erasure lease lost; journal recovery required");
    const now = new Date();
    const tombstone = await Document.collection.updateOne({ _id: doc._id, company: doc.company, erasureRequest: record._id, storageStatus: "erasing", sha256: doc.sha256 }, { $unset: { bytes: "" }, $set: { storageStatus: "erased", erasedAt: now }, $inc: { retentionRevision: 1 } }, { session });
    if (!tombstone.matchedCount) throw new Error("Erasure journal mismatch; administrator investigation required");
    await Request.updateOne({ _id: id, lease, cursor: claimed.index }, { $set: { [`items.${claimed.index}.status`]: "erased", [`items.${claimed.index}.erasedAt`]: now, leaseUntil: new Date(Date.now() + leaseDuration) }, $inc: { cursor: 1, erasedCount: 1, revision: 1 } }, { session });
    await retentionAudit(doc.company, "document", doc._id, "erased", "Stored file content erased; metadata retained.", session, { after: { erasureRequest: id, provider: doc.storageProvider || "mongodb", erasedAt: now } });
  });
}

/** Recover approved work with a lease; partial R2 outcomes are safe to retry against immutable object keys. */
export async function drainOnboardingErasure(id: any, budgetMs = 5000) {
  const lease = randomUUID();
  const record: any = await Request.findOneAndUpdate({ _id: id, ...erasureWorkFilter() }, { $set: { status: "running", lease, leaseUntil: new Date(Date.now() + leaseDuration), error: "" }, $inc: { attempts: 1, revision: 1 } }, { new: true }).lean();
  if (!record) return;
  try {
    const until = Date.now() + budgetMs;
    for (let step = 0; step < 10 && Date.now() < until; step++) {
      const claimed = await claimItem(id, lease);
      if (!claimed) return;
      if (!claimed.skipped) await finishItem(id, lease, claimed);
    }
    await Request.updateOne({ _id: id, active: true, lease }, { $set: { status: "approved", lease: null, leaseUntil: null }, $inc: { revision: 1 } });
  } catch {
    const failures = record.failures + 1;
    await mongoose.connection.transaction(async (session) => {
      const changed = await Request.updateOne({ _id: id, active: true, lease }, { $set: { status: "failed", lease: null, leaseUntil: null, error: "Erasure could not be completed or verified. Check storage and the audit history before retrying.", nextAttemptAt: new Date(Date.now() + Math.min(60, 2 ** failures) * 60000) }, $inc: { failures: 1, revision: 1 } }, { session });
      if (changed.matchedCount) {
        await retentionAudit(record.company, "erasure_request", id, "failed", "Erasure paused; the committed cursor and any irreversible claims are preserved.", session);
        await notifyRetention(record, [record.requestedBy, record.approvedBy], `failed-${failures}`, "Onboarding content erasure needs attention. Review the Document security tab before retrying.", session);
      }
    });
  }
}

/** Expired, unapproved requests release reservations but never delete content. */
async function expirePending() {
  const expired: any[] = await Request.find({ status: "awaiting_approval", active: true, expiresAt: { $lte: new Date() } }).select("_id").limit(25).lean();
  for (const entry of expired) await mongoose.connection.transaction(async (session) => {
    const record: any = await Request.findOneAndUpdate({ _id: entry._id, status: "awaiting_approval", expiresAt: { $lte: new Date() } }, { $set: { status: "cancelled", active: false, completedAt: new Date(), decisionReason: "Approval request expired" }, $inc: { revision: 1 } }, { session, new: true }).lean();
    if (!record) return;
    await Document.updateMany({ company: record.company, erasureRequest: record._id, ...attachedDocument }, { $set: { erasureRequest: null }, $inc: { retentionRevision: 1 } }, { session });
    await retentionAudit(record.company, "erasure_request", record._id, "expired", "Independent approval was not received within seven days. No content erased.", session);
  });
}
let started = false, running = false;
export async function runOnboardingErasureQueue(budgetMs = 15000) {
  if (running) return;
  running = true;
  try {
    await expirePending();
    const until = Date.now() + budgetMs;
    const records: any[] = await Request.find(erasureWorkFilter()).select("_id").sort({ updatedAt: 1, _id: 1 }).limit(10).lean();
    for (const record of records) { if (Date.now() >= until) break; await drainOnboardingErasure(record._id, Math.min(5000, until - Date.now())); }
  } finally { running = false; }
}
export function startOnboardingErasureWorker() {
  if (started || process.env.NODE_ENV === "test" || process.env.ONBOARDING_ERASURE_WORKER_ENABLED === "false") return false;
  started = true;
  cron.schedule("*/5 * * * *", () => { void runOnboardingErasureQueue().catch((error) => console.error("Onboarding erasure worker failed", error.message)); }, { timezone: "UTC" });
  return true;
}
