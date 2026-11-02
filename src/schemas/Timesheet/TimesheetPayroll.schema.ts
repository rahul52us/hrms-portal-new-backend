import mongoose, { Schema } from "mongoose";
const input = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  attendancePayrollInput: { type: Schema.Types.ObjectId, ref: "AttendancePayrollInput", required: true, immutable: true },
  periodKey: { type: String, required: true, immutable: true },
  startDate: { type: String, required: true, immutable: true }, endDate: { type: String, required: true, immutable: true },
  status: { type: String, enum: ["locking", "failed", "locked", "cancelling", "cancelled"], default: "locking" },
  active: { type: Boolean, default: true }, version: { type: Number, default: 1, immutable: true }, revision: { type: Number, default: 1 }, cursor: Schema.Types.ObjectId,
  employeeCount: { type: Number, default: 0 }, additionalLopDays: { type: Number, default: 0 },
  actor: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  reason: { type: String, required: true, immutable: true }, requestId: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, immutable: true },
  lease: String, leaseUntil: Date, error: String, failures: { type: Number, default: 0 }, nextAttemptAt: Date,
  lockedAt: Date, consumedBy: { type: Schema.Types.ObjectId, ref: "PayrollRun", default: null }, cancelledAt: Date, cancelledBy: Schema.Types.ObjectId, cancellationReason: String,
}, { timestamps: true });
input.index({ company: 1, periodKey: 1, version: 1 }, { unique: true });
input.index({ company: 1, periodKey: 1 }, { unique: true, partialFilterExpression: { active: true } });
input.index({ company: 1, requestId: 1 }, { unique: true });
input.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
const employee = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  input: { type: Schema.Types.ObjectId, ref: "TimesheetPayrollInput", required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  employeeNameSnapshot: { type: String, required: true, immutable: true }, employeeCodeSnapshot: { type: String, immutable: true },
  daily: { type: [Schema.Types.Mixed], required: true, immutable: true },
  additionalLopDays: { type: Number, required: true, immutable: true },
  sourceHash: { type: String, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
employee.index({ company: 1, input: 1, employee: 1 }, { unique: true });
employee.index({ company: 1, employee: 1, "daily.attendanceDate": 1, createdAt: -1 });
const correction = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  sourceInput: { type: Schema.Types.ObjectId, ref: "TimesheetPayrollInput", required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  reason: { type: String, required: true, immutable: true },
  attendanceDate: { type: String, required: true, immutable: true },
  status: { type: String, enum: ["open", "settled"], default: "open" },
  original: { type: Schema.Types.Mixed, required: true, immutable: true },
  revised: Schema.Types.Mixed, signedLopDelta: Number,
  amountMinor: Number, settlementEvidence: Schema.Types.Mixed,
  settlementAttempts: { type: Number, default: 0, min: 0, max: 50 }, routingCancelled: { type: Boolean, default: false },
  payrollRun: { type: Schema.Types.ObjectId, ref: "PayrollRun", default: null },
  payrollOneTimeInput: { type: Schema.Types.ObjectId, ref: "PayrollOneTimeInput", default: null },
  settledBy: { type: Schema.Types.ObjectId, ref: "User", default: null }, settledAt: Date,
}, { timestamps: true });
correction.index({ company: 1, requestId: 1 }, { unique: true });
correction.index({ company: 1, createdAt: -1 });
correction.index({ company: 1, sourceInput: 1, employee: 1, status: 1 });
correction.index({ company: 1, employee: 1, attendanceDate: 1 }, { unique: true, partialFilterExpression: { status: "open" } });
export const TimesheetPayrollInput = mongoose.models.TimesheetPayrollInput || mongoose.model("TimesheetPayrollInput", input);
export const TimesheetPayrollEmployeeInput = mongoose.models.TimesheetPayrollEmployeeInput || mongoose.model("TimesheetPayrollEmployeeInput", employee);
export const TimesheetPayrollCorrection = mongoose.models.TimesheetPayrollCorrection || mongoose.model("TimesheetPayrollCorrection", correction);
