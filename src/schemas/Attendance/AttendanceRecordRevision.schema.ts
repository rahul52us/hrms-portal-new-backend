import mongoose, { Document, Schema } from "mongoose";

export const ATTENDANCE_REVISION_ACTIONS = [
  "created",
  "punch_recorded",
  "calculated",
  "recalculated",
  "manual_adjustment",
  "finalized",
  "reopened",
] as const;

export interface AttendanceRecordRevisionI extends Document {
  company: mongoose.Types.ObjectId;
  attendanceRecord: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  revisionNumber: number;
  action: (typeof ATTENDANCE_REVISION_ACTIONS)[number];
  reason?: string;
  changes?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  actor?: mongoose.Types.ObjectId | null;
  source: "punch" | "import" | "manual" | "system" | "recalculation";
  createdAt?: Date;
}

const AttendanceRecordRevisionSchema = new Schema<AttendanceRecordRevisionI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    attendanceRecord: {
      type: Schema.Types.ObjectId,
      ref: "AttendanceRecord",
      required: true,
      index: true,
    },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    revisionNumber: { type: Number, required: true, min: 1 },
    action: {
      type: String,
      enum: ATTENDANCE_REVISION_ACTIONS,
      required: true,
      index: true,
    },
    reason: { type: String, trim: true },
    changes: { type: Schema.Types.Mixed, default: {} },
    snapshot: { type: Schema.Types.Mixed, default: {} },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    source: {
      type: String,
      enum: ["punch", "import", "manual", "system", "recalculation"],
      required: true,
      default: "system",
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AttendanceRecordRevisionSchema.index(
  { company: 1, attendanceRecord: 1, revisionNumber: 1 },
  { unique: true }
);
AttendanceRecordRevisionSchema.index({ company: 1, employee: 1, createdAt: -1 });

const AttendanceRecordRevision =
  (mongoose.models.AttendanceRecordRevision as mongoose.Model<AttendanceRecordRevisionI>) ||
  mongoose.model<AttendanceRecordRevisionI>(
    "AttendanceRecordRevision",
    AttendanceRecordRevisionSchema
  );

export default AttendanceRecordRevision;
