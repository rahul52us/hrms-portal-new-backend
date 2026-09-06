import mongoose, { Document, Schema } from "mongoose";

export const LEAVE_ACCRUAL_FREQUENCIES = ["upfront", "monthly", "quarterly", "none"] as const;
export const LEAVE_PROBATION_RULES = ["allowed", "after_confirmation", "not_allowed"] as const;
export const LEAVE_CREDIT_COMPONENT_FREQUENCIES = ["upfront", "monthly", "quarterly"] as const;
export const LEAVE_UPFRONT_CREDIT_TIMINGS = ["leave_year_start", "first_eligibility"] as const;
export const LEAVE_ENTITLEMENT_MODES = ["fixed", "earned", "manual", "untracked"] as const;
export const LEAVE_DOCUMENT_SUBMISSION_MODES = ["with_request", "allow_later"] as const;

export interface LeaveCreditComponent {
  componentId: string;
  frequency: (typeof LEAVE_CREDIT_COMPONENT_FREQUENCIES)[number];
  amount: number;
  upfrontTiming: (typeof LEAVE_UPFRONT_CREDIT_TIMINGS)[number];
  prorateOnJoining: boolean;
  prorateOnExit: boolean;
}

export interface LeavePolicyRule {
  leaveType: mongoose.Types.ObjectId;
  leaveTypeCodeSnapshot: string;
  leaveTypeNameSnapshot: string;
  paid: boolean;
  balanceTracked: boolean;
  entitlementMode: (typeof LEAVE_ENTITLEMENT_MODES)[number];
  annualEntitlement: number;
  accrualFrequency: (typeof LEAVE_ACCRUAL_FREQUENCIES)[number];
  accrualAmount: number;
  creditComponents: LeaveCreditComponent[];
  prorateOnJoining: boolean;
  prorateOnExit: boolean;
  carryForwardEnabled: boolean;
  maxCarryForward: number;
  carryForwardExpiryMonths: number;
  encashmentEnabled: boolean;
  maxEncashmentPerYear: number;
  encashmentApprovalWorkflow?: mongoose.Types.ObjectId | null;
  encashmentApprovalWorkflowVersion?: mongoose.Types.ObjectId | null;
  encashmentApprovalWorkflowVersionNumber?: number | null;
  negativeBalanceAllowed: boolean;
  maxNegativeBalance: number;
  allowHalfDay: boolean;
  minimumRequestDays: number;
  maximumRequestDays?: number | null;
  minimumNoticeDays: number;
  documentRequiredFromUnits?: number | null;
  documentSubmissionMode: (typeof LEAVE_DOCUMENT_SUBMISSION_MODES)[number];
  documentDueDaysAfterLeaveEnd: number;
  documentRequiredAfterDays?: number | null;
  probationEligibility: (typeof LEAVE_PROBATION_RULES)[number];
  sandwichRuleEnabled: boolean;
  compOffValidityDays: number;
  compOffFullDayMinutes: number;
  compOffHalfDayMinutes: number;
  requestApprovalWorkflow?: mongoose.Types.ObjectId | null;
  requestApprovalWorkflowVersion?: mongoose.Types.ObjectId | null;
  requestApprovalWorkflowVersionNumber?: number | null;
  compOffClaimApprovalWorkflow?: mongoose.Types.ObjectId | null;
  compOffClaimApprovalWorkflowVersion?: mongoose.Types.ObjectId | null;
  compOffClaimApprovalWorkflowVersionNumber?: number | null;
}

const LeaveCreditComponentSchema = new Schema<LeaveCreditComponent>(
  {
    componentId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      match: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/,
    },
    frequency: { type: String, enum: LEAVE_CREDIT_COMPONENT_FREQUENCIES, required: true },
    amount: { type: Number, min: 0, required: true },
    upfrontTiming: {
      type: String,
      enum: LEAVE_UPFRONT_CREDIT_TIMINGS,
      default: "leave_year_start",
    },
    prorateOnJoining: { type: Boolean, default: true },
    prorateOnExit: { type: Boolean, default: true },
  },
  { _id: false }
);

