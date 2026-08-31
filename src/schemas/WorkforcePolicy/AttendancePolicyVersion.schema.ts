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
