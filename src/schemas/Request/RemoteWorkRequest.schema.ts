import mongoose, { Document, Schema } from "mongoose";

export const REMOTE_WORK_REQUEST_STATUSES = [
  "submitted",
  "manager_approved",
  "approved",
  "rejected",
  "withdrawn",
  "cancelled",
] as const;

export interface RemoteWorkRequestDateI {
  attendanceDate: string;
  portion: "full" | "first_half" | "second_half";
  units: number;
  dayTypeSnapshot: string;
  expectedWorkMinutesSnapshot?: number | null;
  employeeAssignmentHistory?: mongoose.Types.ObjectId | null;
  department?: mongoose.Types.ObjectId | null;
  departmentNameSnapshot?: string;
  teamId?: mongoose.Types.ObjectId | null;
  teamNameSnapshot?: string;
  officeLocation?: mongoose.Types.ObjectId | null;
  officeLocationNameSnapshot?: string;
}

export interface RemoteWorkRequestHistoryI {
  action: string;
  actor: mongoose.Types.ObjectId;
  actorNameSnapshot?: string;
  actorRoleSnapshot?: string;
  comment?: string;
  createdAt: Date;
}

export interface RemoteWorkRequestI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  employeeNameSnapshot: string;
  employeeCodeSnapshot?: string;
  department?: mongoose.Types.ObjectId | null;
  departmentNameSnapshot?: string;
  teamId?: mongoose.Types.ObjectId | null;
  teamNameSnapshot?: string;
  officeLocation?: mongoose.Types.ObjectId | null;
  officeLocationNameSnapshot?: string;
  fromDate: string;
  toDate: string;
  requestedUnits: number;
  dates: RemoteWorkRequestDateI[];
  reason?: string;
  status: (typeof REMOTE_WORK_REQUEST_STATUSES)[number];
  approvalModeSnapshot: "reporting_manager" | "hr" | "manager_then_hr" | "auto_approve";
  approver?: mongoose.Types.ObjectId | null;
  approverNameSnapshot?: string;
  reportingManager?: mongoose.Types.ObjectId | null;
  reportingManagerNameSnapshot?: string;
  remoteWorkPolicyAssignment: mongoose.Types.ObjectId;
  remoteWorkPolicy: mongoose.Types.ObjectId;
  remoteWorkPolicyVersion: mongoose.Types.ObjectId;
  remoteWorkPolicyVersionNumber: number;
  policyScopeTypeSnapshot?: string;
  policyScopeNameSnapshot?: string;
  history: RemoteWorkRequestHistoryI[];
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

const RemoteWorkRequestDateSchema = new Schema<RemoteWorkRequestDateI>(
  {
    attendanceDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    portion: { type: String, enum: ["full", "first_half", "second_half"], default: "full" },
    units: { type: Number, enum: [0.5, 1], required: true },
    dayTypeSnapshot: { type: String, required: true, trim: true },
    expectedWorkMinutesSnapshot: { type: Number, min: 0, default: null },
    employeeAssignmentHistory: { type: Schema.Types.ObjectId, ref: "EmployeeAssignmentHistory", default: null },
    department: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    departmentNameSnapshot: { type: String, trim: true },
    teamId: { type: Schema.Types.ObjectId, default: null },
    teamNameSnapshot: { type: String, trim: true },
    officeLocation: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null },
    officeLocationNameSnapshot: { type: String, trim: true },
  },
  { _id: false }
);

const RemoteWorkRequestHistorySchema = new Schema<RemoteWorkRequestHistoryI>(
  {
    action: { type: String, required: true, trim: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorNameSnapshot: { type: String, trim: true },
    actorRoleSnapshot: { type: String, trim: true },
    comment: { type: String, trim: true },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { _id: true }
);

const RemoteWorkRequestSchema = new Schema<RemoteWorkRequestI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    employeeNameSnapshot: { type: String, required: true, trim: true },
    employeeCodeSnapshot: { type: String, trim: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", default: null, index: true },
    departmentNameSnapshot: { type: String, trim: true },
    teamId: { type: Schema.Types.ObjectId, default: null },
    teamNameSnapshot: { type: String, trim: true },
    officeLocation: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null, index: true },
    officeLocationNameSnapshot: { type: String, trim: true },
    fromDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    toDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    requestedUnits: { type: Number, min: 0.5, required: true },
    dates: { type: [RemoteWorkRequestDateSchema], required: true },
    reason: { type: String, trim: true },
    status: { type: String, enum: REMOTE_WORK_REQUEST_STATUSES, required: true, default: "submitted", index: true },
    approvalModeSnapshot: {
      type: String,
      enum: ["reporting_manager", "hr", "manager_then_hr", "auto_approve"],
      required: true,
    },
    approver: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    approverNameSnapshot: { type: String, trim: true },
    reportingManager: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    reportingManagerNameSnapshot: { type: String, trim: true },
    remoteWorkPolicyAssignment: { type: Schema.Types.ObjectId, ref: "WorkforcePolicyAssignment", required: true },
    remoteWorkPolicy: { type: Schema.Types.ObjectId, ref: "RemoteWorkPolicy", required: true },
    remoteWorkPolicyVersion: { type: Schema.Types.ObjectId, ref: "RemoteWorkPolicyVersion", required: true },
    remoteWorkPolicyVersionNumber: { type: Number, min: 1, required: true },
    policyScopeTypeSnapshot: { type: String, trim: true },
    policyScopeNameSnapshot: { type: String, trim: true },
    history: { type: [RemoteWorkRequestHistorySchema], default: [] },
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

RemoteWorkRequestSchema.index({ company: 1, employee: 1, fromDate: -1, status: 1 });
RemoteWorkRequestSchema.index({ company: 1, approver: 1, status: 1, submittedAt: -1 });
RemoteWorkRequestSchema.index({ company: 1, "dates.attendanceDate": 1, status: 1 });
RemoteWorkRequestSchema.index({ company: 1, department: 1, status: 1 });

const RemoteWorkRequest =
  (mongoose.models.RemoteWorkRequest as mongoose.Model<RemoteWorkRequestI>) ||
  mongoose.model<RemoteWorkRequestI>("RemoteWorkRequest", RemoteWorkRequestSchema);

export default RemoteWorkRequest;
