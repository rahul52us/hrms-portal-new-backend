import mongoose, { Document, Schema } from "mongoose";

export const PAYROLL_AUDIT_ENTITY_TYPES = [
  "payroll_settings",
  "salary_component",
  "salary_structure",
  "employee_compensation",
  "compensation_import",
  "payroll_run",
  "payroll_input",
  "payslip",
] as const;

export interface PayrollAuditLogI extends Document {
  company: mongoose.Types.ObjectId;
  entityType: (typeof PAYROLL_AUDIT_ENTITY_TYPES)[number];
  entityId: mongoose.Types.ObjectId;
  action: string;
  actor: mongoose.Types.ObjectId;
  reason?: string;
  details?: Record<string, unknown>;
  createdAt?: Date;
}

const PayrollAuditLogSchema = new Schema<PayrollAuditLogI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    entityType: { type: String, enum: PAYROLL_AUDIT_ENTITY_TYPES, required: true, index: true, immutable: true },
    entityId: { type: Schema.Types.ObjectId, required: true, index: true, immutable: true },
    action: { type: String, required: true, trim: true, index: true, immutable: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    reason: { type: String, trim: true, maxlength: 500, immutable: true },
    details: { type: Schema.Types.Mixed, default: {}, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

PayrollAuditLogSchema.index({ company: 1, entityType: 1, entityId: 1, createdAt: -1 });

for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"] as const) {
  PayrollAuditLogSchema.pre(operation, function blockAuditMutation(next) {
    next(new Error("Payroll audit logs are append-only"));
  });
}

const PayrollAuditLog =
  (mongoose.models.PayrollAuditLog as mongoose.Model<PayrollAuditLogI>) ||
  mongoose.model<PayrollAuditLogI>("PayrollAuditLog", PayrollAuditLogSchema);

export default PayrollAuditLog;

