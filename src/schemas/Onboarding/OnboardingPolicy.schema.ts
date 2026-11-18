import mongoose, { Schema } from "mongoose";

export const policyContent = {
  name: { type: String, required: true, maxlength: 150 },
  description: { type: String, default: "", maxlength: 2000 },
  body: { type: String, required: true, maxlength: 40000 },
  acknowledgementText: { type: String, required: true, maxlength: 1000 },
};
const policy = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  ...policyContent,
  nameKey: { type: String, required: true },
  status: { type: String, enum: ["draft", "published", "archived"], default: "draft" },
  hasDraft: { type: Boolean, default: true }, publishedVersion: { type: Number, default: 0 },
  revision: { type: Number, default: 1 }, assignmentFence: { type: Number, default: 0, select: false },
  createdBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, updatedBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
policy.index({ company: 1, nameKey: 1 }, { unique: true });
policy.index({ company: 1, status: 1, updatedAt: -1, _id: -1 });
const version = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  policy: { type: Schema.Types.ObjectId, required: true, immutable: true },
  version: { type: Number, required: true, min: 1, immutable: true },
  content: { type: new Schema(policyContent, { _id: false }), required: true, immutable: true },
  contentHash: { type: String, required: true, immutable: true },
  publishedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  reason: { type: String, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
version.index({ company: 1, policy: 1, version: 1 }, { unique: true });
const audit = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  policy: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true }, actorName: { type: String, required: true, immutable: true },
  action: { type: String, required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, immutable: true, select: false },
  before: { type: Schema.Types.Mixed, immutable: true }, after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
audit.index({ company: 1, actor: 1, requestId: 1 }, { unique: true });
audit.index({ company: 1, policy: 1, createdAt: -1, _id: -1 });
const receipt = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  onboarding: { type: Schema.Types.ObjectId, required: true, immutable: true },
  task: { type: Schema.Types.ObjectId, required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, required: true, immutable: true }, employeeName: { type: String, required: true, immutable: true }, employeeCode: { type: String, immutable: true },
  policy: { type: Schema.Types.ObjectId, required: true, immutable: true }, policyVersion: { type: Schema.Types.ObjectId, required: true, immutable: true },
  policyName: { type: String, required: true, immutable: true }, version: { type: Number, required: true, immutable: true },
  contentHash: { type: String, required: true, immutable: true }, statement: { type: String, required: true, immutable: true },
  cycle: { type: Number, required: true, min: 1, immutable: true }, acknowledgedAt: { type: Date, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
receipt.index({ company: 1, onboarding: 1, task: 1, cycle: 1 }, { unique: true });
receipt.index({ company: 1, employee: 1, acknowledgedAt: -1 });

// Evidence and published text are append-only; reopening creates a new cycle, never edits a receipt.
for (const [schema, message] of [[version, "Published onboarding policies are immutable"], [audit, "Onboarding policy audit is append-only"], [receipt, "Policy acknowledgement receipts are immutable"]] as const) {
  const immutableSchema = schema as Schema;
  immutableSchema.pre("save", function(this: any, next: any) { next(this.isNew ? undefined : new Error(message)); });
  for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
    immutableSchema.pre(operation as any, function(next) { next(new Error(message)); });
  }
}
export const OnboardingPolicy = mongoose.models.OnboardingPolicy || mongoose.model("OnboardingPolicy", policy);
export const OnboardingPolicyVersion = mongoose.models.OnboardingPolicyVersion || mongoose.model("OnboardingPolicyVersion", version);
export const OnboardingPolicyAudit = mongoose.models.OnboardingPolicyAudit || mongoose.model("OnboardingPolicyAudit", audit);
export const OnboardingPolicyAcknowledgement = mongoose.models.OnboardingPolicyAcknowledgement || mongoose.model("OnboardingPolicyAcknowledgement", receipt);
