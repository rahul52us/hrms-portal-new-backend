import mongoose, { Document, Schema } from "mongoose";

export const COMPENSATION_IMPORT_STATUSES = ["previewed", "completed", "failed"] as const;

export interface CompensationImportBatchI extends Document {
  company: mongoose.Types.ObjectId;
  fileName: string;
  fileHash: string;
  status: (typeof COMPENSATION_IMPORT_STATUSES)[number];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  committedRows: number;
  createdBy: mongoose.Types.ObjectId;
  committedBy?: mongoose.Types.ObjectId | null;
  committedAt?: Date | null;
  result?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

const CompensationImportBatchSchema = new Schema<CompensationImportBatchI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    fileName: { type: String, required: true, trim: true, maxlength: 255, immutable: true },
    fileHash: { type: String, required: true, trim: true, match: /^[a-f0-9]{64}$/, immutable: true },
    status: { type: String, enum: COMPENSATION_IMPORT_STATUSES, default: "previewed", required: true, index: true },
    totalRows: { type: Number, min: 1, max: 1000, required: true, immutable: true },
    validRows: { type: Number, min: 0, required: true, immutable: true },
    invalidRows: { type: Number, min: 0, required: true, immutable: true },
    committedRows: { type: Number, min: 0, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    committedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    committedAt: { type: Date, default: null },
    result: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

CompensationImportBatchSchema.index({ company: 1, createdAt: -1 });
CompensationImportBatchSchema.index({ company: 1, fileHash: 1, createdBy: 1 });

const CompensationImportBatch =
  (mongoose.models.CompensationImportBatch as mongoose.Model<CompensationImportBatchI>) ||
  mongoose.model<CompensationImportBatchI>("CompensationImportBatch", CompensationImportBatchSchema);

export default CompensationImportBatch;
