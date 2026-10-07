import mongoose, { Document, Schema } from "mongoose";
import { SALARY_COMPONENT_CATEGORIES, SALARY_COMPONENT_STATUTORY_WAGE_BASES } from "./SalaryComponent.schema";

export const PAYROLL_SNAPSHOT_ISSUE_SEVERITIES = ["error", "warning"] as const;
export const PAYROLL_SNAPSHOT_ISSUE_CATEGORIES = [
  "identity",
  "organization",
  "bank",
  "statutory",
  "compensation",
] as const;

export interface PayrollEmployeeSnapshotI extends Document {
  company: mongoose.Types.ObjectId;
  payrollRun: mongoose.Types.ObjectId;
  periodKey: string;
  snapshotVersion: number;
  snapshotAsOfDate: string;
  employee: mongoose.Types.ObjectId;
  payrollEmployeeInput: mongoose.Types.ObjectId;
  identity: Record<string, unknown>;
  organization: Record<string, unknown>;
  bankDetail?: mongoose.Types.ObjectId | null;
  bank: Record<string, unknown>;
  profileDetails?: mongoose.Types.ObjectId | null;
  employeeStatutoryAssignment?: mongoose.Types.ObjectId | null;
  employeeTaxDeclaration?: mongoose.Types.ObjectId | null;
  statutory: Record<string, unknown>;
  compensationAssignment?: mongoose.Types.ObjectId | null;
  compensation: Record<string, unknown>;
  issues: Array<Record<string, string>>;
  hasErrors: boolean;
  hasWarnings: boolean;
  preparedAt: Date;
  preparedBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

const IdentitySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },
    username: { type: String, trim: true, lowercase: true },
    mobileNumber: { type: String, trim: true },
    role: { type: String, trim: true, lowercase: true },
    gender: { type: Number },
    dateOfBirth: { type: Date, default: null },
    joiningDate: { type: Date, default: null },
    confirmationDate: { type: Date, default: null },
    employmentEndDate: { type: Date, default: null },
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
    reportingManager: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reportingManagerName: { type: String, trim: true },
  },
  { _id: false }
);

const BankSchema = new Schema(
  {
    accountHolderName: { type: String, trim: true },
    bankName: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    branch: { type: String, trim: true },
    ifsc: { type: String, trim: true, uppercase: true },
  },
  { _id: false }
);

const StatutorySchema = new Schema(
  {
    source: { type: String, enum: ["effective_assignment", "legacy_profile", "missing"], required: true },
    countryCode: { type: String, trim: true, uppercase: true },
    providerKey: { type: String, trim: true, lowercase: true },
    providerImplementationVersion: { type: String, trim: true },
    statutoryProfileVersionNumber: { type: Number, min: 1 },
    enabledModules: { type: [{ type: String, trim: true }], default: [] },
    effectiveFrom: { type: Date, default: null },
    aadharNumber: { type: String, trim: true },
    nameAsPerAadhar: { type: String, trim: true },
    panNumber: { type: String, trim: true, uppercase: true },
    nameAsPerPan: { type: String, trim: true },
    uan: { type: String, trim: true },
    nameAsPerUan: { type: String, trim: true },
    pfMemberId: { type: String, trim: true, uppercase: true },
    esiInsuranceNumber: { type: String, trim: true },
    nameAsPerEsi: { type: String, trim: true },
    nationality: { type: String, trim: true, lowercase: true },
    applicability: { type: Schema.Types.Mixed, default: {} },
    taxDeclaration: {
      taxYear: { type: String, trim: true },
      versionNumber: { type: Number, min: 1 },
      taxRegime: { type: String, trim: true, lowercase: true },
      currency: { type: String, trim: true, uppercase: true },
      currencyMinorUnits: { type: Number, min: 0, max: 3 },
      declarations: { type: Schema.Types.Mixed, default: {} },
    },
  },
  { _id: false }
);

