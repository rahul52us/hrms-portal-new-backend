import mongoose, { Schema } from "mongoose";

const job = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  key: { type: String, required: true, immutable: true },
  active: { type: Boolean, default: true },
  status: { type: String, enum: ["queued", "running", "failed", "complete"], default: "queued" },
  from: { type: String, required: true, immutable: true }, to: { type: String, required: true, immutable: true },
  referenceAt: { type: Date, required: true, immutable: true },
  changedSince: { type: Date, required: true, immutable: true },
  requestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
  cursor: { type: Schema.Types.Mixed, default: { phase: 0 } },
  metrics: { type: Schema.Types.Mixed, default: { employees: 0, notifications: 0, reconciliations: 0 } },
  lease: String, leaseUntil: Date, nextAttemptAt: Date,
  attempts: { type: Number, default: 0 }, failures: { type: Number, default: 0 },
  error: { type: String, maxlength: 1000 }, completedAt: Date,
}, { timestamps: true });
job.index({ company: 1, key: 1 }, { unique: true });
job.index({ company: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
job.index({ active: 1, status: 1, nextAttemptAt: 1, leaseUntil: 1 });
job.index({ completedAt: 1 }, { expireAfterSeconds: 15552000 });
const state = new Schema({ company: { type: Schema.Types.ObjectId, required: true, unique: true }, reconciledThrough: Date }, { timestamps: true });
const event = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  attendanceDate: { type: String, required: true, immutable: true },
  timesheet: { type: Schema.Types.ObjectId, ref: "Timesheet", required: true, immutable: true },
  revision: { type: Number, required: true, immutable: true },
  fingerprint: { type: String, required: true, immutable: true },
  savedRequiredMinutes: { type: Number, immutable: true }, currentRequiredMinutes: { type: Number, immutable: true },
  sourceReferences: { type: Schema.Types.Mixed, immutable: true },
  message: { type: String, required: true, immutable: true },
  resolvedAt: { type: Date, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });
event.index({ company: 1, timesheet: 1, revision: 1, fingerprint: 1 }, { unique: true });
event.index({ company: 1, employee: 1, attendanceDate: 1, createdAt: -1 });
export const TimesheetAutomationJob = mongoose.models.TimesheetAutomationJob || mongoose.model("TimesheetAutomationJob", job);
export const TimesheetAutomationState = mongoose.models.TimesheetAutomationState || mongoose.model("TimesheetAutomationState", state);
export const TimesheetContextEvent = mongoose.models.TimesheetContextEvent || mongoose.model("TimesheetContextEvent", event);
