import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  template: { type: Schema.Types.ObjectId, ref: "OnboardingTemplate", required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  action: { type: String, enum: ["created", "updated", "published", "discarded", "archived", "restored"], required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true },
  requestHash: { type: String, required: true, immutable: true },
  reason: { type: String, required: true, immutable: true },
  before: { type: Schema.Types.Mixed, default: null, immutable: true },
  after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ company: 1, actor: 1, requestId: 1 }, { unique: true });
schema.index({ company: 1, template: 1, createdAt: -1, _id: -1 });
schema.pre("save", function (next) { next(this.isNew ? undefined : new Error("Onboarding audit history is append-only")); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  schema.pre(operation as any, function (next: any) { next(new Error("Onboarding audit history is append-only")); });
}
export default mongoose.models.OnboardingTemplateAudit || mongoose.model("OnboardingTemplateAudit", schema);
