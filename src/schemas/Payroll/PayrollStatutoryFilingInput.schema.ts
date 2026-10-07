import mongoose, { Document, Schema } from "mongoose";

export const PAYROLL_STATUTORY_FILING_ADAPTERS = ["esic_monthly_contribution"] as const;

export interface PayrollStatutoryFilingInputI extends Document {
  company: mongoose.Types.ObjectId;
  payrollRun: mongoose.Types.ObjectId;
  periodKey: string;
  finalizationVersion: number;
  adapterKey: (typeof PAYROLL_STATUTORY_FILING_ADAPTERS)[number];
  employee: mongoose.Types.ObjectId;
  employeeSnapshotVersion: number;
  revisionNumber: number;
  reasonCode: number;
  lastWorkingDay?: string;
  changeReason: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

const PayrollStatutoryFilingInputSchema = new Schema<PayrollStatutoryFilingInputI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    payrollRun: { type: Schema.Types.ObjectId, ref: "PayrollRun", required: true, index: true, immutable: true },
    periodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/, index: true, immutable: true },
    finalizationVersion: { type: Number, required: true, min: 1, immutable: true },
    adapterKey: { type: String, enum: PAYROLL_STATUTORY_FILING_ADAPTERS, required: true, index: true, immutable: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
    employeeSnapshotVersion: { type: Number, required: true, min: 1, immutable: true },
    revisionNumber: { type: Number, required: true, min: 1, immutable: true },
    reasonCode: { type: Number, required: true, min: 1, max: 13, immutable: true },
    lastWorkingDay: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, immutable: true },
    changeReason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500, immutable: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

PayrollStatutoryFilingInputSchema.index(
  { company: 1, payrollRun: 1, finalizationVersion: 1, adapterKey: 1, employee: 1, revisionNumber: 1 },
  { unique: true }
);
PayrollStatutoryFilingInputSchema.index(
  { company: 1, payrollRun: 1, finalizationVersion: 1, adapterKey: 1, employee: 1, createdAt: -1 }
);

for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"] as const) {
  PayrollStatutoryFilingInputSchema.pre(operation, function blockFilingInputMutation(next) {
    next(new Error("Payroll statutory filing inputs are append-only"));
  });
}

const PayrollStatutoryFilingInput =
  (mongoose.models.PayrollStatutoryFilingInput as mongoose.Model<PayrollStatutoryFilingInputI>) ||
  mongoose.model<PayrollStatutoryFilingInputI>("PayrollStatutoryFilingInput", PayrollStatutoryFilingInputSchema);

export default PayrollStatutoryFilingInput;
