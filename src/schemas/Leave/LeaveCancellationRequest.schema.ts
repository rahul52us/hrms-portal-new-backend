import mongoose, { Document, Schema } from "mongoose";

export const LEAVE_CANCELLATION_REQUEST_STATUSES = [
  "submitted",
  "approved",
  "rejected",
  "withdrawn",
] as const;

export interface LeaveCancellationRequestI extends Document {
  company: mongoose.Types.ObjectId;
  leaveRequest: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  departmentNameSnapshot?: string;
  teamNameSnapshot?: string;
  officeLocation?: mongoose.Types.ObjectId | null;
  reportingManager?: mongoose.Types.ObjectId | null;
  reason: string;
  status: (typeof LEAVE_CANCELLATION_REQUEST_STATUSES)[number];
  approver?: mongoose.Types.ObjectId | null;
  currentApprovers: mongoose.Types.ObjectId[];
  approvalInstance?: mongoose.Types.ObjectId | null;
  approverNameSnapshot?: string;
  history: Array<{
    action: "submitted" | "approved" | "rejected" | "withdrawn";
    actor: mongoose.Types.ObjectId;
    actorRole: string;
    comment?: string;
    at: Date;
  }>;
  requestedAt: Date;
  decidedAt?: Date | null;
  decidedBy?: mongoose.Types.ObjectId | null;
  decisionComment?: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const LeaveCancellationHistorySchema = new Schema(
  {
    action: {
      type: String,
      enum: ["submitted", "approved", "rejected", "withdrawn"],
      required: true,
    },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorRole: { type: String, required: true, trim: true },
    comment: { type: String, trim: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: true }
);

const LeaveCancellationRequestSchema = new Schema<LeaveCancellationRequestI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    leaveRequest: { type: Schema.Types.ObjectId, ref: "LeaveRequest", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    departmentNameSnapshot: { type: String, trim: true, index: true },
    teamNameSnapshot: { type: String, trim: true, index: true },
    officeLocation: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null, index: true },
    reportingManager: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 2000 },
    status: {
      type: String,
      enum: LEAVE_CANCELLATION_REQUEST_STATUSES,
      default: "submitted",
      required: true,
      index: true,
    },
    approver: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    currentApprovers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    approvalInstance: { type: Schema.Types.ObjectId, ref: "ApprovalInstance", default: null, index: true },
    approverNameSnapshot: { type: String, trim: true },
    history: { type: [LeaveCancellationHistorySchema] as any, default: [] },
    requestedAt: { type: Date, required: true, default: Date.now, index: true },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decisionComment: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

LeaveCancellationRequestSchema.index(
  { company: 1, leaveRequest: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "submitted" } }
);
LeaveCancellationRequestSchema.index({ company: 1, currentApprovers: 1, status: 1, requestedAt: -1 });
LeaveCancellationRequestSchema.index({ company: 1, employee: 1, requestedAt: -1 });

const LeaveCancellationRequest =
  (mongoose.models.LeaveCancellationRequest as mongoose.Model<LeaveCancellationRequestI>) ||
  mongoose.model<LeaveCancellationRequestI>("LeaveCancellationRequest", LeaveCancellationRequestSchema);

export default LeaveCancellationRequest;
