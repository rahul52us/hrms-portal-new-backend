import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  employeeNameSnapshot: { type: String, required: true, immutable: true },
  employeeCodeSnapshot: { type: String, default: "", immutable: true },
  timesheet: { type: Schema.Types.ObjectId, ref: "Timesheet", required: true, immutable: true },
  attendanceDate: { type: String, required: true, immutable: true },
  submissionNumber: { type: Number, required: true, min: 1, immutable: true },
  sheetRevision: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ["submitted", "approved", "returned", "rejected", "withdrawn", "reopened"], required: true },
  snapshot: { type: Schema.Types.Mixed, required: true, immutable: true },
  loggedMinutes: { type: Number, required: true, min: 0, immutable: true },
  requiredMinutes: { type: Number, required: true, min: 0, immutable: true },
  shortfallMinutes: { type: Number, required: true, min: 0, immutable: true },
  approvalInstance: { type: Schema.Types.ObjectId, ref: "ApprovalInstance", required: true },
  currentApprovers: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
  participantIds: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
  reassignmentCount: { type: Number, default: 0, min: 0, max: 50 },
  submittedAt: { type: Date, required: true, immutable: true },
  approvalDeadlineAt: { type: Date, default: null, immutable: true },
  shortfallAcknowledged: { type: Boolean, required: true, immutable: true },
  history: { type: [{ action: { type: String, required: true }, actor: { type: Schema.Types.ObjectId, ref: "User" }, actorNameSnapshot: String, comment: String, reassignment: Schema.Types.Mixed, at: { type: Date, required: true } }], default: [] },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ company: 1, timesheet: 1, submissionNumber: 1 }, { unique: true });
schema.index({ company: 1, currentApprovers: 1, status: 1, submittedAt: -1 });
schema.index({ company: 1, employee: 1, submittedAt: -1 });
schema.index({ company: 1, status: 1, _id: 1 });
export default mongoose.models.TimesheetSubmission || mongoose.model("TimesheetSubmission", schema);