const CompensationComponentSchema = new Schema(
  {
    salaryComponent: { type: Schema.Types.ObjectId, ref: "SalaryComponent", required: true },
    componentCode: { type: String, required: true, trim: true, uppercase: true },
    componentName: { type: String, required: true, trim: true },
    category: { type: String, enum: SALARY_COMPONENT_CATEGORIES, required: true },
    taxable: { type: Boolean, required: true },
    prorateOnUnpaidDays: { type: Boolean, required: true },
    statutoryWageBases: {
      type: [{ type: String, enum: SALARY_COMPONENT_STATUTORY_WAGE_BASES }],
      required: true,
      default: [],
    },
    monthlyAmountMinor: { type: Number, required: true, min: 0 },
    annualAmountMinor: { type: Number, required: true, min: 0 },
    overridden: { type: Boolean, required: true },
  },
  { _id: false }
);

const CompensationSchema = new Schema(
  {
    assigned: { type: Boolean, required: true, default: false },
    structureName: { type: String, trim: true },
    structureCode: { type: String, trim: true, uppercase: true },
    structureVersionNumber: { type: Number, min: 1 },
    effectiveFrom: { type: Date, default: null },
    currency: { type: String, trim: true, uppercase: true },
    currencyMinorUnits: { type: Number, min: 0, max: 3 },
    payFrequency: { type: String, enum: ["monthly"] },
    roundingMode: { type: String, enum: ["nearest", "floor", "ceil"] },
    componentAmounts: { type: [CompensationComponentSchema], default: [] },
    totals: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const IssueSchema = new Schema(
  {
    code: { type: String, required: true, trim: true },
    severity: { type: String, enum: PAYROLL_SNAPSHOT_ISSUE_SEVERITIES, required: true },
    category: { type: String, enum: PAYROLL_SNAPSHOT_ISSUE_CATEGORIES, required: true },
    message: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const PayrollEmployeeSnapshotSchema = new Schema<PayrollEmployeeSnapshotI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    payrollRun: { type: Schema.Types.ObjectId, ref: "PayrollRun", required: true, index: true, immutable: true },
    periodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true, immutable: true },
    snapshotVersion: { type: Number, required: true, min: 1, immutable: true },
    snapshotAsOfDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, immutable: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
    payrollEmployeeInput: { type: Schema.Types.ObjectId, ref: "PayrollEmployeeInput", required: true, immutable: true },
    identity: { type: IdentitySchema, required: true, immutable: true },
    organization: { type: OrganizationSchema, required: true, immutable: true },
    bankDetail: { type: Schema.Types.ObjectId, ref: "BankDetail", default: null, immutable: true },
    bank: { type: BankSchema, required: true, immutable: true },
    profileDetails: { type: Schema.Types.ObjectId, ref: "ProfileDetails", default: null, immutable: true },
    employeeStatutoryAssignment: { type: Schema.Types.ObjectId, ref: "EmployeeStatutoryAssignment", default: null, immutable: true },
    employeeTaxDeclaration: { type: Schema.Types.ObjectId, ref: "EmployeeTaxDeclaration", default: null, immutable: true },
    statutory: { type: StatutorySchema, required: true, immutable: true },
    compensationAssignment: { type: Schema.Types.ObjectId, ref: "EmployeeCompensationAssignment", default: null, immutable: true },
    compensation: { type: CompensationSchema, required: true, immutable: true },
    issues: { type: [IssueSchema], default: [], immutable: true },
    hasErrors: { type: Boolean, required: true, default: false, index: true, immutable: true },
    hasWarnings: { type: Boolean, required: true, default: false, index: true, immutable: true },
    preparedAt: { type: Date, required: true, immutable: true },
    preparedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

PayrollEmployeeSnapshotSchema.index(
  { company: 1, payrollRun: 1, snapshotVersion: 1, employee: 1 },
  { unique: true }
);
PayrollEmployeeSnapshotSchema.index({ company: 1, payrollRun: 1, snapshotVersion: 1, "identity.code": 1 });
PayrollEmployeeSnapshotSchema.index({ company: 1, payrollRun: 1, snapshotVersion: 1, "identity.name": 1 });
PayrollEmployeeSnapshotSchema.index({ company: 1, payrollRun: 1, snapshotVersion: 1, hasErrors: 1, hasWarnings: 1 });

const PayrollEmployeeSnapshot =
  (mongoose.models.PayrollEmployeeSnapshot as mongoose.Model<PayrollEmployeeSnapshotI>) ||
  mongoose.model<PayrollEmployeeSnapshotI>("PayrollEmployeeSnapshot", PayrollEmployeeSnapshotSchema);

export default PayrollEmployeeSnapshot;
