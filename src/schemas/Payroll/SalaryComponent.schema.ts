import mongoose, { Document, Schema } from "mongoose";

export const SALARY_COMPONENT_CATEGORIES = [
  "earning",
  "deduction",
  "employer_contribution",
  "reimbursement",
] as const;

export const SALARY_COMPONENT_STATUSES = ["active", "archived"] as const;
export const SALARY_COMPONENT_STATUTORY_WAGE_BASES = [
  "provident_fund",
  "employee_state_insurance",
] as const;

export type SalaryComponentCategory = (typeof SALARY_COMPONENT_CATEGORIES)[number];
export type SalaryComponentStatus = (typeof SALARY_COMPONENT_STATUSES)[number];
export type SalaryComponentStatutoryWageBase = (typeof SALARY_COMPONENT_STATUTORY_WAGE_BASES)[number];

export interface SalaryComponentI extends Document {
  company: mongoose.Types.ObjectId;
  name: string;
  code: string;
  description?: string;
  category: SalaryComponentCategory;
  taxable: boolean;
  prorateOnUnpaidDays: boolean;
  statutoryWageBases: SalaryComponentStatutoryWageBase[];
  status: SalaryComponentStatus;
  displayOrder: number;
  createdBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId;
  archivedAt?: Date | null;
  archivedBy?: mongoose.Types.ObjectId | null;
  archiveReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const SalaryComponentSchema = new Schema<SalaryComponentI>(
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
    category: { type: String, enum: SALARY_COMPONENT_CATEGORIES, required: true, immutable: true },
    taxable: { type: Boolean, default: false },
    prorateOnUnpaidDays: { type: Boolean, default: true },
    statutoryWageBases: {
      type: [{ type: String, enum: SALARY_COMPONENT_STATUTORY_WAGE_BASES }],
      default: [],
      validate: {
        validator(this: SalaryComponentI, value: string[]) {
          return this.category === "earning" || value.length === 0;
        },
        message: "Only earning components can form a statutory wage base",
      },
    },
    status: { type: String, enum: SALARY_COMPONENT_STATUSES, default: "active", index: true },
    displayOrder: { type: Number, min: 0, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    archiveReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

SalaryComponentSchema.index({ company: 1, code: 1 }, { unique: true });
SalaryComponentSchema.index({ company: 1, status: 1, displayOrder: 1, name: 1 });

const SalaryComponent =
  (mongoose.models.SalaryComponent as mongoose.Model<SalaryComponentI>) ||
  mongoose.model<SalaryComponentI>("SalaryComponent", SalaryComponentSchema);

export default SalaryComponent;

