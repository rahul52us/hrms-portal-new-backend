import mongoose, { Document, Schema } from "mongoose";

export interface AttendanceMonthlySummaryDayI {
  attendanceDate: string;
  attendanceRecord: mongoose.Types.ObjectId;
  attendanceRevisionNumber: number;
  status: string;
  dayType: string;
  workMode: string;
  workedMinutes: number;
  lateMinutes: number;
  earlyExitMinutes: number;
  overtimeMinutes: number;
  approvedOvertimeMinutes: number;
  paidUnits: number;
  unpaidUnits: number;
  leaveUnits: number;
  paidLeave: boolean;
  exceptions: string[];
}

export interface AttendanceMonthlySummaryI extends Document {
  company: mongoose.Types.ObjectId;
  attendancePeriod: mongoose.Types.ObjectId;
  periodKey: string;
  attendancePeriodVersion: number;
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
  calendarDays: number;
  expectedDays: number;
  paidDays: number;
  unpaidDays: number;
  presentDays: number;
  halfDays: number;
  absentDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  holidayDays: number;
  weeklyOffDays: number;
  wfhDays: number;
  incompleteDays: number;
  pendingDays: number;
  workedMinutes: number;
  rawOvertimeMinutes: number;
  approvedOvertimeMinutes: number;
  lateMinutes: number;
  earlyExitMinutes: number;
  lateDays: number;
  earlyExitDays: number;
  missingPunchDays: number;
  overtimeDays: number;
  regularizationDays: number;
  exceptionCount: number;
  sourceRecordCount: number;
  daily: AttendanceMonthlySummaryDayI[];
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

const AttendanceMonthlySummaryDaySchema = new Schema<AttendanceMonthlySummaryDayI>(
  {
    attendanceDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    attendanceRecord: { type: Schema.Types.ObjectId, ref: "AttendanceRecord", required: true },
    attendanceRevisionNumber: { type: Number, required: true, min: 0 },
    status: { type: String, required: true, trim: true },
    dayType: { type: String, required: true, trim: true },
    workMode: { type: String, required: true, trim: true },
    workedMinutes: { type: Number, required: true, min: 0 },
    lateMinutes: { type: Number, required: true, min: 0 },
    earlyExitMinutes: { type: Number, required: true, min: 0 },
    overtimeMinutes: { type: Number, required: true, min: 0 },
    approvedOvertimeMinutes: { type: Number, required: true, min: 0 },
    paidUnits: { type: Number, required: true, min: 0, max: 1 },
    unpaidUnits: { type: Number, required: true, min: 0, max: 1 },
    leaveUnits: { type: Number, required: true, min: 0 },
    paidLeave: { type: Boolean, required: true, default: false },
    exceptions: { type: [{ type: String, trim: true }], default: [] },
  },
  { _id: false }
);

const AttendanceMonthlySummarySchema = new Schema<AttendanceMonthlySummaryI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    attendancePeriod: { type: Schema.Types.ObjectId, ref: "AttendancePeriod", required: true, index: true, immutable: true },
    periodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true, immutable: true },
    attendancePeriodVersion: { type: Number, required: true, min: 1, immutable: true },
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
    calendarDays: { type: Number, required: true, min: 0, immutable: true },
    expectedDays: { type: Number, required: true, min: 0, immutable: true },
    paidDays: { type: Number, required: true, min: 0, immutable: true },
    unpaidDays: { type: Number, required: true, min: 0, immutable: true },
    presentDays: { type: Number, required: true, min: 0, immutable: true },
    halfDays: { type: Number, required: true, min: 0, immutable: true },
    absentDays: { type: Number, required: true, min: 0, immutable: true },
    paidLeaveDays: { type: Number, required: true, min: 0, immutable: true },
    unpaidLeaveDays: { type: Number, required: true, min: 0, immutable: true },
    holidayDays: { type: Number, required: true, min: 0, immutable: true },
    weeklyOffDays: { type: Number, required: true, min: 0, immutable: true },
    wfhDays: { type: Number, required: true, min: 0, immutable: true },
    incompleteDays: { type: Number, required: true, min: 0, immutable: true },
    pendingDays: { type: Number, required: true, min: 0, immutable: true },
    workedMinutes: { type: Number, required: true, min: 0, immutable: true },
    rawOvertimeMinutes: { type: Number, required: true, min: 0, immutable: true },
    approvedOvertimeMinutes: { type: Number, required: true, min: 0, immutable: true },
    lateMinutes: { type: Number, required: true, min: 0, immutable: true },
    earlyExitMinutes: { type: Number, required: true, min: 0, immutable: true },
    lateDays: { type: Number, required: true, min: 0, immutable: true },
    earlyExitDays: { type: Number, required: true, min: 0, immutable: true },
    missingPunchDays: { type: Number, required: true, min: 0, immutable: true },
    overtimeDays: { type: Number, required: true, min: 0, immutable: true },
    regularizationDays: { type: Number, required: true, min: 0, immutable: true },
    exceptionCount: { type: Number, required: true, min: 0, immutable: true },
    sourceRecordCount: { type: Number, required: true, min: 0, immutable: true },
    daily: { type: [AttendanceMonthlySummaryDaySchema], required: true, immutable: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AttendanceMonthlySummarySchema.index(
  { company: 1, periodKey: 1, attendancePeriodVersion: 1, employee: 1 },
  { unique: true }
);
AttendanceMonthlySummarySchema.index({ company: 1, periodKey: 1, attendancePeriodVersion: -1 });
AttendanceMonthlySummarySchema.index({ company: 1, employee: 1, periodKey: -1 });

const AttendanceMonthlySummary =
  (mongoose.models.AttendanceMonthlySummary as mongoose.Model<AttendanceMonthlySummaryI>) ||
  mongoose.model<AttendanceMonthlySummaryI>("AttendanceMonthlySummary", AttendanceMonthlySummarySchema);

export default AttendanceMonthlySummary;
