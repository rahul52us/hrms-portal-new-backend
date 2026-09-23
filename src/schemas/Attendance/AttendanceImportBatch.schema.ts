import mongoose, { Document, Schema } from "mongoose";

export const ATTENDANCE_IMPORT_STATUSES = [
  "processing",
  "completed",
  "completed_with_errors",
  "failed",
] as const;

export interface AttendanceImportBatchI extends Document {
  company: mongoose.Types.ObjectId;
  idempotencyKey: string;
  fileName: string;
  fileHash: string;
  status: (typeof ATTENDANCE_IMPORT_STATUSES)[number];
  totalRows: number;
  appliedRows: number;
  failedRows: number;
  result?: Record<string, unknown>;
  createdBy: mongoose.Types.ObjectId;
  completedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const AttendanceImportBatchSchema = new Schema<AttendanceImportBatchI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 200 },
    fileName: { type: String, required: true, trim: true, maxlength: 255 },
    fileHash: { type: String, required: true, trim: true },
    status: { type: String, enum: ATTENDANCE_IMPORT_STATUSES, required: true, default: "processing", index: true },
    totalRows: { type: Number, min: 0, default: 0 },
    appliedRows: { type: Number, min: 0, default: 0 },
    failedRows: { type: Number, min: 0, default: 0 },
    result: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

AttendanceImportBatchSchema.index({ company: 1, idempotencyKey: 1 }, { unique: true });
AttendanceImportBatchSchema.index({ company: 1, createdAt: -1 });

const AttendanceImportBatch =
  (mongoose.models.AttendanceImportBatch as mongoose.Model<AttendanceImportBatchI>) ||
  mongoose.model<AttendanceImportBatchI>("AttendanceImportBatch", AttendanceImportBatchSchema);

export default AttendanceImportBatch;
