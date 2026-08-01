import mongoose, { Document, Schema } from "mongoose";

export const WORK_SCHEDULE_DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export const WORK_SCHEDULE_SATURDAY_RULES = [
  "working",
  "all_off",
  "first_and_third_off",
  "second_and_fourth_off",
  "custom_weeks_off",
] as const;

export interface WorkScheduleRules {
  timezone: string;
  workingDays: string[];
  saturdayRule: (typeof WORK_SCHEDULE_SATURDAY_RULES)[number];
  customSaturdayOffWeeks: number[];
  startTime: string;
  endTime: string;
  unpaidBreakMinutes: number;
}

export interface WorkScheduleVersionI extends Document {
  company: mongoose.Types.ObjectId;
  schedule: mongoose.Types.ObjectId;
  versionNumber: number;
  status: "draft" | "published" | "cancelled";
  effectiveFrom?: Date | null;
  changeReason?: string;
  rules: WorkScheduleRules;
  createdBy: mongoose.Types.ObjectId;
  publishedAt?: Date | null;
  publishedBy?: mongoose.Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const WorkScheduleRulesSchema = new Schema<WorkScheduleRules>(
  {
    timezone: { type: String, required: true, trim: true, default: "Asia/Kolkata" },
    workingDays: {
      type: [String],
      enum: WORK_SCHEDULE_DAYS,
      default: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    },
    saturdayRule: {
      type: String,
      enum: WORK_SCHEDULE_SATURDAY_RULES,
      default: "all_off",
    },
    customSaturdayOffWeeks: {
      type: [Number],
      default: [],
      validate: {
        validator: (values: number[]) =>
          values.every((value) => Number.isInteger(value) && value >= 1 && value <= 5),
        message: "Custom Saturday week numbers must be between 1 and 5",
      },
    },
    startTime: { type: String, required: true, default: "09:30" },
    endTime: { type: String, required: true, default: "18:30" },
    unpaidBreakMinutes: { type: Number, min: 0, default: 60 },
  },
  { _id: false }
);

const WorkScheduleVersionSchema = new Schema<WorkScheduleVersionI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    schedule: { type: Schema.Types.ObjectId, ref: "WorkSchedule", required: true, index: true },
    versionNumber: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["draft", "published", "cancelled"],
      default: "draft",
      index: true,
    },
    effectiveFrom: { type: Date, default: null, index: true },
    changeReason: { type: String, trim: true },
    rules: { type: WorkScheduleRulesSchema, required: true, default: () => ({}) },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

WorkScheduleVersionSchema.index(
  { company: 1, schedule: 1, versionNumber: 1 },
  { unique: true }
);
WorkScheduleVersionSchema.index({ company: 1, schedule: 1, status: 1, effectiveFrom: -1 });

const WorkScheduleVersion =
  (mongoose.models.WorkScheduleVersion as mongoose.Model<WorkScheduleVersionI>) ||
  mongoose.model<WorkScheduleVersionI>("WorkScheduleVersion", WorkScheduleVersionSchema);

export default WorkScheduleVersion;
