import mongoose, { Document, Schema } from "mongoose";

export const APPROVAL_REQUEST_TYPES = [
  "leave_request",
  "remote_work_request",
  "comp_off_claim",
] as const;

export interface ApprovalWorkflowI extends Document {
  company: mongoose.Types.ObjectId;
  name: string;
  code: string;
  description?: string;
  applicableTo: (typeof APPROVAL_REQUEST_TYPES)[number][];
  status: "active" | "archived";
  latestVersionNumber: number;
  createdBy: mongoose.Types.ObjectId;
  archivedAt?: Date | null;
  archivedBy?: mongoose.Types.ObjectId | null;
  archiveReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const ApprovalWorkflowSchema = new Schema<ApprovalWorkflowI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, trim: true },
    applicableTo: {
      type: [{ type: String, enum: APPROVAL_REQUEST_TYPES }],
      required: true,
      validate: {
        validator: (value: string[]) => Array.isArray(value) && value.length > 0,
        message: "Select at least one request type",
      },
    },
    status: { type: String, enum: ["active", "archived"], default: "active", index: true },
    latestVersionNumber: { type: Number, min: 0, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    archiveReason: { type: String, trim: true },
  },
  { timestamps: true }
);

ApprovalWorkflowSchema.index({ company: 1, code: 1 }, { unique: true });
ApprovalWorkflowSchema.index({ company: 1, status: 1, applicableTo: 1, name: 1 });

const ApprovalWorkflow =
  (mongoose.models.ApprovalWorkflow as mongoose.Model<ApprovalWorkflowI>) ||
  mongoose.model<ApprovalWorkflowI>("ApprovalWorkflow", ApprovalWorkflowSchema);

export default ApprovalWorkflow;
