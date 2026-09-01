import mongoose, { Document, Schema } from "mongoose";

export const APPROVAL_STEP_TYPES = [
  "reporting_manager",
  "manager_manager",
  "department_head",
  "hr",
  "specific_users",
] as const;

export interface ApprovalWorkflowStepI {
  order: number;
  name: string;
  approverType: (typeof APPROVAL_STEP_TYPES)[number];
  approvalRule: "any" | "all";
  approverUserIds: mongoose.Types.ObjectId[];
  fallbackToHr: boolean;
}

export interface ApprovalWorkflowVersionI extends Document {
  company: mongoose.Types.ObjectId;
  workflow: mongoose.Types.ObjectId;
  versionNumber: number;
  status: "draft" | "published" | "cancelled";
  effectiveFrom: Date;
  autoApprove: boolean;
  steps: ApprovalWorkflowStepI[];
  changeReason?: string;
  createdBy: mongoose.Types.ObjectId;
  publishedAt?: Date | null;
  publishedBy?: mongoose.Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const ApprovalWorkflowStepSchema = new Schema<ApprovalWorkflowStepI>(
  {
    order: { type: Number, required: true, min: 1, max: 10 },
    name: { type: String, required: true, trim: true },
    approverType: { type: String, enum: APPROVAL_STEP_TYPES, required: true },
    approvalRule: { type: String, enum: ["any", "all"], default: "any", required: true },
    approverUserIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    fallbackToHr: { type: Boolean, default: false },
  },
  { _id: true }
);

const ApprovalWorkflowVersionSchema = new Schema<ApprovalWorkflowVersionI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    workflow: { type: Schema.Types.ObjectId, ref: "ApprovalWorkflow", required: true, index: true },
    versionNumber: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["draft", "published", "cancelled"],
      default: "draft",
      required: true,
      index: true,
    },
    effectiveFrom: { type: Date, required: true, default: Date.now, index: true },
    autoApprove: { type: Boolean, default: false },
    steps: {
      type: [ApprovalWorkflowStepSchema],
      default: [],
      validate: {
        validator: (value: ApprovalWorkflowStepI[]) => {
          const orders = value.map((step) => step.order);
          return value.length <= 10 && new Set(orders).size === orders.length;
        },
        message: "Approval steps must have unique order values and cannot exceed 10 levels",
      },
    },
    changeReason: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

ApprovalWorkflowVersionSchema.index(
  { company: 1, workflow: 1, versionNumber: 1 },
  { unique: true }
);
ApprovalWorkflowVersionSchema.index({ company: 1, workflow: 1, status: 1 });
ApprovalWorkflowVersionSchema.index({ company: 1, workflow: 1, status: 1, effectiveFrom: -1 });

const ApprovalWorkflowVersion =
  (mongoose.models.ApprovalWorkflowVersion as mongoose.Model<ApprovalWorkflowVersionI>) ||
  mongoose.model<ApprovalWorkflowVersionI>(
    "ApprovalWorkflowVersion",
    ApprovalWorkflowVersionSchema
  );

export default ApprovalWorkflowVersion;
