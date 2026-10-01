import mongoose, { Document, Schema } from "mongoose";
import { SALARY_COMPONENT_CATEGORIES, SalaryComponentCategory } from "./SalaryComponent.schema";

export const SALARY_RULE_TYPES = ["fixed", "percentage", "variable"] as const;
export const SALARY_VERSION_STATUSES = ["draft", "published", "cancelled"] as const;

export interface SalaryStructureRuleI {
  salaryComponent: mongoose.Types.ObjectId;
  componentCodeSnapshot: string;
  componentNameSnapshot: string;
  categorySnapshot: SalaryComponentCategory;
  taxableSnapshot: boolean;
  prorateOnUnpaidDaysSnapshot: boolean;
  calculationType: (typeof SALARY_RULE_TYPES)[number];
  monthlyAmountMinor?: number | null;
  percentageBps?: number | null;
  percentageOfComponent?: mongoose.Types.ObjectId | null;
  allowEmployeeOverride: boolean;
  displayOrder: number;
}

export interface SalaryStructureVersionI extends Document {
  company: mongoose.Types.ObjectId;
  salaryStructure: mongoose.Types.ObjectId;
  versionNumber: number;
  status: (typeof SALARY_VERSION_STATUSES)[number];
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  currency: string;
  currencyMinorUnits: number;
  payFrequency: "monthly";
  roundingMode: "nearest" | "floor" | "ceil";
  rules: SalaryStructureRuleI[];
  preview: Record<string, number>;
  changeReason?: string;
  createdBy: mongoose.Types.ObjectId;
  publishedAt?: Date | null;
  publishedBy?: mongoose.Types.ObjectId | null;
  cancelledAt?: Date | null;
  cancelledBy?: mongoose.Types.ObjectId | null;
  cancelReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const SalaryStructureRuleSchema = new Schema<SalaryStructureRuleI>(
  {
    salaryComponent: { type: Schema.Types.ObjectId, ref: "SalaryComponent", required: true },
    componentCodeSnapshot: { type: String, required: true, trim: true, uppercase: true },
    componentNameSnapshot: { type: String, required: true, trim: true },
    categorySnapshot: { type: String, enum: SALARY_COMPONENT_CATEGORIES, required: true },
    taxableSnapshot: { type: Boolean, required: true },
    prorateOnUnpaidDaysSnapshot: { type: Boolean, required: true },
    calculationType: { type: String, enum: SALARY_RULE_TYPES, required: true },
    monthlyAmountMinor: { type: Number, min: 0, default: null },
    percentageBps: { type: Number, min: 1, max: 10000, default: null },
    percentageOfComponent: { type: Schema.Types.ObjectId, ref: "SalaryComponent", default: null },
    allowEmployeeOverride: { type: Boolean, default: false },
    displayOrder: { type: Number, min: 0, default: 0 },
  },
  { _id: true }
);

const SalaryStructureVersionSchema = new Schema<SalaryStructureVersionI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    salaryStructure: { type: Schema.Types.ObjectId, ref: "SalaryStructure", required: true, index: true, immutable: true },
    versionNumber: { type: Number, required: true, min: 1, immutable: true },
    status: { type: String, enum: SALARY_VERSION_STATUSES, default: "draft", required: true, index: true },
    effectiveFrom: { type: Date, default: null, index: true },
    effectiveTo: { type: Date, default: null, index: true },
    currency: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z]{3}$/ },
    currencyMinorUnits: { type: Number, required: true, min: 0, max: 3 },
    payFrequency: { type: String, enum: ["monthly"], required: true, default: "monthly" },
    roundingMode: { type: String, enum: ["nearest", "floor", "ceil"], required: true, default: "nearest" },
    rules: {
      type: [SalaryStructureRuleSchema],
      required: true,
      validate: [
        { validator: (value: SalaryStructureRuleI[]) => value.length > 0 && value.length <= 100, message: "A salary structure needs 1-100 component rules" },
        { validator: (value: SalaryStructureRuleI[]) => new Set(value.map((rule) => String(rule.salaryComponent))).size === value.length, message: "A salary component can appear only once" },
      ],
    },
    preview: { type: Schema.Types.Mixed, required: true, default: {} },
    changeReason: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancelReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

SalaryStructureVersionSchema.index({ company: 1, salaryStructure: 1, versionNumber: 1 }, { unique: true });
SalaryStructureVersionSchema.index(
  { company: 1, salaryStructure: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "draft" } }
);
SalaryStructureVersionSchema.index(
  { company: 1, salaryStructure: 1, effectiveFrom: 1 },
  { unique: true, partialFilterExpression: { status: "published" } }
);

const SalaryStructureVersion =
  (mongoose.models.SalaryStructureVersion as mongoose.Model<SalaryStructureVersionI>) ||
  mongoose.model<SalaryStructureVersionI>("SalaryStructureVersion", SalaryStructureVersionSchema);

export default SalaryStructureVersion;
