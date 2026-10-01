import mongoose, { Document, Schema } from "mongoose";

export const COMPENSATION_IMPORT_ROW_STATUSES = ["valid", "invalid", "committed"] as const;

export interface CompensationImportRowI extends Document {
  company: mongoose.Types.ObjectId;
  batch: mongoose.Types.ObjectId;
  rowNumber: number;
  employeeCode: string;
  salaryStructureCode: string;
  effectiveFrom: string;
  assignmentReason: string;
  overrideInputs: Array<{ componentCode: string; amount: string }>;
  status: (typeof COMPENSATION_IMPORT_ROW_STATUSES)[number];
  validationErrors: string[];
  employee?: mongoose.Types.ObjectId | null;
  employeeNameSnapshot?: string;
  salaryStructure?: mongoose.Types.ObjectId | null;
  salaryStructureVersion?: mongoose.Types.ObjectId | null;
  structureNameSnapshot?: string;
  structureVersionNumber?: number | null;
  currency?: string;
  currencyMinorUnits?: number | null;
  resolvedOverrides: Array<{
    salaryComponent: mongoose.Types.ObjectId;
    componentCodeSnapshot: string;
    componentNameSnapshot: string;
    monthlyAmountMinor: number;
  }>;
  previewTotals?: Record<string, number>;
  assignment?: mongoose.Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const OverrideInputSchema = new Schema(
  {
    componentCode: { type: String, required: true, trim: true, uppercase: true },
    amount: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const ResolvedOverrideSchema = new Schema(
  {
    salaryComponent: { type: Schema.Types.ObjectId, ref: "SalaryComponent", required: true },
    componentCodeSnapshot: { type: String, required: true, trim: true, uppercase: true },
    componentNameSnapshot: { type: String, required: true, trim: true },
    monthlyAmountMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const CompensationImportRowSchema = new Schema<CompensationImportRowI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    batch: { type: Schema.Types.ObjectId, ref: "CompensationImportBatch", required: true, index: true, immutable: true },
    rowNumber: { type: Number, required: true, min: 2, immutable: true },
    employeeCode: { type: String, default: "", trim: true, uppercase: true, immutable: true },
    salaryStructureCode: { type: String, default: "", trim: true, uppercase: true, immutable: true },
    effectiveFrom: { type: String, default: "", trim: true, immutable: true },
    assignmentReason: { type: String, default: "", trim: true, maxlength: 500, immutable: true },
    overrideInputs: { type: [OverrideInputSchema], default: [], immutable: true },
    status: { type: String, enum: COMPENSATION_IMPORT_ROW_STATUSES, required: true, index: true },
    validationErrors: { type: [String], default: [] },
    employee: { type: Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
    employeeNameSnapshot: { type: String, trim: true, immutable: true },
    salaryStructure: { type: Schema.Types.ObjectId, ref: "SalaryStructure", default: null, immutable: true },
    salaryStructureVersion: { type: Schema.Types.ObjectId, ref: "SalaryStructureVersion", default: null, immutable: true },
    structureNameSnapshot: { type: String, trim: true, immutable: true },
    structureVersionNumber: { type: Number, min: 1, default: null, immutable: true },
    currency: { type: String, trim: true, uppercase: true, match: /^[A-Z]{3}$/, immutable: true },
    currencyMinorUnits: { type: Number, min: 0, max: 3, default: null, immutable: true },
    resolvedOverrides: { type: [ResolvedOverrideSchema], default: [], immutable: true },
    previewTotals: { type: Schema.Types.Mixed, default: {}, immutable: true },
    assignment: { type: Schema.Types.ObjectId, ref: "EmployeeCompensationAssignment", default: null },
  },
  { timestamps: true }
);

CompensationImportRowSchema.index({ company: 1, batch: 1, rowNumber: 1 }, { unique: true });
CompensationImportRowSchema.index({ company: 1, batch: 1, status: 1, rowNumber: 1 });

const CompensationImportRow =
  (mongoose.models.CompensationImportRow as mongoose.Model<CompensationImportRowI>) ||
  mongoose.model<CompensationImportRowI>("CompensationImportRow", CompensationImportRowSchema);

export default CompensationImportRow;
