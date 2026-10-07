import mongoose, { Document, Schema } from "mongoose";
import { PAYROLL_ONE_TIME_INPUT_TYPES } from "./PayrollOneTimeInput.schema";
import { SALARY_COMPONENT_CATEGORIES } from "./SalaryComponent.schema";
import { SALARY_COMPONENT_STATUTORY_WAGE_BASES } from "./SalaryComponent.schema";

export const PAYROLL_RESULT_ISSUE_SEVERITIES = ["error", "warning"] as const;
export const PAYROLL_RESULT_ISSUE_CATEGORIES = [
  "identity",
  "organization",
  "bank",
  "statutory",
  "attendance",
  "compensation",
  "one_time_input",
  "calculation",
] as const;

export interface EmployeePayrollResultI extends Document {
  company: mongoose.Types.ObjectId;
  payrollRun: mongoose.Types.ObjectId;
  periodKey: string;
  calculationVersion: number;
  sourceRunVersion: number;
  employeeSnapshotVersion: number;
  employee: mongoose.Types.ObjectId;
  payrollEmployeeInput: mongoose.Types.ObjectId;
  payrollEmployeeSnapshot?: mongoose.Types.ObjectId | null;
  identity: Record<string, unknown>;
  organization: Record<string, unknown>;
  payrollDays: Record<string, number>;
  recurringComponents: Array<Record<string, unknown>>;
  oneTimeInputs: Array<Record<string, unknown>>;
  statutoryContributions: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  issues: Array<Record<string, string>>;
  hasErrors: boolean;
  hasWarnings: boolean;
  calculatedAt: Date;
  calculatedBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

const safeInteger = {
  validator: Number.isSafeInteger,
  message: "Payroll amount must be a safe integer in minor currency units",
};

const IdentitySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },
    username: { type: String, trim: true, lowercase: true },
  },
  { _id: false }
);

const OrganizationSchema = new Schema(
  {
    designation: { type: String, trim: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    departmentName: { type: String, trim: true },
    teamId: { type: Schema.Types.ObjectId, default: null },
    teamName: { type: String, trim: true },
    officeLocation: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null },
    officeLocationName: { type: String, trim: true },
    officeLocationCode: { type: String, trim: true, uppercase: true },
    officeLocationCity: { type: String, trim: true },
    officeLocationState: { type: String, trim: true },
    officeLocationCountry: { type: String, trim: true },
  },
  { _id: false }
);

const PayrollDaysSchema = new Schema(
  {
    paidDays: { type: Number, required: true },
    unpaidDays: { type: Number, required: true },
    totalDays: { type: Number, required: true },
    approvedOvertimeMinutes: { type: Number, required: true },
  },
  { _id: false }
);

const RecurringComponentSchema = new Schema(
  {
    salaryComponent: { type: Schema.Types.ObjectId, ref: "SalaryComponent", required: true },
    componentCode: { type: String, required: true, trim: true, uppercase: true },
    componentName: { type: String, required: true, trim: true },
    category: { type: String, enum: SALARY_COMPONENT_CATEGORIES, required: true },
    taxable: { type: Boolean, required: true },
    prorateOnUnpaidDays: { type: Boolean, required: true },
    statutoryWageBases: { type: [{ type: String, enum: SALARY_COMPONENT_STATUTORY_WAGE_BASES }], default: [] },
    overridden: { type: Boolean, required: true },
    scheduledAmountMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    payableAmountMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    prorationReductionMinor: { type: Number, required: true, min: 0, validate: safeInteger },
  },
  { _id: false }
);

