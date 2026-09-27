import mongoose, { Document, Schema } from "mongoose";

export const ATTENDANCE_PAYROLL_ADJUSTMENT_STATUSES = ["pending", "included", "superseded"] as const;

export interface AttendancePayrollAdjustmentI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  employeeNameSnapshot: string;
  employeeCodeSnapshot: string;
  sourcePeriodKey: string;
  targetPeriodKey: string;
  sourcePayrollInput: mongoose.Types.ObjectId;
  sourcePayrollInputVersion: number;
  correctedAttendancePeriodVersion: number;
  deltas: Record<string, number>;
  before: Record<string, number>;
  after: Record<string, number>;
  status: (typeof ATTENDANCE_PAYROLL_ADJUSTMENT_STATUSES)[number];
  includedInPayrollInput?: mongoose.Types.ObjectId | null;
  supersededByAdjustment?: mongoose.Types.ObjectId | null;
  createdBy: mongoose.Types.ObjectId;
  includedAt?: Date | null;
  supersededAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const AttendancePayrollAdjustmentSchema = new Schema<AttendancePayrollAdjustmentI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    employeeNameSnapshot: { type: String, required: true, trim: true },
    employeeCodeSnapshot: { type: String, required: true, trim: true },
    sourcePeriodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true },
    targetPeriodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true },
    sourcePayrollInput: { type: Schema.Types.ObjectId, ref: "AttendancePayrollInput", required: true, index: true },
    sourcePayrollInputVersion: { type: Number, required: true, min: 1 },
    correctedAttendancePeriodVersion: { type: Number, required: true, min: 1 },
    deltas: { type: Schema.Types.Mixed, required: true, default: {} },
    before: { type: Schema.Types.Mixed, required: true, default: {} },
    after: { type: Schema.Types.Mixed, required: true, default: {} },
    status: {
      type: String,
      enum: ATTENDANCE_PAYROLL_ADJUSTMENT_STATUSES,
      required: true,
      default: "pending",
      index: true,
    },
    includedInPayrollInput: { type: Schema.Types.ObjectId, ref: "AttendancePayrollInput", default: null, index: true },
    supersededByAdjustment: { type: Schema.Types.ObjectId, ref: "AttendancePayrollAdjustment", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    includedAt: { type: Date, default: null },
    supersededAt: { type: Date, default: null },
  },
  { timestamps: true }
);

AttendancePayrollAdjustmentSchema.index(
  { company: 1, sourcePeriodKey: 1, correctedAttendancePeriodVersion: 1, employee: 1 },
  { unique: true }
);
AttendancePayrollAdjustmentSchema.index({ company: 1, targetPeriodKey: 1, status: 1, employee: 1 });

const AttendancePayrollAdjustment =
  (mongoose.models.AttendancePayrollAdjustment as mongoose.Model<AttendancePayrollAdjustmentI>) ||
  mongoose.model<AttendancePayrollAdjustmentI>(
    "AttendancePayrollAdjustment",
    AttendancePayrollAdjustmentSchema
  );

export default AttendancePayrollAdjustment;
