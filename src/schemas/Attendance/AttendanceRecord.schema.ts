import mongoose, { Document, Schema } from "mongoose";

export const ATTENDANCE_RECORD_STATUSES = [
  "pending",
  "present",
  "absent",
  "half_day",
  "holiday",
  "weekly_off",
  "leave",
  "incomplete",
] as const;

export const ATTENDANCE_RECORD_STATES = ["open", "calculated", "finalized"] as const;

export const ATTENDANCE_WORK_MODES = ["office", "remote", "hybrid", "field"] as const;

export interface AttendancePunchSessionI {
  punchIn?: Date | null;
  punchOut?: Date | null;
  source: "web" | "mobile" | "device" | "import" | "admin" | "system";
  latitude?: number | null;
  longitude?: number | null;
  deviceInfo?: string;
}

export interface AttendanceRecordI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  attendanceDate: string;
  timezone: string;
  state: (typeof ATTENDANCE_RECORD_STATES)[number];
  status: (typeof ATTENDANCE_RECORD_STATUSES)[number];
  workMode: (typeof ATTENDANCE_WORK_MODES)[number];
  workModeSource: "default" | "remote_work_request" | "manual" | "import";
  punchSessions: AttendancePunchSessionI[];
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyExitMinutes: number;
  overtimeMinutes: number;
  isLate: boolean;
  isEarlyExit: boolean;
  hasMissingPunch: boolean;
  dayTypeSnapshot?: string;
  requiresAttendanceSnapshot?: boolean | null;
  expectedWorkMinutesSnapshot?: number | null;
  scheduleStartTimeSnapshot?: string;
  scheduleEndTimeSnapshot?: string;
  employeeAssignmentHistory?: mongoose.Types.ObjectId | null;
  department?: mongoose.Types.ObjectId | null;
  departmentNameSnapshot?: string;
  teamId?: mongoose.Types.ObjectId | null;
  teamNameSnapshot?: string;
  officeLocation?: mongoose.Types.ObjectId | null;
  officeLocationNameSnapshot?: string;
  designationSnapshot?: string;
  reportingManager?: mongoose.Types.ObjectId | null;
  reportingManagerNameSnapshot?: string;
  roleSnapshot?: string;
  isDepartmentHead: boolean;
  attendancePolicyAssignment?: mongoose.Types.ObjectId | null;
  attendancePolicy?: mongoose.Types.ObjectId | null;
  attendancePolicyVersion?: mongoose.Types.ObjectId | null;
  workScheduleAssignment?: mongoose.Types.ObjectId | null;
  workSchedule?: mongoose.Types.ObjectId | null;
  workScheduleVersion?: mongoose.Types.ObjectId | null;
  holidayCalendarAssignment?: mongoose.Types.ObjectId | null;
  holidayCalendar?: mongoose.Types.ObjectId | null;
  holidayCalendarVersion?: mongoose.Types.ObjectId | null;
  leaveRequest?: mongoose.Types.ObjectId | null;
  leaveType?: mongoose.Types.ObjectId | null;
  leaveUnits: number;
  leaveUnit?: "days" | "hours" | null;
  policyResolvedAt?: Date | null;
  revisionNumber: number;
  calculationVersion: number;
  calculatedAt?: Date | null;
  calculatedBy?: mongoose.Types.ObjectId | null;
  calculationReason?: string;
  source: "punch" | "import" | "manual" | "system" | "recalculation";
  createdBy?: mongoose.Types.ObjectId | null;
  updatedBy?: mongoose.Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const AttendancePunchSessionSchema = new Schema<AttendancePunchSessionI>(
  {
    punchIn: { type: Date, default: null },
    punchOut: { type: Date, default: null },
    source: {
      type: String,
      enum: ["web", "mobile", "device", "import", "admin", "system"],
      required: true,
    },
    latitude: { type: Number, min: -90, max: 90, default: null },
    longitude: { type: Number, min: -180, max: 180, default: null },
    deviceInfo: { type: String, trim: true },
  },
  { _id: true }
);

