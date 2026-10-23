import mongoose, { Schema } from "mongoose";

const ProjectSchema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  code: { type: String, required: true, uppercase: true, immutable: true, match: /^[A-Z][A-Z0-9_]{1,29}$/ },
  description: { type: String, trim: true, maxlength: 1000, default: "" },
  managers: {
    type: [{ type: Schema.Types.ObjectId, ref: "User" }], required: true,
    validate: { validator: (ids: unknown[]) => ids.length > 0 && ids.length <= 20, message: "Select 1 to 20 project managers" },
  },
  startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  endDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
  status: { type: String, enum: ["active", "archived"], default: "active", required: true },
  revision: { type: Number, required: true, default: 1, min: 1 },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  archivedAt: { type: Date, default: null },
  archivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  archiveReason: { type: String, default: "" },
}, { timestamps: true });

ProjectSchema.index({ company: 1, code: 1 }, { unique: true });
ProjectSchema.index({ company: 1, status: 1, name: 1, _id: 1 });
ProjectSchema.index({ company: 1, managers: 1, status: 1 });

const Project = mongoose.models.Project || mongoose.model("Project", ProjectSchema);
export default Project;
