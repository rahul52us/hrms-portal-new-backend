import mongoose, { Document, Schema } from "mongoose";

export const LEAVE_REQUEST_STATUSES = [
  "submitted",
  "approved",
  "rejected",
  "withdrawn",
  "cancelled",
] as const;

export const LEAVE_DAY_PORTIONS = ["full", "first_half", "second_half"] as const;

export interface LeaveRequestDayI {
  attendanceDate: string;
  dayType: string;
  portion: (typeof LEAVE_DAY_PORTIONS)[number];
  requestedUnits: number;
  chargedUnits: number;
  chargeReason: string;
  timezone?: string;
  leaveYearKey: string;
  leaveYearStart: string;
  leaveYearEnd: string;
  holiday?: {
    name?: string;
    type?: "mandatory" | "optional";
    isHalfDay?: boolean;
  } | null;
  employeeAssignmentHistory?: mongoose.Types.ObjectId | null;
  department?: mongoose.Types.ObjectId | null;
  departmentNameSnapshot?: string;
  teamId?: mongoose.Types.ObjectId | null;
  teamNameSnapshot?: string;
  officeLocation?: mongoose.Types.ObjectId | null;
  officeLocationNameSnapshot?: string;
  reportingManager?: mongoose.Types.ObjectId | null;
  reportingManagerNameSnapshot?: string;
  attendancePolicyAssignment?: mongoose.Types.ObjectId | null;
  attendancePolicy?: mongoose.Types.ObjectId | null;
  attendancePolicyVersion?: mongoose.Types.ObjectId | null;
  leavePolicyAssignment?: mongoose.Types.ObjectId | null;
  leavePolicy?: mongoose.Types.ObjectId | null;
  leavePolicyVersion?: mongoose.Types.ObjectId | null;
  leavePolicyVersionNumber?: number | null;
  workScheduleAssignment?: mongoose.Types.ObjectId | null;
  workSchedule?: mongoose.Types.ObjectId | null;
  workScheduleVersion?: mongoose.Types.ObjectId | null;
  holidayCalendarAssignment?: mongoose.Types.ObjectId | null;
  holidayCalendar?: mongoose.Types.ObjectId | null;
  holidayCalendarVersion?: mongoose.Types.ObjectId | null;
}

export interface LeaveRequestEventI {
  action: "submitted" | "approved" | "rejected" | "withdrawn" | "cancelled";
  actor: mongoose.Types.ObjectId;
  actorRole: string;
  comment?: string;
  at: Date;
}

export interface LeaveRequestAttachmentI {
  attachment: mongoose.Types.ObjectId;
  name: string;
  url: string;
  type: string;
  size: number;
}

export interface CompOffAllocationI {
  creditLot: mongoose.Types.ObjectId;
  units: number;
  expiresOn: string;
  status: "reserved" | "consumed" | "released" | "reversed" | "expired";
}

export interface LeaveRequestI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  leaveType: mongoose.Types.ObjectId;
  leaveTypeCodeSnapshot: string;
  leaveTypeNameSnapshot: string;
  leaveUnit: "days" | "hours";
  paid: boolean;
  balanceTracked: boolean;
  entitlementModeSnapshot: "fixed" | "earned" | "manual" | "untracked";
  compOffAllocations: CompOffAllocationI[];
  departmentNameSnapshot?: string;
  teamNameSnapshot?: string;
  officeLocation?: mongoose.Types.ObjectId | null;
  officeLocationNameSnapshot?: string;
  reportingManager?: mongoose.Types.ObjectId | null;
  reportingManagerNameSnapshot?: string;
  fromDate: string;
  toDate: string;
  startPortion: (typeof LEAVE_DAY_PORTIONS)[number];
  endPortion: (typeof LEAVE_DAY_PORTIONS)[number];
  requestedHours?: number | null;
  requestedUnits: number;
  chargedUnits: number;
  dayBreakdown: LeaveRequestDayI[];
  reason: string;
  attachments: LeaveRequestAttachmentI[];
  status: (typeof LEAVE_REQUEST_STATUSES)[number];
  approver?: mongoose.Types.ObjectId | null;
  currentApprovers: mongoose.Types.ObjectId[];
  approvalInstance?: mongoose.Types.ObjectId | null;
  approverNameSnapshot?: string;
  history: LeaveRequestEventI[];
  submittedAt: Date;
  decidedAt?: Date | null;
  decidedBy?: mongoose.Types.ObjectId | null;
  decisionComment?: string;
  cancelledAt?: Date | null;
  cancelledBy?: mongoose.Types.ObjectId | null;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const PolicyReferenceFields = {
  attendancePolicyAssignment: { type: Schema.Types.ObjectId, ref: "WorkforcePolicyAssignment", default: null },
  attendancePolicy: { type: Schema.Types.ObjectId, ref: "AttendancePolicy", default: null },
  attendancePolicyVersion: { type: Schema.Types.ObjectId, ref: "AttendancePolicyVersion", default: null },
  leavePolicyAssignment: { type: Schema.Types.ObjectId, ref: "WorkforcePolicyAssignment", default: null },
  leavePolicy: { type: Schema.Types.ObjectId, ref: "LeavePolicy", default: null },
  leavePolicyVersion: { type: Schema.Types.ObjectId, ref: "LeavePolicyVersion", default: null },
  leavePolicyVersionNumber: { type: Number, min: 1, default: null },
  workScheduleAssignment: { type: Schema.Types.ObjectId, ref: "WorkforcePolicyAssignment", default: null },
  workSchedule: { type: Schema.Types.ObjectId, ref: "WorkSchedule", default: null },
  workScheduleVersion: { type: Schema.Types.ObjectId, ref: "WorkScheduleVersion", default: null },
  holidayCalendarAssignment: { type: Schema.Types.ObjectId, ref: "WorkforcePolicyAssignment", default: null },
  holidayCalendar: { type: Schema.Types.ObjectId, ref: "HolidayCalendar", default: null },
  holidayCalendarVersion: { type: Schema.Types.ObjectId, ref: "HolidayCalendarVersion", default: null },
};

