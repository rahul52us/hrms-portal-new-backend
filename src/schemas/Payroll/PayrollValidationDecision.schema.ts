import mongoose, { Document, Schema } from "mongoose";
import { PAYROLL_RESULT_ISSUE_CATEGORIES, PAYROLL_RESULT_ISSUE_SEVERITIES } from "./EmployeePayrollResult.schema";

export const PAYROLL_VALIDATION_DECISION_ACTIONS = ["acknowledge", "reopen"] as const;

export interface PayrollValidationDecisionI extends Document {
  company: mongoose.Types.ObjectId;
  payrollRun: mongoose.Types.ObjectId;
  calculationVersion: number;
  employeePayrollResult: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  issueCode: string;
  issueCategory: (typeof PAYROLL_RESULT_ISSUE_CATEGORIES)[number];
  issueSeverity: (typeof PAYROLL_RESULT_ISSUE_SEVERITIES)[number];
  action: (typeof PAYROLL_VALIDATION_DECISION_ACTIONS)[number];
  reason: string;
  actor: mongoose.Types.ObjectId;
  actorNameSnapshot: string;
  actorCodeSnapshot?: string;
  createdAt?: Date;
}

const PayrollValidationDecisionSchema = new Schema<PayrollValidationDecisionI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    payrollRun: { type: Schema.Types.ObjectId, ref: "PayrollRun", required: true, index: true, immutable: true },
    calculationVersion: { type: Number, required: true, min: 1, immutable: true },
    employeePayrollResult: { type: Schema.Types.ObjectId, ref: "EmployeePayrollResult", required: true, index: true, immutable: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
    issueCode: { type: String, required: true, trim: true, immutable: true },
    issueCategory: { type: String, enum: PAYROLL_RESULT_ISSUE_CATEGORIES, required: true, immutable: true },
    issueSeverity: { type: String, enum: PAYROLL_RESULT_ISSUE_SEVERITIES, required: true, immutable: true },
    action: { type: String, enum: PAYROLL_VALIDATION_DECISION_ACTIONS, required: true, immutable: true },
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500, immutable: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    actorNameSnapshot: { type: String, required: true, trim: true, immutable: true },
    actorCodeSnapshot: { type: String, trim: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

PayrollValidationDecisionSchema.index({
  company: 1,
  payrollRun: 1,
  calculationVersion: 1,
  employeePayrollResult: 1,
  issueCategory: 1,
  issueCode: 1,
  createdAt: -1,
});

for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"] as const) {
  PayrollValidationDecisionSchema.pre(operation, function blockValidationDecisionMutation(next) {
    next(new Error("Payroll validation decisions are append-only"));
  });
}

const PayrollValidationDecision =
  (mongoose.models.PayrollValidationDecision as mongoose.Model<PayrollValidationDecisionI>) ||
  mongoose.model<PayrollValidationDecisionI>("PayrollValidationDecision", PayrollValidationDecisionSchema);

export default PayrollValidationDecision;
