import mongoose, { Document, Schema } from "mongoose";

export interface SalaryStructureI extends Document {
  company: mongoose.Types.ObjectId;
  name: string;
  code: string;
  description?: string;
  status: "active" | "archived";
  latestVersionNumber: number;
  latestPublishedVersion?: mongoose.Types.ObjectId | null;
  createdBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId;
  archivedAt?: Date | null;
  archivedBy?: mongoose.Types.ObjectId | null;
  archiveReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const SalaryStructureSchema = new Schema<SalaryStructureI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: /^[A-Z][A-Z0-9_]{1,29}$/,
      immutable: true,
    },
    description: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: ["active", "archived"], default: "active", index: true },
    latestVersionNumber: { type: Number, min: 1, default: 1 },
    latestPublishedVersion: { type: Schema.Types.ObjectId, ref: "SalaryStructureVersion", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    archiveReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

SalaryStructureSchema.index({ company: 1, code: 1 }, { unique: true });
SalaryStructureSchema.index({ company: 1, status: 1, name: 1 });

const SalaryStructure =
  (mongoose.models.SalaryStructure as mongoose.Model<SalaryStructureI>) ||
  mongoose.model<SalaryStructureI>("SalaryStructure", SalaryStructureSchema);

export default SalaryStructure;

