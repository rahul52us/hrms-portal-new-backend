import mongoose, { Document, Schema } from "mongoose";

export const ATTENDANCE_PERIOD_STATUSES = ["open", "locked"] as const;

export interface AttendancePeriodI extends Document {
  company: mongoose.Types.ObjectId;
  periodKey: string;
  startDate: string;
  endDate: string;
  attendanceCutoffDay: number;
  status: (typeof ATTENDANCE_PERIOD_STATUSES)[number];
  version: number;
  lockedAt?: Date | null;
  lockedBy?: mongoose.Types.ObjectId | null;
  lockReason?: string;
  reopenedAt?: Date | null;
  reopenedBy?: mongoose.Types.ObjectId | null;
  reopenReason?: string;
  createdBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const AttendancePeriodSchema = new Schema<AttendancePeriodI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    periodKey: {
      type: String,
      required: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
      index: true,
    },
    startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    endDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    attendanceCutoffDay: { type: Number, required: true, min: 1, max: 31, default: 31 },
    status: {
      type: String,
      enum: ATTENDANCE_PERIOD_STATUSES,
      required: true,
      default: "open",
      index: true,
    },
    version: { type: Number, required: true, min: 0, default: 0 },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    lockReason: { type: String, trim: true, maxlength: 1000 },
    reopenedAt: { type: Date, default: null },
    reopenedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reopenReason: { type: String, trim: true, maxlength: 1000 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

AttendancePeriodSchema.index({ company: 1, periodKey: 1 }, { unique: true });
AttendancePeriodSchema.index({ company: 1, status: 1, periodKey: -1 });
AttendancePeriodSchema.index({ company: 1, startDate: 1, endDate: 1, status: 1 });

const AttendancePeriod =
  (mongoose.models.AttendancePeriod as mongoose.Model<AttendancePeriodI>) ||
  mongoose.model<AttendancePeriodI>("AttendancePeriod", AttendancePeriodSchema);

export default AttendancePeriod;
