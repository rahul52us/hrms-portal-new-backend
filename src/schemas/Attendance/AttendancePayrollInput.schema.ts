import mongoose, { Document, Schema } from "mongoose";

export interface AttendancePayrollInputI extends Document {
  company: mongoose.Types.ObjectId;
  attendancePeriod: mongoose.Types.ObjectId;
  periodKey: string;
  cycleStartDate: string;
  cycleEndDate: string;
  attendanceCutoffDay: number;
  version: number;
  attendancePeriodVersion: number;
  summaryCount: number;
  adjustmentCount: number;
  totals: Record<string, number>;
  reason: string;
  status: "locked";
  lockedAt: Date;
  lockedBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

const AttendancePayrollInputSchema = new Schema<AttendancePayrollInputI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    attendancePeriod: { type: Schema.Types.ObjectId, ref: "AttendancePeriod", required: true, index: true, immutable: true },
    periodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true, immutable: true },
    cycleStartDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, immutable: true },
    cycleEndDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, immutable: true },
    attendanceCutoffDay: { type: Number, required: true, min: 1, max: 31, immutable: true },
    version: { type: Number, required: true, min: 1, immutable: true },
    attendancePeriodVersion: { type: Number, required: true, min: 1, immutable: true },
    summaryCount: { type: Number, required: true, min: 0, immutable: true },
    adjustmentCount: { type: Number, required: true, min: 0, immutable: true },
    totals: { type: Schema.Types.Mixed, required: true, default: {}, immutable: true },
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 1000, immutable: true },
    status: { type: String, enum: ["locked"], required: true, default: "locked", immutable: true },
    lockedAt: { type: Date, required: true, immutable: true },
    lockedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AttendancePayrollInputSchema.index({ company: 1, periodKey: 1, version: 1 }, { unique: true });
AttendancePayrollInputSchema.index({ company: 1, periodKey: 1 }, { unique: true });
AttendancePayrollInputSchema.index(
  { company: 1, periodKey: 1, attendancePeriodVersion: 1 },
  { unique: true }
);
AttendancePayrollInputSchema.index({ company: 1, lockedAt: -1 });

const AttendancePayrollInput =
  (mongoose.models.AttendancePayrollInput as mongoose.Model<AttendancePayrollInputI>) ||
  mongoose.model<AttendancePayrollInputI>("AttendancePayrollInput", AttendancePayrollInputSchema);

export default AttendancePayrollInput;
