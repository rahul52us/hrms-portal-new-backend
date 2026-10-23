import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  project: { type: Schema.Types.ObjectId, ref: "Project", required: true, immutable: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  code: { type: String, required: true, immutable: true, match: /^[A-Z][A-Z0-9_]{1,29}$/ },
  status: { type: String, enum: ["active", "archived"], default: "active", required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  archivedAt: { type: Date, default: null },
}, { timestamps: true });

schema.index({ company: 1, project: 1, code: 1 }, { unique: true });
schema.index({ company: 1, project: 1, name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });
schema.index({ company: 1, project: 1, status: 1, name: 1, _id: 1 });
export default mongoose.models.ProjectWorkType || mongoose.model("ProjectWorkType", schema);
