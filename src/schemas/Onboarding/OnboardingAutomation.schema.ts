import mongoose, { Schema } from "mongoose";

export const DEFAULT_ONBOARDING_AUTOMATION = {
  enabled: true, remindBeforeHours: 24, reminderEveryDays: 1, escalateAfterDays: 2, escalationEveryDays: 1,
};
const settings = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, unique: true, immutable: true },
  enabled: { type: Boolean, required: true, default: true },
  remindBeforeHours: { type: Number, required: true, min: 0, max: 168, default: 24 },
  reminderEveryDays: { type: Number, required: true, min: 1, max: 30, default: 1 },
  escalateAfterDays: { type: Number, required: true, min: 0, max: 30, default: 2 },
  escalationEveryDays: { type: Number, required: true, min: 1, max: 30, default: 1 },
  revision: { type: Number, required: true, min: 1, default: 1 },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });
const audit = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actorName: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true },
  requestHash: { type: String, required: true, immutable: true },
  reason: { type: String, required: true, immutable: true },
  before: { type: Schema.Types.Mixed, required: true, immutable: true },
  after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
audit.index({ company: 1, actor: 1, requestId: 1 }, { unique: true });
audit.index({ company: 1, createdAt: -1, _id: -1 });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  audit.pre(operation as any, function(next) { next(new Error("Onboarding automation audit is append-only")); });
}
const job = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  key: { type: String, required: true, immutable: true },
  source: { type: String, enum: ["scheduled", "manual"], required: true, immutable: true },
  requestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
  referenceAt: { type: Date, required: true, immutable: true },
  active: { type: Boolean, default: true, required: true },
  status: { type: String, enum: ["queued", "running", "failed", "complete"], default: "queued", required: true },
  cursorAfter: { type: Schema.Types.ObjectId, default: null },
  metrics: { type: Schema.Types.Mixed, default: { checklists: 0, tasks: 0, notifications: 0, escalations: 0, ownerIssues: 0, skipped: 0 } },
  attempts: { type: Number, default: 0 }, failures: { type: Number, default: 0 },
  lease: { type: String, select: false }, leaseUntil: Date, nextAttemptAt: Date,
  error: { type: String, default: "", maxlength: 1000 }, completedAt: Date,
}, { timestamps: true });
job.index({ company: 1, key: 1 }, { unique: true });
job.index({ company: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
job.index({ company: 1, createdAt: -1, _id: -1 });
job.index({ active: 1, status: 1, nextAttemptAt: 1, leaseUntil: 1 });
export const OnboardingAutomationSettings = mongoose.models.OnboardingAutomationSettings || mongoose.model("OnboardingAutomationSettings", settings);
export const OnboardingAutomationAudit = mongoose.models.OnboardingAutomationAudit || mongoose.model("OnboardingAutomationAudit", audit);
export const OnboardingAutomationJob = mongoose.models.OnboardingAutomationJob || mongoose.model("OnboardingAutomationJob", job);
