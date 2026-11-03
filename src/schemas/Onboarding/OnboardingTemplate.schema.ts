import mongoose, { Schema } from "mongoose";

export const TASK_OWNERS = ["employee", "reporting_manager", "hr", "specific_user"] as const;
export const taskSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 150 },
  instructions: { type: String, default: "", maxlength: 2000 },
  owner: { type: String, enum: TASK_OWNERS, required: true },
  ownerUser: { type: Schema.Types.ObjectId, ref: "User", default: null },
  ownerNameSnapshot: { type: String, default: "" },
  dueDays: { type: Number, required: true, min: -90, max: 365 },
  required: { type: Boolean, required: true },
  requiresDocument: { type: Boolean, required: true },
});
export const contentFields = {
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  description: { type: String, default: "", maxlength: 2000 },
  tasks: { type: [taskSchema], default: [] },
};
const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  ...contentFields,
  nameKey: { type: String, required: true },
  status: { type: String, enum: ["draft", "published", "archived"], default: "draft", required: true },
  hasDraft: { type: Boolean, default: true, required: true },
  publishedVersion: { type: Number, default: 0, required: true },
  revision: { type: Number, default: 1, required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });
schema.index({ company: 1, nameKey: 1 }, { unique: true });
schema.index({ company: 1, status: 1, updatedAt: -1, _id: -1 });
export default mongoose.models.OnboardingTemplate || mongoose.model("OnboardingTemplate", schema);
