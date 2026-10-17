import mongoose, { Document, Schema } from "mongoose";

export const PAYROLL_ACCESS_ACTIONS = [
  "report_viewed",
  "report_exported",
  "payslip_downloaded",
  "operations_viewed",
] as const;

export interface PayrollAccessLogI extends Document {
  company: mongoose.Types.ObjectId;
  actor: mongoose.Types.ObjectId;
  action: (typeof PAYROLL_ACCESS_ACTIONS)[number];
  resourceType: "payroll_report" | "payslip" | "payroll_operations";
  resourceId: string;
  payrollRun?: mongoose.Types.ObjectId | null;
  employee?: mongoose.Types.ObjectId | null;
  purpose?: string;
  requestFingerprint: string;
  metadata: Record<string, unknown>;
  expiresAt: Date;
  createdAt?: Date;
}

const PayrollAccessLogSchema = new Schema<PayrollAccessLogI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
    action: { type: String, enum: PAYROLL_ACCESS_ACTIONS, required: true, index: true, immutable: true },
    resourceType: {
      type: String,
      enum: ["payroll_report", "payslip", "payroll_operations"],
      required: true,
      index: true,
      immutable: true,
    },
    resourceId: { type: String, required: true, trim: true, maxlength: 160, immutable: true },
    payrollRun: { type: Schema.Types.ObjectId, ref: "PayrollRun", default: null, index: true, immutable: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true, immutable: true },
    purpose: { type: String, trim: true, maxlength: 240, immutable: true },
    requestFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
    metadata: { type: Schema.Types.Mixed, default: {}, immutable: true },
    expiresAt: { type: Date, required: true, index: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

PayrollAccessLogSchema.index({ company: 1, createdAt: -1 });
PayrollAccessLogSchema.index({ company: 1, actor: 1, createdAt: -1 });
PayrollAccessLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"] as const) {
  PayrollAccessLogSchema.pre(operation, function blockAccessLogMutation(next) {
    next(new Error("Payroll access logs are append-only"));
  });
}

const PayrollAccessLog =
  (mongoose.models.PayrollAccessLog as mongoose.Model<PayrollAccessLogI>) ||
  mongoose.model<PayrollAccessLogI>("PayrollAccessLog", PayrollAccessLogSchema);

export default PayrollAccessLog;
