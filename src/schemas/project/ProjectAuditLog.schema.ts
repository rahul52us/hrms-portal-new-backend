import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  project: { type: Schema.Types.ObjectId, ref: "Project", required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  action: { type: String, required: true, immutable: true },
  entityId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  reason: { type: String, required: true, immutable: true },
  before: { type: Schema.Types.Mixed, default: null, immutable: true },
  after: { type: Schema.Types.Mixed, default: null, immutable: true },
  projectRevision: { type: Number, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ company: 1, project: 1, createdAt: -1, _id: -1 });
export default mongoose.models.ProjectAuditLog || mongoose.model("ProjectAuditLog", schema);
