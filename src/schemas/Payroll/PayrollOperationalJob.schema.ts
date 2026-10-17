import mongoose, { Document, Schema } from "mongoose";

export const PAYROLL_OPERATIONAL_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "exhausted",
] as const;

export interface PayrollOperationalJobI extends Document {
  company: mongoose.Types.ObjectId;
  jobType: "scheduled_reminders";
  idempotencyKey: string;
  trigger: "manual" | "scheduler" | "recovery";
  status: (typeof PAYROLL_OPERATIONAL_JOB_STATUSES)[number];
  attempts: number;
  maxAttempts: number;
  requestedBy?: mongoose.Types.ObjectId | null;
  lockedAt?: Date | null;
  lockExpiresAt?: Date | null;
  lockToken?: string | null;
  nextRetryAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  durationMs?: number | null;
  metrics: Record<string, number>;
  lastError?: { code?: string; message?: string } | null;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const PayrollOperationalJobSchema = new Schema<PayrollOperationalJobI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    jobType: { type: String, enum: ["scheduled_reminders"], required: true, index: true },
    idempotencyKey: { type: String, required: true, trim: true, minlength: 8, maxlength: 160 },
    trigger: { type: String, enum: ["manual", "scheduler", "recovery"], required: true },
    status: { type: String, enum: PAYROLL_OPERATIONAL_JOB_STATUSES, required: true, default: "queued", index: true },
    attempts: { type: Number, required: true, min: 0, default: 0 },
    maxAttempts: { type: Number, required: true, min: 1, max: 10, default: 3 },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    lockedAt: { type: Date, default: null },
    lockExpiresAt: { type: Date, default: null, index: true },
    lockToken: { type: String, default: null },
    nextRetryAt: { type: Date, default: null, index: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    durationMs: { type: Number, min: 0, default: null },
    metrics: { type: Schema.Types.Mixed, default: {} },
    lastError: {
      code: { type: String, trim: true, maxlength: 80 },
      message: { type: String, trim: true, maxlength: 500 },
    },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

PayrollOperationalJobSchema.index({ company: 1, jobType: 1, idempotencyKey: 1 }, { unique: true });
PayrollOperationalJobSchema.index({ company: 1, createdAt: -1 });
PayrollOperationalJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const PayrollOperationalJob =
  (mongoose.models.PayrollOperationalJob as mongoose.Model<PayrollOperationalJobI>) ||
  mongoose.model<PayrollOperationalJobI>("PayrollOperationalJob", PayrollOperationalJobSchema);

export default PayrollOperationalJob;
