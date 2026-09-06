import mongoose, { Document, Schema } from "mongoose";
import { APPROVAL_REQUEST_TYPES } from "./ApprovalWorkflow.schema";
import { APPROVAL_STEP_TYPES } from "./ApprovalWorkflowVersion.schema";

export interface ApprovalInstanceI extends Document {
  company: mongoose.Types.ObjectId;
  requestType: (typeof APPROVAL_REQUEST_TYPES)[number];
  requestModel: "LeaveRequest" | "LeaveCancellationRequest" | "LeaveEncashmentRequest" | "RemoteWorkRequest" | "CompOffClaim";
  request: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  workflow: mongoose.Types.ObjectId;
  workflowVersion: mongoose.Types.ObjectId;
  workflowVersionNumber: number;
  workflowNameSnapshot: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  currentStepOrder?: number | null;
  steps: any[];
  history: any[];
  completedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const ResolvedApproverSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    nameSnapshot: { type: String, required: true, trim: true },
    roleSnapshot: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["waiting", "pending", "approved", "rejected", "skipped"],
      default: "waiting",
      required: true,
    },
    actedAt: { type: Date, default: null },
    comment: { type: String, trim: true },
  },
  { _id: true }
);

const ApprovalInstanceStepSchema = new Schema(
  {
    order: { type: Number, required: true, min: 1, max: 10 },
    nameSnapshot: { type: String, required: true, trim: true },
    approverType: { type: String, enum: APPROVAL_STEP_TYPES, required: true },
    approvalRule: { type: String, enum: ["any", "all"], default: "any", required: true },
    fallbackUsed: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["waiting", "pending", "approved", "rejected", "skipped"],
      default: "waiting",
      required: true,
    },
    approvers: { type: [ResolvedApproverSchema], default: [] },
    completedAt: { type: Date, default: null },
  },
  { _id: true }
);

const ApprovalHistorySchema = new Schema(
  {
    action: {
      type: String,
      enum: ["created", "auto_approved", "step_approved", "rejected", "cancelled"],
      required: true,
    },
    stepOrder: { type: Number, default: null },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorNameSnapshot: { type: String, trim: true },
    comment: { type: String, trim: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: true }
);

const ApprovalInstanceSchema = new Schema<ApprovalInstanceI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    requestType: { type: String, enum: APPROVAL_REQUEST_TYPES, required: true, index: true },
    requestModel: {
      type: String,
      enum: ["LeaveRequest", "LeaveCancellationRequest", "LeaveEncashmentRequest", "RemoteWorkRequest", "CompOffClaim"],
      required: true,
    },
    request: { type: Schema.Types.ObjectId, refPath: "requestModel", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    workflow: { type: Schema.Types.ObjectId, ref: "ApprovalWorkflow", required: true },
    workflowVersion: { type: Schema.Types.ObjectId, ref: "ApprovalWorkflowVersion", required: true },
    workflowVersionNumber: { type: Number, required: true, min: 1 },
    workflowNameSnapshot: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
      required: true,
      index: true,
    },
    currentStepOrder: { type: Number, default: null, index: true },
    steps: { type: [ApprovalInstanceStepSchema] as any, default: [] },
    history: { type: [ApprovalHistorySchema] as any, default: [] },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ApprovalInstanceSchema.index(
  { company: 1, requestModel: 1, request: 1 },
  { unique: true }
);
ApprovalInstanceSchema.index({ company: 1, "steps.approvers.user": 1, status: 1 });

const ApprovalInstance =
  (mongoose.models.ApprovalInstance as mongoose.Model<ApprovalInstanceI>) ||
  mongoose.model<ApprovalInstanceI>("ApprovalInstance", ApprovalInstanceSchema);

export default ApprovalInstance;
