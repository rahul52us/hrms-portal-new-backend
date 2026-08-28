import mongoose, { Document, Schema } from "mongoose";

export const COMP_OFF_CLAIM_STATUSES = [
  "submitted",
  "approved",
  "rejected",
  "withdrawn",
  "revoked",
] as const;

export interface CompOffClaimI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  leaveType: mongoose.Types.ObjectId;
  attendanceDate: string;
  attendanceRecord: mongoose.Types.ObjectId;
  dayTypeSnapshot: string;
  workedMinutesSnapshot: number;
  requestedUnits: number;
  eligibleUnitsSnapshot: number;
  approvedUnits: number;
  expiresOn?: string | null;
  reason: string;
  status: (typeof COMP_OFF_CLAIM_STATUSES)[number];
  approver?: mongoose.Types.ObjectId | null;
  currentApprovers: mongoose.Types.ObjectId[];
  approvalInstance?: mongoose.Types.ObjectId | null;
  approverNameSnapshot?: string;
  departmentNameSnapshot?: string;
  teamNameSnapshot?: string;
  officeLocation?: mongoose.Types.ObjectId | null;
  officeLocationNameSnapshot?: string;
  leavePolicyAssignment: mongoose.Types.ObjectId;
  leavePolicy: mongoose.Types.ObjectId;
  leavePolicyVersion: mongoose.Types.ObjectId;
  leavePolicyVersionNumber: number;
  policyScopeNameSnapshot?: string;
  history: Array<{
    action: "submitted" | "approved" | "rejected" | "withdrawn" | "revoked";
    actor: mongoose.Types.ObjectId;
    actorRole: string;
    comment?: string;
    at: Date;
  }>;
  submittedAt: Date;
  decidedAt?: Date | null;
  decidedBy?: mongoose.Types.ObjectId | null;
  decisionComment?: string;
  createdBy: mongoose.Types.ObjectId;
}

const ClaimEventSchema = new Schema(
  {
    action: {
      type: String,
      enum: ["submitted", "approved", "rejected", "withdrawn", "revoked"],
      required: true,
    },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorRole: { type: String, required: true, trim: true },
    comment: { type: String, trim: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: true }
);

const CompOffClaimSchema = new Schema<CompOffClaimI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    leaveType: { type: Schema.Types.ObjectId, ref: "LeaveType", required: true, index: true },
    attendanceDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    attendanceRecord: { type: Schema.Types.ObjectId, ref: "AttendanceRecord", required: true, index: true },
    dayTypeSnapshot: { type: String, required: true, trim: true },
    workedMinutesSnapshot: { type: Number, min: 0, required: true },
    requestedUnits: { type: Number, enum: [0.5, 1], required: true },
    eligibleUnitsSnapshot: { type: Number, enum: [0.5, 1], required: true },
    approvedUnits: { type: Number, enum: [0, 0.5, 1], default: 0 },
    expiresOn: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    status: { type: String, enum: COMP_OFF_CLAIM_STATUSES, default: "submitted", index: true },
    approver: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    currentApprovers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    approvalInstance: { type: Schema.Types.ObjectId, ref: "ApprovalInstance", default: null, index: true },
    approverNameSnapshot: { type: String, trim: true },
    departmentNameSnapshot: { type: String, trim: true, index: true },
    teamNameSnapshot: { type: String, trim: true, index: true },
    officeLocation: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null, index: true },
    officeLocationNameSnapshot: { type: String, trim: true },
    leavePolicyAssignment: { type: Schema.Types.ObjectId, ref: "WorkforcePolicyAssignment", required: true },
    leavePolicy: { type: Schema.Types.ObjectId, ref: "LeavePolicy", required: true },
    leavePolicyVersion: { type: Schema.Types.ObjectId, ref: "LeavePolicyVersion", required: true },
    leavePolicyVersionNumber: { type: Number, min: 1, required: true },
    policyScopeNameSnapshot: { type: String, trim: true },
    history: { type: [ClaimEventSchema], default: [] },
    submittedAt: { type: Date, required: true, default: Date.now },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decisionComment: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

CompOffClaimSchema.index(
  { company: 1, employee: 1, leaveType: 1, attendanceDate: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["submitted", "approved"] } },
  }
);
CompOffClaimSchema.index({ company: 1, approver: 1, status: 1, submittedAt: -1 });
CompOffClaimSchema.index({ company: 1, currentApprovers: 1, status: 1, submittedAt: -1 });

const CompOffClaim =
  (mongoose.models.CompOffClaim as mongoose.Model<CompOffClaimI>) ||
  mongoose.model<CompOffClaimI>("CompOffClaim", CompOffClaimSchema);

export default CompOffClaim;
