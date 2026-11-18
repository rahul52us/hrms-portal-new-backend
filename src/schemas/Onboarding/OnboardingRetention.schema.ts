import mongoose, { Schema } from "mongoose";

const policy = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, unique: true, immutable: true },
  enabled: { type: Boolean, default: false, required: true },
  retentionDays: { type: Number, default: 365, min: 1, max: 36500, required: true },
  revision: { type: Number, default: 1, required: true },
  executionFence: { type: Number, default: 0, select: false },
  updatedBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
const item = new Schema({
  document: { type: Schema.Types.ObjectId, required: true }, name: { type: String, required: true }, size: Number,
  sha256: { type: String, required: true }, removedAt: { type: Date, required: true }, revision: { type: Number, required: true },
  status: { type: String, enum: ["reserved", "erasing", "erased", "skipped"], default: "reserved" },
  detail: { type: String, default: "" }, erasedAt: Date,
}, { _id: false });
const request = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  requestedBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, requesterName: { type: String, required: true, immutable: true },
  reason: { type: String, required: true, immutable: true },
  policyRevision: { type: Number, required: true, immutable: true }, retentionDays: { type: Number, required: true, immutable: true },
  items: { type: [item], required: true, validate: (items: any[]) => items.length > 0 && items.length <= 50 },
  status: { type: String, enum: ["awaiting_approval", "approved", "running", "failed", "completed", "rejected", "cancelled"], default: "awaiting_approval" },
  revision: { type: Number, default: 1 }, active: { type: Boolean, default: true },
  approvedBy: { type: Schema.Types.ObjectId, default: null }, approverName: String, approvedAt: Date, approvalExpiresAt: Date,
  decisionReason: String, expiresAt: { type: Date, required: true },
  cursor: { type: Number, default: 0 }, erasedCount: { type: Number, default: 0 }, skippedCount: { type: Number, default: 0 },
  lease: { type: String, select: false }, leaseUntil: Date, nextAttemptAt: Date,
  failures: { type: Number, default: 0 }, attempts: { type: Number, default: 0 }, error: { type: String, default: "" }, completedAt: Date,
}, { timestamps: true });
request.index({ company: 1, createdAt: -1, _id: -1 });
request.index({ active: 1, status: 1, nextAttemptAt: 1, leaseUntil: 1 });
request.index({ active: 1, status: 1, expiresAt: 1 });
const audit = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  entityType: { type: String, enum: ["policy", "document", "erasure_request"], required: true, immutable: true },
  entityId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, default: null, immutable: true }, actorName: { type: String, required: true, immutable: true },
  action: { type: String, required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  requestId: { type: String, immutable: true }, requestHash: { type: String, immutable: true, select: false },
  before: { type: Schema.Types.Mixed, immutable: true }, after: { type: Schema.Types.Mixed, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
audit.index({ company: 1, actor: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: "string" } } });
audit.index({ company: 1, createdAt: -1, _id: -1 });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  audit.pre(operation as any, function(next) { next(new Error("Onboarding retention audit is append-only")); });
}
export const OnboardingRetentionPolicy = mongoose.models.OnboardingRetentionPolicy || mongoose.model("OnboardingRetentionPolicy", policy);
export const OnboardingErasureRequest = mongoose.models.OnboardingErasureRequest || mongoose.model("OnboardingErasureRequest", request);
export const OnboardingRetentionAudit = mongoose.models.OnboardingRetentionAudit || mongoose.model("OnboardingRetentionAudit", audit);