export interface LeavePolicyVersionI extends Document {
  company: mongoose.Types.ObjectId;
  policy: mongoose.Types.ObjectId;
  versionNumber: number;
  status: "draft" | "published" | "cancelled";
  effectiveFrom?: Date | null;
  leaveYearStartMonth: number;
  leaveYearStartDay: number;
  rules: LeavePolicyRule[];
  changeReason?: string;
  createdBy: mongoose.Types.ObjectId;
  publishedAt?: Date | null;
  publishedBy?: mongoose.Types.ObjectId | null;
  cancelledAt?: Date | null;
  cancelledBy?: mongoose.Types.ObjectId | null;
  cancellationReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const LeavePolicyRuleSchema = new Schema<LeavePolicyRule>(
  {
    leaveType: { type: Schema.Types.ObjectId, ref: "LeaveType", required: true },
    leaveTypeCodeSnapshot: { type: String, required: true, trim: true, uppercase: true },
    leaveTypeNameSnapshot: { type: String, required: true, trim: true },
    paid: { type: Boolean, required: true },
    balanceTracked: { type: Boolean, required: true },
    entitlementMode: {
      type: String,
      enum: LEAVE_ENTITLEMENT_MODES,
      default: "fixed",
      required: true,
    },
    annualEntitlement: { type: Number, min: 0, default: 0 },
    accrualFrequency: { type: String, enum: LEAVE_ACCRUAL_FREQUENCIES, default: "upfront" },
    accrualAmount: { type: Number, min: 0, default: 0 },
    creditComponents: {
      type: [LeaveCreditComponentSchema],
      default: [],
      validate: {
        validator(value: LeaveCreditComponent[]) {
          const ids = value.map((component) => component.componentId);
          return ids.length === new Set(ids).size;
        },
        message: "Credit component IDs must be unique within a leave rule",
      },
    },
    prorateOnJoining: { type: Boolean, default: true },
    prorateOnExit: { type: Boolean, default: true },
    carryForwardEnabled: { type: Boolean, default: false },
    maxCarryForward: { type: Number, min: 0, default: 0 },
    carryForwardExpiryMonths: { type: Number, min: 0, max: 120, default: 0 },
    encashmentEnabled: { type: Boolean, default: false },
    maxEncashmentPerYear: { type: Number, min: 0, default: 0 },
    encashmentApprovalWorkflow: { type: Schema.Types.ObjectId, ref: "ApprovalWorkflow", default: null },
    encashmentApprovalWorkflowVersion: { type: Schema.Types.ObjectId, ref: "ApprovalWorkflowVersion", default: null },
    encashmentApprovalWorkflowVersionNumber: { type: Number, min: 1, default: null },
    negativeBalanceAllowed: { type: Boolean, default: false },
    maxNegativeBalance: { type: Number, min: 0, default: 0 },
    allowHalfDay: { type: Boolean, default: true },
    minimumRequestDays: { type: Number, min: 0.25, default: 1 },
    maximumRequestDays: { type: Number, min: 0.25, default: null },
    minimumNoticeDays: { type: Number, min: 0, default: 0 },
    documentRequiredFromUnits: { type: Number, min: 0.25, default: null },
    documentSubmissionMode: {
      type: String,
      enum: LEAVE_DOCUMENT_SUBMISSION_MODES,
      default: "allow_later",
    },
    documentDueDaysAfterLeaveEnd: { type: Number, min: 0, max: 365, default: 2 },
    // Retained only so existing published policy versions continue to resolve.
    documentRequiredAfterDays: { type: Number, min: 0.25, default: null },
    probationEligibility: { type: String, enum: LEAVE_PROBATION_RULES, default: "allowed" },
    sandwichRuleEnabled: { type: Boolean, default: false },
    compOffValidityDays: { type: Number, min: 1, max: 730, default: 90 },
    compOffFullDayMinutes: { type: Number, min: 1, max: 1440, default: 480 },
    compOffHalfDayMinutes: { type: Number, min: 1, max: 1440, default: 240 },
    requestApprovalWorkflow: { type: Schema.Types.ObjectId, ref: "ApprovalWorkflow", default: null },
    requestApprovalWorkflowVersion: { type: Schema.Types.ObjectId, ref: "ApprovalWorkflowVersion", default: null },
    requestApprovalWorkflowVersionNumber: { type: Number, min: 1, default: null },
    compOffClaimApprovalWorkflow: { type: Schema.Types.ObjectId, ref: "ApprovalWorkflow", default: null },
    compOffClaimApprovalWorkflowVersion: { type: Schema.Types.ObjectId, ref: "ApprovalWorkflowVersion", default: null },
    compOffClaimApprovalWorkflowVersionNumber: { type: Number, min: 1, default: null },
  },
  { _id: true }
);

const LeavePolicyVersionSchema = new Schema<LeavePolicyVersionI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    policy: { type: Schema.Types.ObjectId, ref: "LeavePolicy", required: true, index: true },
    versionNumber: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ["draft", "published", "cancelled"], default: "draft", index: true },
    effectiveFrom: { type: Date, default: null, index: true },
    leaveYearStartMonth: { type: Number, min: 1, max: 12, default: 1 },
    leaveYearStartDay: { type: Number, min: 1, max: 31, default: 1 },
    rules: {
      type: [LeavePolicyRuleSchema],
      default: [],
      validate: {
        validator(value: LeavePolicyRule[]) {
          const ids = value.map((rule) => String(rule.leaveType));
          return ids.length === new Set(ids).size;
        },
        message: "A leave type can appear only once in a policy version",
      },
    },
    changeReason: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancellationReason: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

LeavePolicyVersionSchema.index({ company: 1, policy: 1, versionNumber: 1 }, { unique: true });
LeavePolicyVersionSchema.index({ company: 1, policy: 1, status: 1, effectiveFrom: -1 });

const LeavePolicyVersion =
  (mongoose.models.LeavePolicyVersion as mongoose.Model<LeavePolicyVersionI>) ||
  mongoose.model<LeavePolicyVersionI>("LeavePolicyVersion", LeavePolicyVersionSchema);

export default LeavePolicyVersion;
