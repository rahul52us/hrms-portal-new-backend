import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  timesheet: { type: Schema.Types.ObjectId, ref: "Timesheet", required: true, immutable: true },
  attendanceDate: { type: String, required: true, immutable: true },
  revision: { type: Number, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true },
  requestHash: { type: String, required: true, immutable: true },
  action: { type: String, required: true, default: "draft_saved", immutable: true },
  actor: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  snapshot: { type: Schema.Types.Mixed, required: true, immutable: true },
  actionEvidence: { type: Schema.Types.Mixed, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ company: 1, timesheet: 1, revision: 1 }, { unique: true });
schema.index({ company: 1, employee: 1, attendanceDate: 1, requestId: 1 }, { unique: true });
export default mongoose.models.TimesheetRevision || mongoose.model("TimesheetRevision", schema);
