import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  code: { type: String, required: true, immutable: true, match: /^[A-Z][A-Z0-9_]{1,29}$/ },
  description: { type: String, trim: true, maxlength: 1000, default: "" },
  status: { type: String, enum: ["active", "archived"], default: "active", required: true },
  latestVersionNumber: { type: Number, default: 1, required: true },
  revision: { type: Number, default: 1, required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  archivedAt: { type: Date, default: null },
  archivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  archiveReason: { type: String, default: "" },
}, { timestamps: true });
schema.index({ company: 1, code: 1 }, { unique: true });
schema.index({ company: 1, status: 1, name: 1, _id: 1 });
export default mongoose.models.TimesheetPolicy || mongoose.model("TimesheetPolicy", schema);
