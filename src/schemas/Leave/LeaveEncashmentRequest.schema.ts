import mongoose, { Document, Schema } from "mongoose";

export const LEAVE_ENCASHMENT_REQUEST_STATUSES = [
  "submitted",
  "approved",
  "rejected",
  "withdrawn",
  "cancelled",
] as const;

export const LEAVE_ENCASHMENT_PAYOUT_STATUSES = [
  "not_ready",
  "pending",
  "paid",
  "cancelled",
] as const;

export interface LeaveEncashmentRequestI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  leaveType: mongoose.Types.ObjectId;
  leaveTypeCodeSnapshot: string;
  leaveTypeNameSnapshot: string;
  leaveUnit: "days" | "hours";
  leaveYearKey: string;
  leaveYearStart: string;
  leaveYearEnd: string;
  requestedUnits: number;
  maxEncashmentPerYearSnapshot: number;
  availableBalanceSnapshot: number;
  leavePolicyAssignment?: mongoose.Types.ObjectId | null;
  leavePolicy?: mongoose.Types.ObjectId | null;
  leavePolicyVersion?: mongoose.Types.ObjectId | null;
  leavePolicyVersionNumber?: number | null;
  departmentNameSnapshot?: string;
  teamNameSnapshot?: string;
  officeLocation?: mongoose.Types.ObjectId | null;
  reportingManager?: mongoose.Types.ObjectId | null;
  reason: string;
  status: (typeof LEAVE_ENCASHMENT_REQUEST_STATUSES)[number];
  payoutStatus: (typeof LEAVE_ENCASHMENT_PAYOUT_STATUSES)[number];
  payoutAmount?: number | null;
  payoutCurrency?: string;
  payoutDate?: string | null;
  payoutReference?: string;
  payoutNotes?: string;
  settledAt?: Date | null;
  settledBy?: mongoose.Types.ObjectId | null;
  encashmentTransaction?: mongoose.Types.ObjectId | null;
  reversalTransaction?: mongoose.Types.ObjectId | null;
  approver?: mongoose.Types.ObjectId | null;
  currentApprovers: mongoose.Types.ObjectId[];
  approvalInstance?: mongoose.Types.ObjectId | null;
  approverNameSnapshot?: string;
  requestedAt: Date;
  decidedAt?: Date | null;
  decidedBy?: mongoose.Types.ObjectId | null;
  decisionComment?: string;
  cancelledAt?: Date | null;
  cancelledBy?: mongoose.Types.ObjectId | null;
  cancellationReason?: string;
  history: any[];
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const LeaveEncashmentHistorySchema = new Schema(
  {
    action: {
      type: String,
      enum: ["submitted", "approved", "rejected", "withdrawn", "marked_paid", "cancelled"],
      required: true,
    },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorRole: { type: String, required: true, trim: true },
    comment: { type: String, trim: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: true }
);

const LeaveEncashmentRequestSchema = new Schema<LeaveEncashmentRequestI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    leaveType: { type: Schema.Types.ObjectId, ref: "LeaveType", required: true, index: true },
    leaveTypeCodeSnapshot: { type: String, required: true, trim: true, uppercase: true },
    leaveTypeNameSnapshot: { type: String, required: true, trim: true },
    leaveUnit: { type: String, enum: ["days", "hours"], required: true },
    leaveYearKey: { type: String, required: true, trim: true, index: true },
    leaveYearStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    leaveYearEnd: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    requestedUnits: { type: Number, required: true, min: 0.25 },
    maxEncashmentPerYearSnapshot: { type: Number, required: true, min: 0.25 },
    availableBalanceSnapshot: { type: Number, required: true, min: 0 },
    leavePolicyAssignment: { type: Schema.Types.ObjectId, ref: "WorkforcePolicyAssignment", default: null },
    leavePolicy: { type: Schema.Types.ObjectId, ref: "LeavePolicy", default: null },
    leavePolicyVersion: { type: Schema.Types.ObjectId, ref: "LeavePolicyVersion", default: null },
    leavePolicyVersionNumber: { type: Number, min: 1, default: null },
    departmentNameSnapshot: { type: String, trim: true, index: true },
    teamNameSnapshot: { type: String, trim: true, index: true },
    officeLocation: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null, index: true },
    reportingManager: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 2000 },
    status: {
      type: String,
      enum: LEAVE_ENCASHMENT_REQUEST_STATUSES,
      default: "submitted",
      required: true,
      index: true,
    },
    payoutStatus: {
      type: String,
      enum: LEAVE_ENCASHMENT_PAYOUT_STATUSES,
      default: "not_ready",
      required: true,
      index: true,
    },
    payoutAmount: { type: Number, min: 0, default: null },
    payoutCurrency: { type: String, trim: true, uppercase: true, minlength: 3, maxlength: 3, default: "INR" },
    payoutDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
    payoutReference: { type: String, trim: true, maxlength: 200, default: "" },
    payoutNotes: { type: String, trim: true, maxlength: 1000, default: "" },
    settledAt: { type: Date, default: null },
    settledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    encashmentTransaction: { type: Schema.Types.ObjectId, ref: "LeaveBalanceTransaction", default: null },
    reversalTransaction: { type: Schema.Types.ObjectId, ref: "LeaveBalanceTransaction", default: null },
    approver: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    currentApprovers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    approvalInstance: { type: Schema.Types.ObjectId, ref: "ApprovalInstance", default: null, index: true },
    approverNameSnapshot: { type: String, trim: true, default: "" },
    requestedAt: { type: Date, required: true, default: Date.now, index: true },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decisionComment: { type: String, trim: true, default: "" },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancellationReason: { type: String, trim: true, default: "" },
    history: { type: [LeaveEncashmentHistorySchema] as any, default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

LeaveEncashmentRequestSchema.index(
  { company: 1, employee: 1, leaveType: 1, leaveYearKey: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "submitted" } }
);
LeaveEncashmentRequestSchema.index({ company: 1, currentApprovers: 1, status: 1, requestedAt: -1 });
LeaveEncashmentRequestSchema.index({ company: 1, payoutStatus: 1, requestedAt: -1 });
LeaveEncashmentRequestSchema.index({ company: 1, employee: 1, requestedAt: -1 });

const LeaveEncashmentRequest =
  (mongoose.models.LeaveEncashmentRequest as mongoose.Model<LeaveEncashmentRequestI>) ||
  mongoose.model<LeaveEncashmentRequestI>("LeaveEncashmentRequest", LeaveEncashmentRequestSchema);

export default LeaveEncashmentRequest;
