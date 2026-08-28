import mongoose, { Document, Schema } from "mongoose";

export const REMOTE_WORK_APPROVAL_MODES = [
  "reporting_manager",
  "hr",
  "manager_then_hr",
  "auto_approve",
] as const;

export const REMOTE_WORK_WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export interface RemoteWorkRules {
  approvalMode: (typeof REMOTE_WORK_APPROVAL_MODES)[number];
  approvalWorkflow?: mongoose.Types.ObjectId | null;
  approvalWorkflowVersion?: mongoose.Types.ObjectId | null;
  approvalWorkflowVersionNumber?: number | null;
  allowedWeekdays: string[];
  maxDaysPerWeek: number;
  maxDaysPerMonth: number;
  maxConsecutiveDays: number;
  minimumNoticeDays: number;
  maximumAdvanceDays: number;
  allowHalfDay: boolean;
  requireReason: boolean;
  minimumReasonLength: number;
  probationEligibility: "allowed" | "after_confirmation" | "not_allowed";
}

export interface RemoteWorkPolicyVersionI extends Document {
  company: mongoose.Types.ObjectId;
  policy: mongoose.Types.ObjectId;
  versionNumber: number;
  status: "draft" | "published" | "cancelled";
  effectiveFrom?: Date | null;
  changeReason?: string;
  rules: RemoteWorkRules;
  createdBy: mongoose.Types.ObjectId;
  publishedAt?: Date | null;
  publishedBy?: mongoose.Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const RemoteWorkRulesSchema = new Schema<RemoteWorkRules>(
  {
    approvalMode: {
      type: String,
      enum: REMOTE_WORK_APPROVAL_MODES,
      required: true,
      default: "reporting_manager",
    },
    approvalWorkflow: { type: Schema.Types.ObjectId, ref: "ApprovalWorkflow", default: null },
    approvalWorkflowVersion: { type: Schema.Types.ObjectId, ref: "ApprovalWorkflowVersion", default: null },
    approvalWorkflowVersionNumber: { type: Number, min: 1, default: null },
    allowedWeekdays: {
      type: [String],
      enum: REMOTE_WORK_WEEKDAYS,
      default: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    },
    maxDaysPerWeek: { type: Number, min: 0, max: 7, default: 0 },
    maxDaysPerMonth: { type: Number, min: 0, max: 31, default: 0 },
    maxConsecutiveDays: { type: Number, min: 0, max: 31, default: 0 },
    minimumNoticeDays: { type: Number, min: 0, max: 365, default: 0 },
    maximumAdvanceDays: { type: Number, min: 0, max: 730, default: 90 },
    allowHalfDay: { type: Boolean, default: true },
    requireReason: { type: Boolean, default: true },
    minimumReasonLength: { type: Number, min: 0, max: 500, default: 10 },
    probationEligibility: {
      type: String,
      enum: ["allowed", "after_confirmation", "not_allowed"],
      default: "allowed",
    },
  },
  { _id: false }
);

const RemoteWorkPolicyVersionSchema = new Schema<RemoteWorkPolicyVersionI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    policy: { type: Schema.Types.ObjectId, ref: "RemoteWorkPolicy", required: true, index: true },
    versionNumber: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["draft", "published", "cancelled"],
      default: "draft",
      index: true,
    },
    effectiveFrom: { type: Date, default: null, index: true },
    changeReason: { type: String, trim: true },
    rules: { type: RemoteWorkRulesSchema, required: true, default: () => ({}) },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

RemoteWorkPolicyVersionSchema.index(
  { company: 1, policy: 1, versionNumber: 1 },
  { unique: true }
);
RemoteWorkPolicyVersionSchema.index({ company: 1, policy: 1, status: 1, effectiveFrom: -1 });

const RemoteWorkPolicyVersion =
  (mongoose.models.RemoteWorkPolicyVersion as mongoose.Model<RemoteWorkPolicyVersionI>) ||
  mongoose.model<RemoteWorkPolicyVersionI>(
    "RemoteWorkPolicyVersion",
    RemoteWorkPolicyVersionSchema
  );

export default RemoteWorkPolicyVersion;
