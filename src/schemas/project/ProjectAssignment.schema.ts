import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  project: { type: Schema.Types.ObjectId, ref: "Project", required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  employeeNameSnapshot: { type: String, required: true, immutable: true },
  employeeCodeSnapshot: { type: String, default: "", immutable: true },
  effectiveFrom: { type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  effectiveTo: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
  status: { type: String, enum: ["assigned", "cancelled"], default: "assigned", required: true },
  changeReason: { type: String, required: true, minlength: 3, maxlength: 500, immutable: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  endedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  endedAt: { type: Date, default: null },
  endReason: { type: String, default: "", maxlength: 500 },
}, { timestamps: true });

schema.index({ company: 1, project: 1, employee: 1, effectiveFrom: 1 }, { unique: true, partialFilterExpression: { status: "assigned" } });
schema.index({ company: 1, employee: 1, status: 1, effectiveFrom: 1, effectiveTo: 1 });
schema.index({ company: 1, project: 1, status: 1, effectiveFrom: 1, _id: 1 });
export default mongoose.models.ProjectAssignment || mongoose.model("ProjectAssignment", schema);
