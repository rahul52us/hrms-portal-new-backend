import mongoose, { Schema } from "mongoose";
import { contentFields } from "./OnboardingTemplate.schema";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  template: { type: Schema.Types.ObjectId, ref: "OnboardingTemplate", required: true, immutable: true },
  version: { type: Number, required: true, min: 1, immutable: true },
  content: { type: new Schema(contentFields, { _id: false }), required: true, immutable: true },
  publishedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  reason: { type: String, required: true, maxlength: 500, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ company: 1, template: 1, version: 1 }, { unique: true });
schema.pre("save", function (next) { next(this.isNew ? undefined : new Error("Published onboarding versions are immutable")); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  schema.pre(operation as any, function (next: any) { next(new Error("Published onboarding versions are immutable")); });
}
export default mongoose.models.OnboardingTemplateVersion || mongoose.model("OnboardingTemplateVersion", schema);
