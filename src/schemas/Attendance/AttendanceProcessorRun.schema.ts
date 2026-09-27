import mongoose, { Document, Schema } from "mongoose";

export const ATTENDANCE_PROCESSOR_RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "completed_with_errors",
  "failed",
] as const;

export interface AttendanceProcessorRunI extends Document {
  company: mongoose.Types.ObjectId;
  attendanceDate: string;
  idempotencyKey: string;
  trigger: "manual" | "scheduled" | "cycle_preparation";
  finalizeClean: boolean;
  reason?: string;
  status: (typeof ATTENDANCE_PROCESSOR_RUN_STATUSES)[number];
  active: boolean;
  requestedBy?: mongoose.Types.ObjectId | null;
  batchSize: number;
  checkpointEmployee?: mongoose.Types.ObjectId | null;
  counts: {
    scanned: number;
    processed: number;
    created: number;
    updated: number;
    skipped: number;
    notClosed: number;
    awaitingFinalization: number;
    autoFinalized: number;
    reviewRequired: number;
    setupGaps: number;
    failures: number;
  };
  failures: Array<{
    employee?: mongoose.Types.ObjectId | null;
    employeeCode?: string;
    message: string;
  }>;
  startedAt?: Date | null;
  completedAt?: Date | null;
  durationMs: number;
  lastError?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const ProcessorCountsSchema = new Schema(
  {
    scanned: { type: Number, min: 0, default: 0 },
    processed: { type: Number, min: 0, default: 0 },
    created: { type: Number, min: 0, default: 0 },
    updated: { type: Number, min: 0, default: 0 },
    skipped: { type: Number, min: 0, default: 0 },
    notClosed: { type: Number, min: 0, default: 0 },
    awaitingFinalization: { type: Number, min: 0, default: 0 },
    autoFinalized: { type: Number, min: 0, default: 0 },
    reviewRequired: { type: Number, min: 0, default: 0 },
    setupGaps: { type: Number, min: 0, default: 0 },
    failures: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

const ProcessorFailureSchema = new Schema(
  {
    employee: { type: Schema.Types.ObjectId, ref: "User", default: null },
    employeeCode: { type: String, trim: true },
    message: { type: String, required: true, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const AttendanceProcessorRunSchema = new Schema<AttendanceProcessorRunI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    attendanceDate: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    idempotencyKey: { type: String, required: true, trim: true, minlength: 8, maxlength: 200 },
    trigger: {
      type: String,
      enum: ["manual", "scheduled", "cycle_preparation"],
      required: true,
      default: "manual",
    },
    finalizeClean: { type: Boolean, required: true, default: false },
    reason: { type: String, trim: true, maxlength: 1000 },
    status: {
      type: String,
      enum: ATTENDANCE_PROCESSOR_RUN_STATUSES,
      required: true,
      default: "pending",
      index: true,
    },
    active: { type: Boolean, required: true, default: true, index: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    batchSize: { type: Number, min: 10, max: 500, default: 100 },
    checkpointEmployee: { type: Schema.Types.ObjectId, ref: "User", default: null },
    counts: { type: ProcessorCountsSchema, required: true, default: () => ({}) },
    failures: { type: [ProcessorFailureSchema], default: [] },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    durationMs: { type: Number, min: 0, default: 0 },
    lastError: { type: String, trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);

AttendanceProcessorRunSchema.index({ company: 1, idempotencyKey: 1 }, { unique: true });
AttendanceProcessorRunSchema.index(
  { company: 1, attendanceDate: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);
AttendanceProcessorRunSchema.index({ company: 1, attendanceDate: -1, createdAt: -1 });

const AttendanceProcessorRun =
  (mongoose.models.AttendanceProcessorRun as mongoose.Model<AttendanceProcessorRunI>) ||
  mongoose.model<AttendanceProcessorRunI>(
    "AttendanceProcessorRun",
    AttendanceProcessorRunSchema
  );

export default AttendanceProcessorRun;