const OneTimeInputSchema = new Schema(
  {
    payrollOneTimeInput: { type: Schema.Types.ObjectId, ref: "PayrollOneTimeInput", required: true },
    salaryComponent: { type: Schema.Types.ObjectId, ref: "SalaryComponent", required: true },
    componentCode: { type: String, required: true, trim: true, uppercase: true },
    componentName: { type: String, required: true, trim: true },
    category: { type: String, enum: SALARY_COMPONENT_CATEGORIES, required: true },
    taxable: { type: Boolean, required: true },
    statutoryWageBases: { type: [{ type: String, enum: SALARY_COMPONENT_STATUTORY_WAGE_BASES }], default: [] },
    inputType: { type: String, enum: PAYROLL_ONE_TIME_INPUT_TYPES, required: true },
    amountMinor: { type: Number, required: true, min: 1, validate: safeInteger },
    reason: { type: String, required: true, trim: true },
    reference: { type: String, trim: true },
    sourceType: { type: String, enum: ["manual", "finalized_correction"], required: true, default: "manual" },
    sourcePayrollRun: { type: Schema.Types.ObjectId, ref: "PayrollRun", default: null },
    sourcePeriodKey: { type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    sourceFinalizationVersion: { type: Number, min: 1, default: null },
    sourceFinalizedResult: { type: Schema.Types.ObjectId, ref: "PayrollFinalizedResult", default: null },
  },
  { _id: false }
);

const TotalsSchema = new Schema(
  {
    scheduledEarningsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    earningProrationReductionMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    recurringEarningsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    oneTimeEarningsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    arrearsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    grossEarningsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    recurringDeductionsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    statutoryEmployeeDeductionsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    incomeTaxWithholdingMinor: { type: Number, required: true, min: 0, default: 0, validate: safeInteger },
    oneTimeDeductionsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    recoveriesMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    totalDeductionsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    recurringReimbursementsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    oneTimeReimbursementsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    totalReimbursementsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    recurringEmployerContributionsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    statutoryEmployerContributionsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    employerContributionsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    taxableEarningsMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    netPayMinor: { type: Number, required: true, validate: safeInteger },
    employerCostMinor: { type: Number, required: true, min: 0, validate: safeInteger },
  },
  { _id: false }
);

const StatutoryContributionSchema = new Schema(
  {
    providerKey: { type: String, required: true, trim: true, lowercase: true },
    providerImplementationVersion: { type: String, required: true, trim: true },
    moduleKey: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    side: { type: String, enum: ["employee_deduction", "employer_contribution"], required: true },
    wageBaseMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    rateBps: { type: Number, required: true, min: 0, validate: safeInteger },
    amountMinor: { type: Number, required: true, min: 0, validate: safeInteger },
    roundingMode: { type: String, enum: ["nearest_major_unit", "ceil_major_unit"], required: true },
    ruleVersion: { type: String, required: true, trim: true },
    ruleEffectiveFrom: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const IssueSchema = new Schema(
  {
    code: { type: String, required: true, trim: true },
    severity: { type: String, enum: PAYROLL_RESULT_ISSUE_SEVERITIES, required: true },
    category: { type: String, enum: PAYROLL_RESULT_ISSUE_CATEGORIES, required: true },
    message: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const EmployeePayrollResultSchema = new Schema<EmployeePayrollResultI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    payrollRun: { type: Schema.Types.ObjectId, ref: "PayrollRun", required: true, index: true, immutable: true },
    periodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true, immutable: true },
    calculationVersion: { type: Number, required: true, min: 1, immutable: true },
    sourceRunVersion: { type: Number, required: true, min: 1, immutable: true },
    employeeSnapshotVersion: { type: Number, required: true, min: 1, immutable: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
    payrollEmployeeInput: { type: Schema.Types.ObjectId, ref: "PayrollEmployeeInput", required: true, immutable: true },
    payrollEmployeeSnapshot: { type: Schema.Types.ObjectId, ref: "PayrollEmployeeSnapshot", default: null, immutable: true },
    identity: { type: IdentitySchema, required: true, immutable: true },
    organization: { type: OrganizationSchema, required: true, immutable: true },
    payrollDays: { type: PayrollDaysSchema, required: true, immutable: true },
    recurringComponents: { type: [RecurringComponentSchema], default: [], immutable: true },
    oneTimeInputs: { type: [OneTimeInputSchema], default: [], immutable: true },
    statutoryContributions: { type: [StatutoryContributionSchema], default: [], immutable: true },
    totals: { type: TotalsSchema, required: true, immutable: true },
    issues: { type: [IssueSchema], default: [], immutable: true },
    hasErrors: { type: Boolean, required: true, default: false, index: true, immutable: true },
    hasWarnings: { type: Boolean, required: true, default: false, index: true, immutable: true },
    calculatedAt: { type: Date, required: true, immutable: true },
    calculatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

EmployeePayrollResultSchema.index(
  { company: 1, payrollRun: 1, calculationVersion: 1, employee: 1 },
  { unique: true }
);
EmployeePayrollResultSchema.index({ company: 1, payrollRun: 1, calculationVersion: 1, "identity.code": 1 });
EmployeePayrollResultSchema.index({ company: 1, payrollRun: 1, calculationVersion: 1, hasErrors: 1, hasWarnings: 1 });

const EmployeePayrollResult =
  (mongoose.models.EmployeePayrollResult as mongoose.Model<EmployeePayrollResultI>) ||
  mongoose.model<EmployeePayrollResultI>("EmployeePayrollResult", EmployeePayrollResultSchema);

export default EmployeePayrollResult;
