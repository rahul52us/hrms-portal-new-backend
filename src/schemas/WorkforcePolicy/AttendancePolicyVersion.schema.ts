import mongoose, { Document, Schema } from "mongoose";

export interface AttendanceRules {
  gracePeriodMinutesLate: number;
  gracePeriodMinutesEarly: number;
  minimumFullDayMinutes: number;
  minimumHalfDayMinutes: number;
  requirePunchOut: boolean;
  missingPunchTreatment: "flag_incomplete" | "half_day" | "absent";
  overtimeEnabled: boolean;
  overtimeStartsAfterMinutes: number;
  overtimeApproval: AttendanceOvertimeApprovalRules;
  officeGeofence: AttendanceOfficeGeofenceRules;
  punchNetwork: AttendancePunchNetworkRules;
  trustedDevice: AttendanceTrustedDeviceRules;
  autoFinalize: AttendanceAutoFinalizeRules;
  regularization: AttendanceRegularizationRules;
}

export interface AttendanceOvertimeApprovalRules {
  required: boolean;
  approvalWorkflow?: mongoose.Types.ObjectId | null;
  approvalWorkflowVersion?: mongoose.Types.ObjectId | null;
  approvalWorkflowVersionNumber?: number | null;
}

export interface AttendanceOfficeGeofenceRules {
  enabled: boolean;
  radiusMeters: number;
  validateOn: "punch_in" | "punch_in_and_out";
  unavailableAction: "block" | "allow";
}

export interface AttendancePunchNetworkRules {
  enabled: boolean;
  allowedNetworks: string[];
  scope: "office_only" | "all_punches";
}

export interface AttendanceTrustedDeviceRules {
  enabled: boolean;
  scope: "office_only" | "all_punches";
}

export interface AttendanceAutoFinalizeRules {
  enabled: boolean;
  graceMinutes: number;
  mode: "clean_only" | "all_calculated";
}

export const ATTENDANCE_REGULARIZATION_TYPES = [
  "missing_punch_in",
  "missing_punch_out",
  "time_correction",
  "work_mode_correction",
  "full_day_correction",
] as const;

export interface AttendanceRegularizationRules {
  enabled: boolean;
  allowedTypes: (typeof ATTENDANCE_REGULARIZATION_TYPES)[number][];
  requestStartDays: number;
  maxBackdateDays: number;
  monthlyRequestLimit: number;
  minimumReasonLength: number;
  documentMode: "none" | "optional" | "required";
  approvalWorkflow?: mongoose.Types.ObjectId | null;
  approvalWorkflowVersion?: mongoose.Types.ObjectId | null;
  approvalWorkflowVersionNumber?: number | null;
}

