import mongoose, { Document, Schema } from "mongoose";

export const EMPLOYEE_TAX_DECLARATION_STATUSES = [
  "draft",
  "submitted",
  "verified",
  "returned",
  "superseded",
  "cancelled",
] as const;

export interface EmployeeTaxDeclarationI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  employeeNameSnapshot: string;
  employeeCodeSnapshot: string;
  taxYear: string;
  versionNumber: number;
  status: (typeof EMPLOYEE_TAX_DECLARATION_STATUSES)[number];
  revision: number;
  statutoryProfile: mongoose.Types.ObjectId;
  statutoryProfileVersion: mongoose.Types.ObjectId;
  statutoryProfileVersionNumber: number;
  countryCode: string;
  providerKey: string;
  providerImplementationVersion: string;
  currency: string;
  currencyMinorUnits: number;
  taxRegime: string;
  declarations: Record<string, number>;
  changeReason: string;
  createdBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId;
  submittedAt?: Date | null;
  submittedBy?: mongoose.Types.ObjectId | null;
  reviewedAt?: Date | null;
  reviewedBy?: mongoose.Types.ObjectId | null;
  reviewReason?: string;
  cancelledAt?: Date | null;
  cancelledBy?: mongoose.Types.ObjectId | null;
  cancellationReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const EmployeeTaxDeclarationSchema = new Schema<EmployeeTaxDeclarationI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
    employeeNameSnapshot: { type: String, required: true, trim: true, immutable: true },
    employeeCodeSnapshot: { type: String, required: true, trim: true, immutable: true },
    taxYear: { type: String, required: true, match: /^\d{4}-\d{2}$/, index: true, immutable: true },
    versionNumber: { type: Number, required: true, min: 1, immutable: true },
    status: { type: String, enum: EMPLOYEE_TAX_DECLARATION_STATUSES, required: true, default: "draft", index: true },
    revision: { type: Number, required: true, min: 1, default: 1 },
    statutoryProfile: { type: Schema.Types.ObjectId, ref: "StatutoryProfile", required: true, immutable: true },
    statutoryProfileVersion: { type: Schema.Types.ObjectId, ref: "StatutoryProfileVersion", required: true, immutable: true },
    statutoryProfileVersionNumber: { type: Number, required: true, min: 1, immutable: true },
    countryCode: { type: String, required: true, uppercase: true, match: /^[A-Z]{2}$/, immutable: true },
    providerKey: { type: String, required: true, lowercase: true, immutable: true },
    providerImplementationVersion: { type: String, required: true, immutable: true },
    currency: { type: String, required: true, uppercase: true, match: /^[A-Z]{3}$/, immutable: true },
    currencyMinorUnits: { type: Number, required: true, min: 0, max: 3, immutable: true },
    taxRegime: { type: String, trim: true, lowercase: true, default: "" },
    declarations: { type: Schema.Types.Mixed, required: true, default: {} },
    changeReason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    submittedAt: { type: Date, default: null },
    submittedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewReason: { type: String, trim: true, maxlength: 500 },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancellationReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

EmployeeTaxDeclarationSchema.index(
  { company: 1, employee: 1, taxYear: 1, versionNumber: 1 },
  { unique: true }
);
EmployeeTaxDeclarationSchema.index(
  { company: 1, employee: 1, taxYear: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "draft" } }
);
EmployeeTaxDeclarationSchema.index(
  { company: 1, employee: 1, taxYear: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "verified" } }
);
EmployeeTaxDeclarationSchema.index({ company: 1, taxYear: 1, status: 1, employee: 1 });

const EmployeeTaxDeclaration =
  (mongoose.models.EmployeeTaxDeclaration as mongoose.Model<EmployeeTaxDeclarationI>) ||
  mongoose.model<EmployeeTaxDeclarationI>("EmployeeTaxDeclaration", EmployeeTaxDeclarationSchema);

export default EmployeeTaxDeclaration;
