import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  attendanceDate: { type: String, required: true, immutable: true },
  control: { type: Schema.Types.ObjectId, ref: "TimesheetDayControl", required: true, immutable: true },
  revision: { type: Number, required: true, min: 1, immutable: true },
  action: { type: String, enum: ["grant_exemption", "extend_deadline", "revoke_exemption", "revoke_extension"], required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  actorNameSnapshot: { type: String, required: true, immutable: true },
  reason: { type: String, required: true, maxlength: 500, immutable: true },
  requestId: { type: String, required: true, immutable: true },
  requestHash: { type: String, required: true, immutable: true },
  before: { type: Schema.Types.Mixed, required: true, immutable: true },
  after: { type: Schema.Types.Mixed, required: true, immutable: true },
  contextSnapshot: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ company: 1, employee: 1, attendanceDate: 1, revision: 1 }, { unique: true });
schema.index({ company: 1, employee: 1, attendanceDate: 1, requestId: 1 }, { unique: true });
export default mongoose.models.TimesheetAuditLog || mongoose.model("TimesheetAuditLog", schema);
