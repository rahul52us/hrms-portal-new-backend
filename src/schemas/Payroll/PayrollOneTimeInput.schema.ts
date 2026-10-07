import mongoose, { Document, Schema } from "mongoose";
import {
  SALARY_COMPONENT_CATEGORIES,
  SALARY_COMPONENT_STATUTORY_WAGE_BASES,
  SalaryComponentCategory,
  SalaryComponentStatutoryWageBase,
} from "./SalaryComponent.schema";

export const PAYROLL_ONE_TIME_INPUT_TYPES = [
  "earning",
  "deduction",
  "reimbursement",
  "arrear",
  "recovery",
] as const;

export type PayrollOneTimeInputType = (typeof PAYROLL_ONE_TIME_INPUT_TYPES)[number];
export const PAYROLL_ONE_TIME_INPUT_SOURCE_TYPES = ["manual", "finalized_correction"] as const;
export type PayrollOneTimeInputSourceType = (typeof PAYROLL_ONE_TIME_INPUT_SOURCE_TYPES)[number];

export interface PayrollOneTimeInputI extends Document {
  company: mongoose.Types.ObjectId;
  payrollRun: mongoose.Types.ObjectId;
  periodKey: string;
  employee: mongoose.Types.ObjectId;
  employeeNameSnapshot: string;
  employeeCodeSnapshot: string;
  salaryComponent: mongoose.Types.ObjectId;
  componentNameSnapshot: string;
  componentCodeSnapshot: string;
  componentCategorySnapshot: SalaryComponentCategory;
  componentTaxableSnapshot: boolean;
  componentStatutoryWageBasesSnapshot: SalaryComponentStatutoryWageBase[];
  inputType: PayrollOneTimeInputType;
  amountMinor: number;
  currency: string;
  currencyMinorUnits: number;
  reason: string;
  reference?: string;
  idempotencyKey: string;
  sourceType: PayrollOneTimeInputSourceType;
  sourcePayrollRun?: mongoose.Types.ObjectId | null;
  sourcePeriodKey?: string;
  sourceFinalizationVersion?: number | null;
  sourceFinalizedResult?: mongoose.Types.ObjectId | null;
  status: "active" | "cancelled";
  createdBy: mongoose.Types.ObjectId;
  cancelledAt?: Date | null;
  cancelledBy?: mongoose.Types.ObjectId | null;
  cancellationReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const PayrollOneTimeInputSchema = new Schema<PayrollOneTimeInputI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    payrollRun: { type: Schema.Types.ObjectId, ref: "PayrollRun", required: true, index: true, immutable: true },
    periodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true, immutable: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
    employeeNameSnapshot: { type: String, required: true, trim: true, immutable: true },
    employeeCodeSnapshot: { type: String, required: true, trim: true, immutable: true },
    salaryComponent: { type: Schema.Types.ObjectId, ref: "SalaryComponent", required: true, immutable: true },
    componentNameSnapshot: { type: String, required: true, trim: true, immutable: true },
    componentCodeSnapshot: { type: String, required: true, trim: true, uppercase: true, immutable: true },
    componentCategorySnapshot: { type: String, enum: SALARY_COMPONENT_CATEGORIES, required: true, immutable: true },
    componentTaxableSnapshot: { type: Boolean, required: true, immutable: true },
    componentStatutoryWageBasesSnapshot: {
      type: [{ type: String, enum: SALARY_COMPONENT_STATUTORY_WAGE_BASES }],
      required: true,
      default: [],
      immutable: true,
    },
    inputType: { type: String, enum: PAYROLL_ONE_TIME_INPUT_TYPES, required: true, index: true, immutable: true },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "Amount must be a safe integer in minor currency units",
      },
      immutable: true,
    },
    currency: { type: String, required: true, trim: true, uppercase: true, match: /^[A-Z]{3}$/, immutable: true },
    currencyMinorUnits: { type: Number, required: true, min: 0, max: 3, immutable: true },
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500, immutable: true },
    reference: { type: String, trim: true, maxlength: 100, immutable: true },
    idempotencyKey: { type: String, required: true, trim: true, minlength: 8, maxlength: 100, immutable: true },
    sourceType: { type: String, enum: PAYROLL_ONE_TIME_INPUT_SOURCE_TYPES, required: true, default: "manual", index: true, immutable: true },
    sourcePayrollRun: {
      type: Schema.Types.ObjectId,
      ref: "PayrollRun",
      default: null,
      required: function(this: PayrollOneTimeInputI) { return this.sourceType === "finalized_correction"; },
      immutable: true,
    },
    sourcePeriodKey: {
      type: String,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
      required: function(this: PayrollOneTimeInputI) { return this.sourceType === "finalized_correction"; },
      immutable: true,
    },
    sourceFinalizationVersion: {
      type: Number,
      min: 1,
      default: null,
      required: function(this: PayrollOneTimeInputI) { return this.sourceType === "finalized_correction"; },
      immutable: true,
    },
    sourceFinalizedResult: {
      type: Schema.Types.ObjectId,
      ref: "PayrollFinalizedResult",
      default: null,
      required: function(this: PayrollOneTimeInputI) { return this.sourceType === "finalized_correction"; },
      immutable: true,
    },
    status: { type: String, enum: ["active", "cancelled"], required: true, default: "active", index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancellationReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

PayrollOneTimeInputSchema.index({ company: 1, payrollRun: 1, idempotencyKey: 1 }, { unique: true });
PayrollOneTimeInputSchema.index({ company: 1, payrollRun: 1, status: 1, createdAt: -1 });
PayrollOneTimeInputSchema.index({ company: 1, payrollRun: 1, employee: 1, status: 1 });
PayrollOneTimeInputSchema.index({ company: 1, sourcePayrollRun: 1, sourceFinalizedResult: 1, createdAt: -1 });

const PayrollOneTimeInput =
  (mongoose.models.PayrollOneTimeInput as mongoose.Model<PayrollOneTimeInputI>) ||
  mongoose.model<PayrollOneTimeInputI>("PayrollOneTimeInput", PayrollOneTimeInputSchema);

export default PayrollOneTimeInput;