const AttendanceRecordSchema = new Schema<AttendanceRecordI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    attendanceDate: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    timezone: { type: String, required: true, trim: true, default: "Asia/Kolkata" },
    state: {
      type: String,
      enum: ATTENDANCE_RECORD_STATES,
      required: true,
      default: "open",
      index: true,
    },
    status: {
      type: String,
      enum: ATTENDANCE_RECORD_STATUSES,
      required: true,
      default: "pending",
      index: true,
    },
    workMode: {
      type: String,
      enum: ATTENDANCE_WORK_MODES,
      required: true,
      default: "office",
      index: true,
    },
    workModeSource: {
      type: String,
      enum: ["default", "remote_work_request", "manual", "import"],
      required: true,
      default: "default",
    },
    punchSessions: { type: [AttendancePunchSessionSchema], default: [] },
    workedMinutes: { type: Number, min: 0, default: 0 },
    breakMinutes: { type: Number, min: 0, default: 0 },
    lateMinutes: { type: Number, min: 0, default: 0 },
    earlyExitMinutes: { type: Number, min: 0, default: 0 },
    overtimeMinutes: { type: Number, min: 0, default: 0 },
    isLate: { type: Boolean, default: false },
    isEarlyExit: { type: Boolean, default: false },
    hasMissingPunch: { type: Boolean, default: false },
    dayTypeSnapshot: { type: String, trim: true },
    requiresAttendanceSnapshot: { type: Boolean, default: null },
    expectedWorkMinutesSnapshot: { type: Number, min: 0, default: null },
    scheduleStartTimeSnapshot: { type: String, trim: true },
    scheduleEndTimeSnapshot: { type: String, trim: true },
    employeeAssignmentHistory: {
      type: Schema.Types.ObjectId,
      ref: "EmployeeAssignmentHistory",
      default: null,
    },
    department: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    departmentNameSnapshot: { type: String, trim: true },
    teamId: { type: Schema.Types.ObjectId, default: null },
    teamNameSnapshot: { type: String, trim: true },
    officeLocation: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null },
    officeLocationNameSnapshot: { type: String, trim: true },
    designationSnapshot: { type: String, trim: true },
    reportingManager: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reportingManagerNameSnapshot: { type: String, trim: true },
    roleSnapshot: { type: String, trim: true },
    isDepartmentHead: { type: Boolean, default: false },
    attendancePolicyAssignment: {
      type: Schema.Types.ObjectId,
      ref: "WorkforcePolicyAssignment",
      default: null,
    },
    attendancePolicy: { type: Schema.Types.ObjectId, ref: "AttendancePolicy", default: null },
    attendancePolicyVersion: {
      type: Schema.Types.ObjectId,
      ref: "AttendancePolicyVersion",
      default: null,
    },
    workScheduleAssignment: {
      type: Schema.Types.ObjectId,
      ref: "WorkforcePolicyAssignment",
      default: null,
    },
    workSchedule: { type: Schema.Types.ObjectId, ref: "WorkSchedule", default: null },
    workScheduleVersion: {
      type: Schema.Types.ObjectId,
      ref: "WorkScheduleVersion",
      default: null,
    },
    holidayCalendarAssignment: {
      type: Schema.Types.ObjectId,
      ref: "WorkforcePolicyAssignment",
      default: null,
    },
    holidayCalendar: { type: Schema.Types.ObjectId, ref: "HolidayCalendar", default: null },
    holidayCalendarVersion: {
      type: Schema.Types.ObjectId,
      ref: "HolidayCalendarVersion",
      default: null,
    },
    leaveRequest: { type: Schema.Types.ObjectId, ref: "LeaveRequest", default: null, index: true },
    leaveType: { type: Schema.Types.ObjectId, ref: "LeaveType", default: null },
    leaveUnits: { type: Number, min: 0, default: 0 },
    leaveUnit: { type: String, enum: ["days", "hours"], default: null },
    policyResolvedAt: { type: Date, default: null },
    revisionNumber: { type: Number, min: 0, default: 0 },
    calculationVersion: { type: Number, min: 0, default: 0 },
    calculatedAt: { type: Date, default: null },
    calculatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    calculationReason: { type: String, trim: true },
    source: {
      type: String,
      enum: ["punch", "import", "manual", "system", "recalculation"],
      required: true,
      default: "system",
      index: true,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

AttendanceRecordSchema.index(
  { company: 1, employee: 1, attendanceDate: 1 },
  { unique: true }
);
AttendanceRecordSchema.index({ company: 1, attendanceDate: -1, status: 1, employee: 1 });
AttendanceRecordSchema.index({ company: 1, employee: 1, attendanceDate: -1 });
AttendanceRecordSchema.index({ company: 1, department: 1, attendanceDate: -1 });
AttendanceRecordSchema.index({ company: 1, teamId: 1, attendanceDate: -1 });
AttendanceRecordSchema.index({ company: 1, officeLocation: 1, attendanceDate: -1 });

const AttendanceRecord =
  (mongoose.models.AttendanceRecord as mongoose.Model<AttendanceRecordI>) ||
  mongoose.model<AttendanceRecordI>("AttendanceRecord", AttendanceRecordSchema);

export default AttendanceRecord;
