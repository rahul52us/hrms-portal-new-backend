import mongoose, { Document, Schema } from "mongoose";
import { ATTENDANCE_REGULARIZATION_TYPES } from "../WorkforcePolicy/AttendancePolicyVersion.schema";

export const ATTENDANCE_REGULARIZATION_STATUSES = [
  "submitted",
  "approved",
  "rejected",
  "withdrawn",
] as const;

export interface AttendanceRegularizationRequestI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  attendanceDate: string;
  correctionType: (typeof ATTENDANCE_REGULARIZATION_TYPES)[number];
  reason: string;
  status: (typeof ATTENDANCE_REGULARIZATION_STATUSES)[number];
  originalAttendanceRecord?: mongoose.Types.ObjectId | null;
  originalRevisionNumber: number;
  originalSnapshot: Record<string, unknown>;
  requestedChanges: Record<string, unknown>;
  attachments: Array<{
    attachment: mongoose.Types.ObjectId;
    name: string;
    url: string;
    type: string;
    size: number;
  }>;
  attendancePolicyAssignment: mongoose.Types.ObjectId;
  attendancePolicy: mongoose.Types.ObjectId;
  attendancePolicyVersion: mongoose.Types.ObjectId;
  attendancePolicyVersionNumber: number;
  departmentNameSnapshot?: string;
  teamNameSnapshot?: string;
  officeLocation?: mongoose.Types.ObjectId | null;
  officeLocationNameSnapshot?: string;
  reportingManager?: mongoose.Types.ObjectId | null;
  approver?: mongoose.Types.ObjectId | null;
  currentApprovers: mongoose.Types.ObjectId[];
  approvalInstance?: mongoose.Types.ObjectId | null;
  approverNameSnapshot?: string;
  history: any[];
  submittedAt: Date;
  decidedAt?: Date | null;
  decidedBy?: mongoose.Types.ObjectId | null;
  decisionComment?: string;
  appliedAttendanceRecord?: mongoose.Types.ObjectId | null;
  appliedRevisionNumber?: number | null;
  createdBy: mongoose.Types.ObjectId;
}

const AttachmentSchema = new Schema(
  {
    attachment: { type: Schema.Types.ObjectId, ref: "LeaveAttachment", required: true },
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true },
    size: { type: Number, min: 1, required: true },
  },
  { _id: false }
);

const HistorySchema = new Schema(
  {
    action: { type: String, enum: ATTENDANCE_REGULARIZATION_STATUSES, required: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorRole: { type: String, required: true, trim: true },
    comment: { type: String, trim: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: true }
);

const AttendanceRegularizationRequestSchema = new Schema<AttendanceRegularizationRequestI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    attendanceDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    correctionType: { type: String, enum: ATTENDANCE_REGULARIZATION_TYPES, required: true, index: true },
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    status: { type: String, enum: ATTENDANCE_REGULARIZATION_STATUSES, default: "submitted", index: true },
    originalAttendanceRecord: { type: Schema.Types.ObjectId, ref: "AttendanceRecord", default: null },
    originalRevisionNumber: { type: Number, min: 0, required: true, default: 0 },
    originalSnapshot: { type: Schema.Types.Mixed, required: true, default: {} },
    requestedChanges: { type: Schema.Types.Mixed, required: true, default: {} },
    attachments: { type: [AttachmentSchema], default: [] },
    attendancePolicyAssignment: { type: Schema.Types.ObjectId, ref: "WorkforcePolicyAssignment", required: true },
    attendancePolicy: { type: Schema.Types.ObjectId, ref: "AttendancePolicy", required: true },
    attendancePolicyVersion: { type: Schema.Types.ObjectId, ref: "AttendancePolicyVersion", required: true },
    attendancePolicyVersionNumber: { type: Number, min: 1, required: true },
    departmentNameSnapshot: { type: String, trim: true, index: true },
    teamNameSnapshot: { type: String, trim: true, index: true },
    officeLocation: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null, index: true },
    officeLocationNameSnapshot: { type: String, trim: true },
    reportingManager: { type: Schema.Types.ObjectId, ref: "User", default: null },
    approver: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    currentApprovers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    approvalInstance: { type: Schema.Types.ObjectId, ref: "ApprovalInstance", default: null, index: true },
    approverNameSnapshot: { type: String, trim: true },
    history: { type: [HistorySchema] as any, default: [] },
    submittedAt: { type: Date, required: true, default: Date.now },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decisionComment: { type: String, trim: true },
    appliedAttendanceRecord: { type: Schema.Types.ObjectId, ref: "AttendanceRecord", default: null },
    appliedRevisionNumber: { type: Number, min: 1, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

AttendanceRegularizationRequestSchema.index(
  { company: 1, employee: 1, attendanceDate: 1 },
  { unique: true, partialFilterExpression: { status: "submitted" } }
);
AttendanceRegularizationRequestSchema.index({ company: 1, currentApprovers: 1, status: 1, submittedAt: -1 });

const AttendanceRegularizationRequest =
  (mongoose.models.AttendanceRegularizationRequest as mongoose.Model<AttendanceRegularizationRequestI>) ||
  mongoose.model<AttendanceRegularizationRequestI>(
    "AttendanceRegularizationRequest",
    AttendanceRegularizationRequestSchema
  );

export default AttendanceRegularizationRequest;