export interface AttendancePolicyVersionI extends Document {
  company: mongoose.Types.ObjectId;
  policy: mongoose.Types.ObjectId;
  versionNumber: number;
  status: "draft" | "published" | "cancelled";
  effectiveFrom?: Date | null;
  changeReason?: string;
  rules: AttendanceRules;
  createdBy: mongoose.Types.ObjectId;
  publishedAt?: Date | null;
  publishedBy?: mongoose.Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const AttendanceRulesSchema = new Schema<AttendanceRules>(
  {
    gracePeriodMinutesLate: { type: Number, min: 0, default: 0 },
    gracePeriodMinutesEarly: { type: Number, min: 0, default: 0 },
    minimumFullDayMinutes: { type: Number, min: 1, default: 480 },
    minimumHalfDayMinutes: { type: Number, min: 1, default: 240 },
    requirePunchOut: { type: Boolean, default: true },
    missingPunchTreatment: {
      type: String,
      enum: ["flag_incomplete", "half_day", "absent"],
      default: "flag_incomplete",
    },
    overtimeEnabled: { type: Boolean, default: false },
    overtimeStartsAfterMinutes: { type: Number, min: 0, default: 0 },
    overtimeApproval: {
      type: new Schema<AttendanceOvertimeApprovalRules>(
        {
          required: { type: Boolean, default: false },
          approvalWorkflow: { type: Schema.Types.ObjectId, ref: "ApprovalWorkflow", default: null },
          approvalWorkflowVersion: {
            type: Schema.Types.ObjectId,
            ref: "ApprovalWorkflowVersion",
            default: null,
          },
          approvalWorkflowVersionNumber: { type: Number, min: 1, default: null },
        },
        { _id: false }
      ),
      required: true,
      default: () => ({}),
    },
    officeGeofence: {
      type: new Schema<AttendanceOfficeGeofenceRules>(
        {
          enabled: { type: Boolean, default: false },
          radiusMeters: { type: Number, min: 50, max: 10000, default: 200 },
          validateOn: {
            type: String,
            enum: ["punch_in", "punch_in_and_out"],
            default: "punch_in",
          },
          unavailableAction: {
            type: String,
            enum: ["block", "allow"],
            default: "block",
          },
        },
        { _id: false }
      ),
      required: true,
      default: () => ({}),
    },
    punchNetwork: {
      type: new Schema<AttendancePunchNetworkRules>(
        {
          enabled: { type: Boolean, default: false },
          allowedNetworks: { type: [{ type: String, trim: true }], default: [] },
          scope: {
            type: String,
            enum: ["office_only", "all_punches"],
            default: "office_only",
          },
        },
        { _id: false }
      ),
      required: true,
      default: () => ({}),
    },
    trustedDevice: {
      type: new Schema<AttendanceTrustedDeviceRules>(
        {
          enabled: { type: Boolean, default: false },
          scope: {
            type: String,
            enum: ["office_only", "all_punches"],
            default: "all_punches",
          },
        },
        { _id: false }
      ),
      required: true,
      default: () => ({}),
    },
    autoFinalize: {
      type: new Schema<AttendanceAutoFinalizeRules>(
        {
          enabled: { type: Boolean, default: false },
          graceMinutes: { type: Number, min: 0, max: 2880, default: 1440 },
          mode: {
            type: String,
            enum: ["clean_only", "all_calculated"],
            default: "clean_only",
          },
        },
        { _id: false }
      ),
      required: true,
      default: () => ({}),
    },
    regularization: {
      type: new Schema<AttendanceRegularizationRules>(
        {
          enabled: { type: Boolean, default: false },
          allowedTypes: {
            type: [{ type: String, enum: ATTENDANCE_REGULARIZATION_TYPES }],
            default: [...ATTENDANCE_REGULARIZATION_TYPES],
          },
          requestStartDays: { type: Number, min: 0, max: 365, default: 0 },
          maxBackdateDays: { type: Number, min: 1, max: 365, default: 30 },
          monthlyRequestLimit: { type: Number, min: 0, max: 100, default: 3 },
          minimumReasonLength: { type: Number, min: 3, max: 500, default: 10 },
          documentMode: {
            type: String,
            enum: ["none", "optional", "required"],
            default: "none",
          },
          approvalWorkflow: { type: Schema.Types.ObjectId, ref: "ApprovalWorkflow", default: null },
          approvalWorkflowVersion: {
            type: Schema.Types.ObjectId,
            ref: "ApprovalWorkflowVersion",
            default: null,
          },
          approvalWorkflowVersionNumber: { type: Number, min: 1, default: null },
        },
        { _id: false }
      ),
      required: true,
      default: () => ({}),
    },
  },
  { _id: false }
);

const AttendancePolicyVersionSchema = new Schema<AttendancePolicyVersionI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    policy: { type: Schema.Types.ObjectId, ref: "AttendancePolicy", required: true, index: true },
    versionNumber: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["draft", "published", "cancelled"],
      default: "draft",
      index: true,
    },
    effectiveFrom: { type: Date, default: null, index: true },
    changeReason: { type: String, trim: true },
    rules: { type: AttendanceRulesSchema, required: true, default: () => ({}) },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

AttendancePolicyVersionSchema.index({ company: 1, policy: 1, versionNumber: 1 }, { unique: true });
AttendancePolicyVersionSchema.index({ company: 1, policy: 1, status: 1, effectiveFrom: -1 });

const AttendancePolicyVersion =
  (mongoose.models.AttendancePolicyVersion as mongoose.Model<AttendancePolicyVersionI>) ||
  mongoose.model<AttendancePolicyVersionI>("AttendancePolicyVersion", AttendancePolicyVersionSchema);

export default AttendancePolicyVersion;
