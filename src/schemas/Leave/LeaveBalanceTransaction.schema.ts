import mongoose, { Document, Schema } from "mongoose";

export const LEAVE_TRANSACTION_TYPES = [
  "opening_balance",
  "entitlement_credit",
  "accrual_credit",
  "manual_adjustment",
  "leave_debit",
  "leave_reversal",
  "carry_forward",
  "expiry",
  "encashment",
  "comp_off_credit",
  "comp_off_reversal",
] as const;

export interface LeaveBalanceTransactionI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  leaveType: mongoose.Types.ObjectId;
  leaveYearKey: string;
  leaveYearStart: string;
  leaveYearEnd: string;
  units: number;
  transactionType: (typeof LEAVE_TRANSACTION_TYPES)[number];
  sourceType: "leave_request" | "comp_off_claim" | "manual" | "policy" | "system";
  sourceId?: mongoose.Types.ObjectId | null;
  effectiveDate: string;
  idempotencyKey: string;
  reason: string;
  leavePolicyAssignment?: mongoose.Types.ObjectId | null;
  leavePolicy?: mongoose.Types.ObjectId | null;
  leavePolicyVersion?: mongoose.Types.ObjectId | null;
  reversalOf?: mongoose.Types.ObjectId | null;
  compOffCreditLot?: mongoose.Types.ObjectId | null;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

const LeaveBalanceTransactionSchema = new Schema<LeaveBalanceTransactionI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    leaveType: { type: Schema.Types.ObjectId, ref: "LeaveType", required: true, index: true },
    leaveYearKey: { type: String, required: true, trim: true, index: true },
    leaveYearStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    leaveYearEnd: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    units: {
      type: Number,
      required: true,
      validate: {
        validator: (value: number) => Number.isFinite(value) && value !== 0,
        message: "Transaction units must be a non-zero number",
      },
    },
    transactionType: { type: String, enum: LEAVE_TRANSACTION_TYPES, required: true, index: true },
    sourceType: {
      type: String,
      enum: ["leave_request", "comp_off_claim", "manual", "policy", "system"],
      required: true,
    },
    sourceId: { type: Schema.Types.ObjectId, default: null, index: true },
    effectiveDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    idempotencyKey: { type: String, required: true, trim: true },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    leavePolicyAssignment: { type: Schema.Types.ObjectId, ref: "WorkforcePolicyAssignment", default: null },
    leavePolicy: { type: Schema.Types.ObjectId, ref: "LeavePolicy", default: null },
    leavePolicyVersion: { type: Schema.Types.ObjectId, ref: "LeavePolicyVersion", default: null },
    reversalOf: { type: Schema.Types.ObjectId, ref: "LeaveBalanceTransaction", default: null },
    compOffCreditLot: { type: Schema.Types.ObjectId, ref: "CompOffCreditLot", default: null, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

LeaveBalanceTransactionSchema.index({ company: 1, idempotencyKey: 1 }, { unique: true });
LeaveBalanceTransactionSchema.index({ company: 1, employee: 1, leaveType: 1, leaveYearKey: 1, effectiveDate: 1 });
LeaveBalanceTransactionSchema.index({ company: 1, sourceType: 1, sourceId: 1 });

const immutableOperation = function (next: (error?: Error) => void) {
  next(new Error("Leave balance transactions are immutable"));
};

LeaveBalanceTransactionSchema.pre("updateOne", immutableOperation);
LeaveBalanceTransactionSchema.pre("updateMany", immutableOperation);
LeaveBalanceTransactionSchema.pre("findOneAndUpdate", immutableOperation);
LeaveBalanceTransactionSchema.pre("deleteOne", immutableOperation);
LeaveBalanceTransactionSchema.pre("deleteMany", immutableOperation);
LeaveBalanceTransactionSchema.pre("findOneAndDelete", immutableOperation);

const LeaveBalanceTransaction =
  (mongoose.models.LeaveBalanceTransaction as mongoose.Model<LeaveBalanceTransactionI>) ||
  mongoose.model<LeaveBalanceTransactionI>("LeaveBalanceTransaction", LeaveBalanceTransactionSchema);

export default LeaveBalanceTransaction;
