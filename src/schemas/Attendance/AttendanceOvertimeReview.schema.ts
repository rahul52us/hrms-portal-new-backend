import mongoose, { Document, Schema } from "mongoose";

export const ATTENDANCE_OVERTIME_REVIEW_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "superseded",
] as const;

export interface AttendanceOvertimeReviewI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  attendanceRecord: mongoose.Types.ObjectId;
  attendanceDate: string;
  attendanceRevisionNumber: number;
  overtimeMinutesSnapshot: number;
  workedMinutesSnapshot: number;
  dayTypeSnapshot: string;
  status: (typeof ATTENDANCE_OVERTIME_REVIEW_STATUSES)[number];
  attendancePolicyAssignment?: mongoose.Types.ObjectId | null;
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
  history: Array<{
    action: "pending" | "approved" | "rejected" | "superseded";
    actor?: mongoose.Types.ObjectId | null;
    actorRole: string;
    comment?: string;
    at: Date;
  }>;
  submittedAt: Date;
  decidedAt?: Date | null;
  decidedBy?: mongoose.Types.ObjectId | null;
  decisionComment?: string;
  createdBy?: mongoose.Types.ObjectId | null;
}

const OvertimeReviewHistorySchema = new Schema(
  {
    action: { type: String, enum: ATTENDANCE_OVERTIME_REVIEW_STATUSES, required: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorRole: { type: String, required: true, trim: true },
    comment: { type: String, trim: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: true }
);

const AttendanceOvertimeReviewSchema = new Schema<AttendanceOvertimeReviewI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    attendanceRecord: { type: Schema.Types.ObjectId, ref: "AttendanceRecord", required: true, index: true },
    attendanceDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    attendanceRevisionNumber: { type: Number, min: 1, required: true },
    overtimeMinutesSnapshot: { type: Number, min: 1, required: true },
    workedMinutesSnapshot: { type: Number, min: 0, required: true },
    dayTypeSnapshot: { type: String, required: true, trim: true },
    status: { type: String, enum: ATTENDANCE_OVERTIME_REVIEW_STATUSES, default: "pending", index: true },
    attendancePolicyAssignment: { type: Schema.Types.ObjectId, ref: "WorkforcePolicyAssignment", default: null },
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
    history: { type: [OvertimeReviewHistorySchema] as any, default: [] },
    submittedAt: { type: Date, required: true, default: Date.now },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decisionComment: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

AttendanceOvertimeReviewSchema.index(
  { company: 1, attendanceRecord: 1, attendanceRevisionNumber: 1 },
  { unique: true }
);
AttendanceOvertimeReviewSchema.index({ company: 1, currentApprovers: 1, status: 1, submittedAt: -1 });
AttendanceOvertimeReviewSchema.index({ company: 1, employee: 1, attendanceDate: -1 });

const AttendanceOvertimeReview =
  (mongoose.models.AttendanceOvertimeReview as mongoose.Model<AttendanceOvertimeReviewI>) ||
  mongoose.model<AttendanceOvertimeReviewI>(
    "AttendanceOvertimeReview",
    AttendanceOvertimeReviewSchema
  );

export default AttendanceOvertimeReview;
