import mongoose, { Document, Schema } from "mongoose";

export const ATTENDANCE_PERIOD_REVISION_ACTIONS = ["locked", "reopened"] as const;

export interface AttendancePeriodRevisionI extends Document {
  company: mongoose.Types.ObjectId;
  attendancePeriod: mongoose.Types.ObjectId;
  periodKey: string;
  version: number;
  action: (typeof ATTENDANCE_PERIOD_REVISION_ACTIONS)[number];
  previousStatus: "open" | "locked";
  nextStatus: "open" | "locked";
  reason: string;
  readinessSnapshot?: Record<string, unknown>;
  actor: mongoose.Types.ObjectId;
  createdAt?: Date;
}

const AttendancePeriodRevisionSchema = new Schema<AttendancePeriodRevisionI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    attendancePeriod: {
      type: Schema.Types.ObjectId,
      ref: "AttendancePeriod",
      required: true,
      index: true,
    },
    periodKey: {
      type: String,
      required: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
      index: true,
    },
    version: { type: Number, required: true, min: 1 },
    action: {
      type: String,
      enum: ATTENDANCE_PERIOD_REVISION_ACTIONS,
      required: true,
      index: true,
    },
    previousStatus: { type: String, enum: ["open", "locked"], required: true },
    nextStatus: { type: String, enum: ["open", "locked"], required: true },
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 1000 },
    readinessSnapshot: { type: Schema.Types.Mixed, default: {} },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AttendancePeriodRevisionSchema.index(
  { company: 1, attendancePeriod: 1, version: 1 },
  { unique: true }
);
AttendancePeriodRevisionSchema.index({ company: 1, periodKey: 1, createdAt: -1 });

const AttendancePeriodRevision =
  (mongoose.models.AttendancePeriodRevision as mongoose.Model<AttendancePeriodRevisionI>) ||
  mongoose.model<AttendancePeriodRevisionI>(
    "AttendancePeriodRevision",
    AttendancePeriodRevisionSchema
  );

export default AttendancePeriodRevision;