const LeaveRequestDaySchema = new Schema<LeaveRequestDayI>(
  {
    attendanceDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    dayType: { type: String, required: true, trim: true },
    portion: { type: String, enum: LEAVE_DAY_PORTIONS, required: true },
    requestedUnits: { type: Number, min: 0, required: true },
    chargedUnits: { type: Number, min: 0, required: true },
    chargeReason: { type: String, required: true, trim: true },
    timezone: { type: String, trim: true, default: "Asia/Kolkata" },
    leaveYearKey: { type: String, required: true, trim: true },
    leaveYearStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    leaveYearEnd: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    holiday: {
      name: { type: String, trim: true },
      type: { type: String, enum: ["mandatory", "optional"] },
      isHalfDay: { type: Boolean, default: false },
    },
    employeeAssignmentHistory: { type: Schema.Types.ObjectId, ref: "EmployeeAssignmentHistory", default: null },
    department: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    departmentNameSnapshot: { type: String, trim: true },
    teamId: { type: Schema.Types.ObjectId, default: null },
    teamNameSnapshot: { type: String, trim: true },
    officeLocation: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null },
    officeLocationNameSnapshot: { type: String, trim: true },
    reportingManager: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reportingManagerNameSnapshot: { type: String, trim: true },
    ...PolicyReferenceFields,
  },
  { _id: false }
);

const LeaveRequestEventSchema = new Schema<LeaveRequestEventI>(
  {
    action: { type: String, enum: ["submitted", "approved", "rejected", "withdrawn", "cancelled"], required: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorRole: { type: String, required: true, trim: true },
    comment: { type: String, trim: true },
    at: { type: Date, required: true },
  },
  { _id: true }
);

const LeaveRequestAttachmentSchema = new Schema<LeaveRequestAttachmentI>(
  {
    attachment: { type: Schema.Types.ObjectId, ref: "LeaveAttachment", required: true },
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true },
    size: { type: Number, min: 0, required: true },
  },
  { _id: false }
);

const CompOffAllocationSchema = new Schema<CompOffAllocationI>(
  {
    creditLot: { type: Schema.Types.ObjectId, ref: "CompOffCreditLot", required: true },
    units: { type: Number, min: 0.25, required: true },
    expiresOn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: {
      type: String,
      enum: ["reserved", "consumed", "released", "reversed", "expired"],
      default: "reserved",
      required: true,
    },
  },
  { _id: false }
);

const LeaveRequestSchema = new Schema<LeaveRequestI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    leaveType: { type: Schema.Types.ObjectId, ref: "LeaveType", required: true, index: true },
    leaveTypeCodeSnapshot: { type: String, required: true, trim: true, uppercase: true },
    leaveTypeNameSnapshot: { type: String, required: true, trim: true },
    leaveUnit: { type: String, enum: ["days", "hours"], required: true },
    paid: { type: Boolean, required: true },
    balanceTracked: { type: Boolean, required: true },
    entitlementModeSnapshot: {
      type: String,
      enum: ["fixed", "earned", "manual", "untracked"],
      default: "fixed",
      required: true,
    },
    compOffAllocations: { type: [CompOffAllocationSchema], default: [] },
    departmentNameSnapshot: { type: String, trim: true, index: true },
    teamNameSnapshot: { type: String, trim: true, index: true },
    officeLocation: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null, index: true },
    officeLocationNameSnapshot: { type: String, trim: true },
    reportingManager: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    reportingManagerNameSnapshot: { type: String, trim: true },
    fromDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    toDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    startPortion: { type: String, enum: LEAVE_DAY_PORTIONS, default: "full" },
    endPortion: { type: String, enum: LEAVE_DAY_PORTIONS, default: "full" },
    requestedHours: { type: Number, min: 0.25, default: null },
    requestedUnits: { type: Number, min: 0.25, required: true },
    chargedUnits: { type: Number, min: 0.25, required: true },
    dayBreakdown: { type: [LeaveRequestDaySchema], required: true },
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    attachments: { type: [LeaveRequestAttachmentSchema], default: [] },
    status: { type: String, enum: LEAVE_REQUEST_STATUSES, default: "submitted", required: true, index: true },
    approver: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    currentApprovers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    approvalInstance: { type: Schema.Types.ObjectId, ref: "ApprovalInstance", default: null, index: true },
    approverNameSnapshot: { type: String, trim: true },
    history: { type: [LeaveRequestEventSchema], default: [] },
    submittedAt: { type: Date, required: true, default: Date.now },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decisionComment: { type: String, trim: true },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

LeaveRequestSchema.index({ company: 1, employee: 1, status: 1, fromDate: -1 });
LeaveRequestSchema.index({ company: 1, approver: 1, status: 1, submittedAt: -1 });
LeaveRequestSchema.index({ company: 1, currentApprovers: 1, status: 1, submittedAt: -1 });
LeaveRequestSchema.index({ company: 1, departmentNameSnapshot: 1, status: 1, submittedAt: -1 });
LeaveRequestSchema.index({ company: 1, leaveType: 1, status: 1, fromDate: -1 });

const LeaveRequest =
  (mongoose.models.LeaveRequest as mongoose.Model<LeaveRequestI>) ||
  mongoose.model<LeaveRequestI>("LeaveRequest", LeaveRequestSchema);

export default LeaveRequest;
