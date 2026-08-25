import mongoose, { Document, Schema } from "mongoose";

export interface CompOffCreditLotI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  leaveType: mongoose.Types.ObjectId;
  claim: mongoose.Types.ObjectId;
  attendanceRecord: mongoose.Types.ObjectId;
  earnedDate: string;
  expiresOn: string;
  leaveYearKey: string;
  leaveYearStart: string;
  leaveYearEnd: string;
  originalUnits: number;
  availableUnits: number;
  reservedUnits: number;
  consumedUnits: number;
  expiredUnits: number;
  revokedUnits: number;
  status: "active" | "exhausted" | "expired" | "revoked";
  leavePolicyAssignment: mongoose.Types.ObjectId;
  leavePolicy: mongoose.Types.ObjectId;
  leavePolicyVersion: mongoose.Types.ObjectId;
  creditTransaction?: mongoose.Types.ObjectId | null;
  createdBy: mongoose.Types.ObjectId;
}

const CompOffCreditLotSchema = new Schema<CompOffCreditLotI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    leaveType: { type: Schema.Types.ObjectId, ref: "LeaveType", required: true, index: true },
    claim: { type: Schema.Types.ObjectId, ref: "CompOffClaim", required: true, unique: true },
    attendanceRecord: { type: Schema.Types.ObjectId, ref: "AttendanceRecord", required: true },
    earnedDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    expiresOn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    leaveYearKey: { type: String, required: true, trim: true, index: true },
    leaveYearStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    leaveYearEnd: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    originalUnits: { type: Number, min: 0.5, required: true },
    availableUnits: { type: Number, min: 0, required: true },
    reservedUnits: { type: Number, min: 0, default: 0 },
    consumedUnits: { type: Number, min: 0, default: 0 },
    expiredUnits: { type: Number, min: 0, default: 0 },
    revokedUnits: { type: Number, min: 0, default: 0 },
    status: { type: String, enum: ["active", "exhausted", "expired", "revoked"], default: "active", index: true },
    leavePolicyAssignment: { type: Schema.Types.ObjectId, ref: "WorkforcePolicyAssignment", required: true },
    leavePolicy: { type: Schema.Types.ObjectId, ref: "LeavePolicy", required: true },
    leavePolicyVersion: { type: Schema.Types.ObjectId, ref: "LeavePolicyVersion", required: true },
    creditTransaction: { type: Schema.Types.ObjectId, ref: "LeaveBalanceTransaction", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

CompOffCreditLotSchema.index({ company: 1, employee: 1, leaveType: 1, status: 1, expiresOn: 1 });

const CompOffCreditLot =
  (mongoose.models.CompOffCreditLot as mongoose.Model<CompOffCreditLotI>) ||
  mongoose.model<CompOffCreditLotI>("CompOffCreditLot", CompOffCreditLotSchema);

export default CompOffCreditLot;
