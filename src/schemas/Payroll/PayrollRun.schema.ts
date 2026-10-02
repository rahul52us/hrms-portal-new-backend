import mongoose, { Document, Schema } from "mongoose";

export const PAYROLL_RUN_STATUSES = [
  "draft",
  "calculating",
  "review",
  "approved",
  "finalized",
  "failed",
  "cancelled",
] as const;

export interface PayrollRunI extends Document {
  company: mongoose.Types.ObjectId;
  companyNameSnapshot: string;
  companyCodeSnapshot: string;
  periodKey: string;
  cycleStartDate: string;
  cycleEndDate: string;
  attendancePayrollInput: mongoose.Types.ObjectId;
  attendancePayrollInputVersion: number;
  attendancePeriod: mongoose.Types.ObjectId;
  attendancePeriodVersion: number;
  attendanceCutoffDay: number;
  attendanceSummaryCount: number;
  attendanceAdjustmentCount: number;
  attendanceTotals: Record<string, unknown>;
  attendanceLockedAt: Date;
  attendanceLockedBy: mongoose.Types.ObjectId;
  attendanceInputStatus: "pending" | "prepared";
  employeeInputCount: number;
  employeeInputIssueCount: number;
  attendanceInputTotals: Record<string, number>;
  attendanceInputsPreparedAt?: Date | null;
  attendanceInputsPreparedBy?: mongoose.Types.ObjectId | null;
  oneTimeInputCount: number;
  oneTimeInputTotals: Record<string, number>;
  employeeSnapshotStatus: "pending" | "prepared";
  employeeSnapshotVersion: number;
  employeeSnapshotCount: number;
  employeeSnapshotIssueCount: number;
  employeeSnapshotErrorCount: number;
  employeeSnapshotWarningCount: number;
  employeeSnapshotCompensationTotals: Record<string, number>;
  employeeSnapshotsPreparedAt?: Date | null;
  employeeSnapshotsPreparedBy?: mongoose.Types.ObjectId | null;
  calculationStatus: "pending" | "calculated" | "stale";
  calculationVersion: number;
  calculationEmployeeSnapshotVersion: number;
  calculationOneTimeInputCount: number;
  payrollResultCount: number;
  payrollResultIssueCount: number;
  payrollResultErrorCount: number;
  payrollResultWarningCount: number;
  payrollResultTotals: Record<string, number>;
  lastCalculationReason?: string;
  calculatedAt?: Date | null;
  calculatedBy?: mongoose.Types.ObjectId | null;
  currency: string;
  currencyMinorUnits: number;
  payFrequency: "monthly";
  payDay: number;
  roundingMode: "nearest" | "floor" | "ceil";
  status: (typeof PAYROLL_RUN_STATUSES)[number];
  preparationReason: string;
  version: number;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const PayrollRunSchema = new Schema<PayrollRunI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    companyNameSnapshot: { type: String, required: true, trim: true, immutable: true },
    companyCodeSnapshot: { type: String, required: true, trim: true, uppercase: true, immutable: true },
    periodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true, immutable: true },
    cycleStartDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, immutable: true },
    cycleEndDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, immutable: true },
    attendancePayrollInput: { type: Schema.Types.ObjectId, ref: "AttendancePayrollInput", required: true, unique: true, immutable: true },
    attendancePayrollInputVersion: { type: Number, required: true, min: 1, immutable: true },
    attendancePeriod: { type: Schema.Types.ObjectId, ref: "AttendancePeriod", required: true, immutable: true },
    attendancePeriodVersion: { type: Number, required: true, min: 1, immutable: true },
    attendanceCutoffDay: { type: Number, required: true, min: 1, max: 31, immutable: true },
    attendanceSummaryCount: { type: Number, required: true, min: 0, immutable: true },
    attendanceAdjustmentCount: { type: Number, required: true, min: 0, immutable: true },
    attendanceTotals: { type: Schema.Types.Mixed, required: true, default: {}, immutable: true },
    attendanceLockedAt: { type: Date, required: true, immutable: true },
    attendanceLockedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    attendanceInputStatus: { type: String, enum: ["pending", "prepared"], required: true, default: "pending", index: true },
    employeeInputCount: { type: Number, required: true, min: 0, default: 0 },
    employeeInputIssueCount: { type: Number, required: true, min: 0, default: 0 },
    attendanceInputTotals: { type: Schema.Types.Mixed, required: true, default: {} },
    attendanceInputsPreparedAt: { type: Date, default: null },
    attendanceInputsPreparedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    oneTimeInputCount: { type: Number, required: true, min: 0, default: 0 },
    oneTimeInputTotals: {
      type: Schema.Types.Mixed,
      required: true,
      default: {
        earningsMinor: 0,
        deductionsMinor: 0,
        reimbursementsMinor: 0,
        arrearsMinor: 0,
        recoveriesMinor: 0,
        netImpactMinor: 0,
      },
    },
    employeeSnapshotStatus: { type: String, enum: ["pending", "prepared"], required: true, default: "pending", index: true },
    employeeSnapshotVersion: { type: Number, required: true, min: 0, default: 0 },
    employeeSnapshotCount: { type: Number, required: true, min: 0, default: 0 },
    employeeSnapshotIssueCount: { type: Number, required: true, min: 0, default: 0 },
    employeeSnapshotErrorCount: { type: Number, required: true, min: 0, default: 0 },
    employeeSnapshotWarningCount: { type: Number, required: true, min: 0, default: 0 },
    employeeSnapshotCompensationTotals: { type: Schema.Types.Mixed, required: true, default: {} },
    employeeSnapshotsPreparedAt: { type: Date, default: null },
    employeeSnapshotsPreparedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    calculationStatus: { type: String, enum: ["pending", "calculated", "stale"], required: true, default: "pending", index: true },
    calculationVersion: { type: Number, required: true, min: 0, default: 0 },
    calculationEmployeeSnapshotVersion: { type: Number, required: true, min: 0, default: 0 },
    calculationOneTimeInputCount: { type: Number, required: true, min: 0, default: 0 },
    payrollResultCount: { type: Number, required: true, min: 0, default: 0 },
    payrollResultIssueCount: { type: Number, required: true, min: 0, default: 0 },
    payrollResultErrorCount: { type: Number, required: true, min: 0, default: 0 },
    payrollResultWarningCount: { type: Number, required: true, min: 0, default: 0 },
    payrollResultTotals: { type: Schema.Types.Mixed, required: true, default: {} },
    lastCalculationReason: { type: String, trim: true, maxlength: 500 },
    calculatedAt: { type: Date, default: null },
    calculatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    currency: { type: String, required: true, trim: true, uppercase: true, match: /^[A-Z]{3}$/, immutable: true },
    currencyMinorUnits: { type: Number, required: true, min: 0, max: 3, immutable: true },
    payFrequency: { type: String, enum: ["monthly"], required: true, immutable: true },
    payDay: { type: Number, required: true, min: 1, max: 31, immutable: true },
    roundingMode: { type: String, enum: ["nearest", "floor", "ceil"], required: true, immutable: true },
    status: { type: String, enum: PAYROLL_RUN_STATUSES, required: true, default: "draft", index: true },
    preparationReason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500, immutable: true },
    version: { type: Number, required: true, min: 1, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  },
  { timestamps: true }
);

PayrollRunSchema.index({ company: 1, periodKey: 1 }, { unique: true });
PayrollRunSchema.index({ company: 1, status: 1, periodKey: -1 });
PayrollRunSchema.index({ company: 1, createdAt: -1 });

const PayrollRun =
  (mongoose.models.PayrollRun as mongoose.Model<PayrollRunI>) ||
  mongoose.model<PayrollRunI>("PayrollRun", PayrollRunSchema);

export default PayrollRun;
