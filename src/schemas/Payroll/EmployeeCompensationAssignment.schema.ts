import mongoose, { Document, Schema } from "mongoose";
import { SALARY_COMPONENT_CATEGORIES, SalaryComponentCategory } from "./SalaryComponent.schema";

export interface EmployeeCompensationOverrideI {
  salaryComponent: mongoose.Types.ObjectId;
  componentCodeSnapshot: string;
  componentNameSnapshot: string;
  monthlyAmountMinor: number;
}

export interface EmployeeCompensationAmountI {
  salaryComponent: mongoose.Types.ObjectId;
  componentCodeSnapshot: string;
  componentNameSnapshot: string;
  categorySnapshot: SalaryComponentCategory;
  taxableSnapshot: boolean;
  prorateOnUnpaidDaysSnapshot: boolean;
  monthlyAmountMinor: number;
  annualAmountMinor: number;
  overridden: boolean;
}

export interface EmployeeCompensationAssignmentI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  employeeNameSnapshot: string;
  employeeCodeSnapshot: string;
  salaryStructure: mongoose.Types.ObjectId;
  salaryStructureVersion: mongoose.Types.ObjectId;
  structureNameSnapshot: string;
  structureCodeSnapshot: string;
  structureVersionNumber: number;
  structureEffectiveFromSnapshot: Date;
  structureEffectiveToSnapshot?: Date | null;
  currency: string;
  currencyMinorUnits: number;
  payFrequency: "monthly";
  roundingMode: "nearest" | "floor" | "ceil";
  effectiveFrom: Date;
  status: "assigned" | "cancelled";
  assignmentReason: string;
  overrides: EmployeeCompensationOverrideI[];
  componentAmounts: EmployeeCompensationAmountI[];
  totals: Record<string, number>;
  createdBy: mongoose.Types.ObjectId;
  cancelledAt?: Date | null;
  cancelledBy?: mongoose.Types.ObjectId | null;
  cancellationReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const OverrideSchema = new Schema<EmployeeCompensationOverrideI>(
  {
    salaryComponent: { type: Schema.Types.ObjectId, ref: "SalaryComponent", required: true },
    componentCodeSnapshot: { type: String, required: true, trim: true, uppercase: true },
    componentNameSnapshot: { type: String, required: true, trim: true },
    monthlyAmountMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const ComponentAmountSchema = new Schema<EmployeeCompensationAmountI>(
  {
    salaryComponent: { type: Schema.Types.ObjectId, ref: "SalaryComponent", required: true },
    componentCodeSnapshot: { type: String, required: true, trim: true, uppercase: true },
    componentNameSnapshot: { type: String, required: true, trim: true },
    categorySnapshot: { type: String, enum: SALARY_COMPONENT_CATEGORIES, required: true },
    taxableSnapshot: { type: Boolean, required: true },
    prorateOnUnpaidDaysSnapshot: { type: Boolean, required: true },
    monthlyAmountMinor: { type: Number, required: true, min: 0 },
    annualAmountMinor: { type: Number, required: true, min: 0 },
    overridden: { type: Boolean, required: true, default: false },
  },
  { _id: false }
);

const EmployeeCompensationAssignmentSchema = new Schema<EmployeeCompensationAssignmentI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
    employeeNameSnapshot: { type: String, required: true, trim: true, immutable: true },
    employeeCodeSnapshot: { type: String, required: true, trim: true, immutable: true },
    salaryStructure: { type: Schema.Types.ObjectId, ref: "SalaryStructure", required: true, index: true, immutable: true },
    salaryStructureVersion: { type: Schema.Types.ObjectId, ref: "SalaryStructureVersion", required: true, index: true, immutable: true },
    structureNameSnapshot: { type: String, required: true, trim: true, immutable: true },
    structureCodeSnapshot: { type: String, required: true, trim: true, uppercase: true, immutable: true },
    structureVersionNumber: { type: Number, required: true, min: 1, immutable: true },
    structureEffectiveFromSnapshot: { type: Date, required: true, immutable: true },
    structureEffectiveToSnapshot: { type: Date, default: null, immutable: true },
    currency: { type: String, required: true, uppercase: true, match: /^[A-Z]{3}$/, immutable: true },
    currencyMinorUnits: { type: Number, required: true, min: 0, max: 3, immutable: true },
    payFrequency: { type: String, enum: ["monthly"], required: true, immutable: true },
    roundingMode: { type: String, enum: ["nearest", "floor", "ceil"], required: true, immutable: true },
    effectiveFrom: { type: Date, required: true, index: true, immutable: true },
    status: { type: String, enum: ["assigned", "cancelled"], default: "assigned", required: true, index: true },
    assignmentReason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500, immutable: true },
    overrides: { type: [OverrideSchema], default: [], immutable: true },
    componentAmounts: { type: [ComponentAmountSchema], required: true, immutable: true },
    totals: { type: Schema.Types.Mixed, required: true, immutable: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancellationReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

EmployeeCompensationAssignmentSchema.index(
  { company: 1, employee: 1, effectiveFrom: 1 },
  { unique: true, partialFilterExpression: { status: "assigned" } }
);
EmployeeCompensationAssignmentSchema.index({ company: 1, employee: 1, status: 1, effectiveFrom: -1 });
EmployeeCompensationAssignmentSchema.index({ company: 1, salaryStructureVersion: 1, status: 1 });

const EmployeeCompensationAssignment =
  (mongoose.models.EmployeeCompensationAssignment as mongoose.Model<EmployeeCompensationAssignmentI>) ||
  mongoose.model<EmployeeCompensationAssignmentI>(
    "EmployeeCompensationAssignment",
    EmployeeCompensationAssignmentSchema
  );

export default EmployeeCompensationAssignment;
