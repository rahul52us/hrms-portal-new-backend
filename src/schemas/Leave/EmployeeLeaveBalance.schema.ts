import mongoose, { Document, Schema } from "mongoose";

export interface EmployeeLeaveBalanceI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  leaveType: mongoose.Types.ObjectId;
  leaveYearKey: string;
  leaveYearStart: string;
  leaveYearEnd: string;
  creditedUnits: number;
  debitedUnits: number;
  pendingUnits: number;
  balanceUnits: number;
  availableUnits: number;
  negativeBalanceLimit: number;
  lastTransaction?: mongoose.Types.ObjectId | null;
  lastCalculatedAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const EmployeeLeaveBalanceSchema = new Schema<EmployeeLeaveBalanceI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    leaveType: { type: Schema.Types.ObjectId, ref: "LeaveType", required: true, index: true },
    leaveYearKey: { type: String, required: true, trim: true, index: true },
    leaveYearStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    leaveYearEnd: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    creditedUnits: { type: Number, min: 0, default: 0 },
    debitedUnits: { type: Number, min: 0, default: 0 },
    pendingUnits: { type: Number, min: 0, default: 0 },
    balanceUnits: { type: Number, default: 0 },
    availableUnits: { type: Number, default: 0 },
    negativeBalanceLimit: { type: Number, min: 0, default: 0 },
    lastTransaction: { type: Schema.Types.ObjectId, ref: "LeaveBalanceTransaction", default: null },
    lastCalculatedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true }
);

EmployeeLeaveBalanceSchema.index(
  { company: 1, employee: 1, leaveType: 1, leaveYearKey: 1 },
  { unique: true }
);
EmployeeLeaveBalanceSchema.index({ company: 1, employee: 1, leaveYearStart: -1 });

const EmployeeLeaveBalance =
  (mongoose.models.EmployeeLeaveBalance as mongoose.Model<EmployeeLeaveBalanceI>) ||
  mongoose.model<EmployeeLeaveBalanceI>("EmployeeLeaveBalance", EmployeeLeaveBalanceSchema);

export default EmployeeLeaveBalance;
