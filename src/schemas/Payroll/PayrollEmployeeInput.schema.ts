import mongoose, { Document, Schema } from "mongoose";

export const PAYROLL_EMPLOYEE_CURRENT_FIELDS = [
  "calendarDays",
  "expectedDays",
  "paidDays",
  "unpaidDays",
  "presentDays",
  "halfDays",
  "absentDays",
  "paidLeaveDays",
  "unpaidLeaveDays",
  "holidayDays",
  "weeklyOffDays",
  "wfhDays",
  "incompleteDays",
  "pendingDays",
  "workedMinutes",
  "rawOvertimeMinutes",
  "approvedOvertimeMinutes",
  "lateMinutes",
  "earlyExitMinutes",
  "lateDays",
  "earlyExitDays",
  "missingPunchDays",
  "overtimeDays",
  "regularizationDays",
  "exceptionCount",
  "sourceRecordCount",
] as const;

export const PAYROLL_EMPLOYEE_RESOLVED_FIELDS = [
  "paidDays",
  "unpaidDays",
  "workedMinutes",
  "approvedOvertimeMinutes",
  "lateMinutes",
  "earlyExitMinutes",
  "absentDays",
  "exceptionCount",
] as const;

export interface PayrollEmployeeInputI extends Document {
  company: mongoose.Types.ObjectId;
  payrollRun: mongoose.Types.ObjectId;
  periodKey: string;
  employee: mongoose.Types.ObjectId;
  employeeNameSnapshot: string;
  employeeCodeSnapshot: string;
  designationSnapshot?: string;
  department?: mongoose.Types.ObjectId | null;
  departmentNameSnapshot?: string;
  teamId?: mongoose.Types.ObjectId | null;
  teamNameSnapshot?: string;
  officeLocation?: mongoose.Types.ObjectId | null;
  officeLocationNameSnapshot?: string;
  reportingManager?: mongoose.Types.ObjectId | null;
  reportingManagerNameSnapshot?: string;
  attendancePayrollInput: mongoose.Types.ObjectId;
  attendanceMonthlySummary?: mongoose.Types.ObjectId | null;
  attendancePayrollAdjustments: mongoose.Types.ObjectId[];
  attendancePeriodVersion: number;
  currentAttendance: Record<string, number>;
  attendanceAdjustments: Record<string, number>;
  payrollAttendance: Record<string, number>;
  adjustmentSourcePeriods: string[];
  attendanceAdjustmentCount: number;
  inputIssues: string[];
  hasIssues: boolean;
  preparedAt: Date;
  preparedBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

function numericFields(fields: readonly string[]) {
  return fields.reduce<Record<string, any>>((definition, field) => {
    definition[field] = { type: Number, required: true, default: 0 };
    return definition;
  }, {});
}

const CurrentAttendanceSchema = new Schema(
  numericFields(PAYROLL_EMPLOYEE_CURRENT_FIELDS),
  { _id: false }
);
const ResolvedAttendanceSchema = new Schema(
  numericFields(PAYROLL_EMPLOYEE_RESOLVED_FIELDS),
  { _id: false }
);

const PayrollEmployeeInputSchema = new Schema<PayrollEmployeeInputI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    payrollRun: { type: Schema.Types.ObjectId, ref: "PayrollRun", required: true, index: true, immutable: true },
    periodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true, immutable: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
    employeeNameSnapshot: { type: String, required: true, trim: true, immutable: true },
    employeeCodeSnapshot: { type: String, required: true, trim: true, immutable: true },
    designationSnapshot: { type: String, trim: true, immutable: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", default: null, immutable: true },
    departmentNameSnapshot: { type: String, trim: true, immutable: true },
    teamId: { type: Schema.Types.ObjectId, default: null, immutable: true },
    teamNameSnapshot: { type: String, trim: true, immutable: true },
    officeLocation: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null, immutable: true },
    officeLocationNameSnapshot: { type: String, trim: true, immutable: true },
    reportingManager: { type: Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
    reportingManagerNameSnapshot: { type: String, trim: true, immutable: true },
    attendancePayrollInput: { type: Schema.Types.ObjectId, ref: "AttendancePayrollInput", required: true, immutable: true },
    attendanceMonthlySummary: { type: Schema.Types.ObjectId, ref: "AttendanceMonthlySummary", default: null, immutable: true },
    attendancePayrollAdjustments: {
      type: [{ type: Schema.Types.ObjectId, ref: "AttendancePayrollAdjustment" }],
      default: [],
      immutable: true,
    },
    attendancePeriodVersion: { type: Number, required: true, min: 1, immutable: true },
    currentAttendance: { type: CurrentAttendanceSchema, required: true, immutable: true },
    attendanceAdjustments: { type: ResolvedAttendanceSchema, required: true, immutable: true },
    payrollAttendance: { type: ResolvedAttendanceSchema, required: true, immutable: true },
    adjustmentSourcePeriods: {
      type: [{ type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/ }],
      default: [],
      immutable: true,
    },
    attendanceAdjustmentCount: { type: Number, required: true, min: 0, immutable: true },
    inputIssues: { type: [{ type: String, trim: true }], default: [], immutable: true },
    hasIssues: { type: Boolean, required: true, default: false, index: true, immutable: true },
    preparedAt: { type: Date, required: true, immutable: true },
    preparedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

PayrollEmployeeInputSchema.index({ company: 1, payrollRun: 1, employee: 1 }, { unique: true });
PayrollEmployeeInputSchema.index({ company: 1, payrollRun: 1, employeeCodeSnapshot: 1 });
PayrollEmployeeInputSchema.index({ company: 1, payrollRun: 1, hasIssues: 1, employeeNameSnapshot: 1 });

const PayrollEmployeeInput =
  (mongoose.models.PayrollEmployeeInput as mongoose.Model<PayrollEmployeeInputI>) ||
  mongoose.model<PayrollEmployeeInputI>("PayrollEmployeeInput", PayrollEmployeeInputSchema);

export default PayrollEmployeeInput;
