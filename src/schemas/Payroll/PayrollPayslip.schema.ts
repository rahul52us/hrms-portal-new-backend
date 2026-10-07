import mongoose, { Document, Schema } from "mongoose";

export const PAYSLIP_TEMPLATE_VERSION = "payroll_payslip_v1";

export interface PayrollPayslipI extends Document {
  company: mongoose.Types.ObjectId;
  payrollRun: mongoose.Types.ObjectId;
  finalizedResult: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  periodKey: string;
  finalizationVersion: number;
  currency: string;
  currencyMinorUnits: number;
  payslipNumber: string;
  templateVersion: string;
  companySnapshot: Record<string, unknown>;
  employeeSnapshot: Record<string, unknown>;
  amountsSnapshot: Record<string, number>;
  sourceSnapshotHash: string;
  contentHash: string;
  issuedAt: Date;
  issuedBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

const PayrollPayslipSchema = new Schema<PayrollPayslipI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    payrollRun: { type: Schema.Types.ObjectId, ref: "PayrollRun", required: true, index: true, immutable: true },
    finalizedResult: { type: Schema.Types.ObjectId, ref: "PayrollFinalizedResult", required: true, immutable: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
    periodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true, immutable: true },
    finalizationVersion: { type: Number, required: true, min: 1, immutable: true },
    currency: { type: String, required: true, trim: true, uppercase: true, match: /^[A-Z]{3}$/, immutable: true },
    currencyMinorUnits: { type: Number, required: true, min: 0, max: 3, immutable: true },
    payslipNumber: { type: String, required: true, trim: true, maxlength: 160, immutable: true },
    templateVersion: { type: String, required: true, trim: true, immutable: true },
    companySnapshot: { type: Schema.Types.Mixed, required: true, immutable: true },
    employeeSnapshot: { type: Schema.Types.Mixed, required: true, immutable: true },
    amountsSnapshot: { type: Schema.Types.Mixed, required: true, immutable: true },
    sourceSnapshotHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
    contentHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
    issuedAt: { type: Date, required: true, immutable: true },
    issuedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

PayrollPayslipSchema.index(
  { company: 1, payrollRun: 1, finalizationVersion: 1, employee: 1 },
  { unique: true }
);
PayrollPayslipSchema.index({ company: 1, employee: 1, periodKey: -1, finalizationVersion: -1 });
PayrollPayslipSchema.index({ company: 1, payslipNumber: 1 }, { unique: true });

for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"] as const) {
  PayrollPayslipSchema.pre(operation, function blockPayslipMutation(next) {
    next(new Error("Issued payslips are immutable"));
  });
}

const PayrollPayslip =
  (mongoose.models.PayrollPayslip as mongoose.Model<PayrollPayslipI>) ||
  mongoose.model<PayrollPayslipI>("PayrollPayslip", PayrollPayslipSchema);

export default PayrollPayslip;
