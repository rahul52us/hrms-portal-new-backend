import mongoose, { Document, Schema } from "mongoose";

export interface PayrollFinalizedResultI extends Document {
  company: mongoose.Types.ObjectId;
  payrollRun: mongoose.Types.ObjectId;
  periodKey: string;
  finalizationVersion: number;
  sourceEmployeePayrollResult: mongoose.Types.ObjectId;
  sourceCalculationVersion: number;
  calculationSourceRunVersion: number;
  employeeSnapshotVersion: number;
  employee: mongoose.Types.ObjectId;
  identity: Record<string, unknown>;
  organization: Record<string, unknown>;
  payrollDays: Record<string, number>;
  recurringComponents: Array<Record<string, unknown>>;
  oneTimeInputs: Array<Record<string, unknown>>;
  statutoryContributions: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  issues: Array<Record<string, unknown>>;
  validationDecisions: Array<Record<string, unknown>>;
  currency: string;
  currencyMinorUnits: number;
  calculatedAt: Date;
  calculatedBy: mongoose.Types.ObjectId;
  finalizedAt: Date;
  finalizedBy: mongoose.Types.ObjectId;
  snapshotHash: string;
  createdAt?: Date;
}

const PayrollFinalizedResultSchema = new Schema<PayrollFinalizedResultI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    payrollRun: { type: Schema.Types.ObjectId, ref: "PayrollRun", required: true, index: true, immutable: true },
    periodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true, immutable: true },
    finalizationVersion: { type: Number, required: true, min: 1, immutable: true },
    sourceEmployeePayrollResult: { type: Schema.Types.ObjectId, ref: "EmployeePayrollResult", required: true, immutable: true },
    sourceCalculationVersion: { type: Number, required: true, min: 1, immutable: true },
    calculationSourceRunVersion: { type: Number, required: true, min: 1, immutable: true },
    employeeSnapshotVersion: { type: Number, required: true, min: 1, immutable: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
    identity: { type: Schema.Types.Mixed, required: true, immutable: true },
    organization: { type: Schema.Types.Mixed, required: true, immutable: true },
    payrollDays: { type: Schema.Types.Mixed, required: true, immutable: true },
    recurringComponents: { type: [Schema.Types.Mixed] as any, required: true, default: [], immutable: true },
    oneTimeInputs: { type: [Schema.Types.Mixed] as any, required: true, default: [], immutable: true },
    statutoryContributions: { type: [Schema.Types.Mixed] as any, required: true, default: [], immutable: true },
    totals: { type: Schema.Types.Mixed, required: true, immutable: true },
    issues: { type: [Schema.Types.Mixed] as any, required: true, default: [], immutable: true },
    validationDecisions: { type: [Schema.Types.Mixed] as any, required: true, default: [], immutable: true },
    currency: { type: String, required: true, trim: true, uppercase: true, match: /^[A-Z]{3}$/, immutable: true },
    currencyMinorUnits: { type: Number, required: true, min: 0, max: 3, immutable: true },
    calculatedAt: { type: Date, required: true, immutable: true },
    calculatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    finalizedAt: { type: Date, required: true, immutable: true },
    finalizedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    snapshotHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

PayrollFinalizedResultSchema.index(
  { company: 1, payrollRun: 1, finalizationVersion: 1, employee: 1 },
  { unique: true }
);
PayrollFinalizedResultSchema.index({ company: 1, employee: 1, periodKey: -1, finalizationVersion: -1 });

for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"] as const) {
  PayrollFinalizedResultSchema.pre(operation, function blockFinalizedResultMutation(next) {
    next(new Error("Finalized payroll results are immutable"));
  });
}

const PayrollFinalizedResult =
  (mongoose.models.PayrollFinalizedResult as mongoose.Model<PayrollFinalizedResultI>) ||
  mongoose.model<PayrollFinalizedResultI>("PayrollFinalizedResult", PayrollFinalizedResultSchema);

export default PayrollFinalizedResult;
