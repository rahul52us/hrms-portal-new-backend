import mongoose, { Document, Schema } from "mongoose";

export interface LeaveCarryForwardLotI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  leaveType: mongoose.Types.ObjectId;
  sourceClosure: mongoose.Types.ObjectId;
  sequence: number;
  sourceLeaveYearKey: string;
  sourceLeaveYearStart: string;
  sourceLeaveYearEnd: string;
  leaveYearKey: string;
  leaveYearStart: string;
  leaveYearEnd: string;
  originalUnits: number;
  availableUnits: number;
  consumedUnits: number;
  expiredUnits: number;
  expiresOn?: string | null;
  status: "active" | "exhausted" | "expired";
  leavePolicyAssignment?: mongoose.Types.ObjectId | null;
  leavePolicy?: mongoose.Types.ObjectId | null;
  leavePolicyVersion?: mongoose.Types.ObjectId | null;
  creditTransaction?: mongoose.Types.ObjectId | null;
  createdBy: mongoose.Types.ObjectId;
}

const LeaveCarryForwardLotSchema = new Schema<LeaveCarryForwardLotI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    leaveType: { type: Schema.Types.ObjectId, ref: "LeaveType", required: true, index: true },
    sourceClosure: { type: Schema.Types.ObjectId, ref: "LeaveYearEndClosure", required: true, index: true },
    sequence: { type: Number, required: true, min: 1 },
    sourceLeaveYearKey: { type: String, required: true, trim: true },
    sourceLeaveYearStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    sourceLeaveYearEnd: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    leaveYearKey: { type: String, required: true, trim: true, index: true },
    leaveYearStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    leaveYearEnd: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    originalUnits: { type: Number, required: true, min: 0.0001 },
    availableUnits: { type: Number, required: true, min: 0 },
    consumedUnits: { type: Number, required: true, min: 0, default: 0 },
    expiredUnits: { type: Number, required: true, min: 0, default: 0 },
    expiresOn: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: {
      type: String,
      enum: ["active", "exhausted", "expired"],
      default: "active",
      index: true,
    },
    leavePolicyAssignment: {
      type: Schema.Types.ObjectId,
      ref: "WorkforcePolicyAssignment",
      default: null,
    },
    leavePolicy: { type: Schema.Types.ObjectId, ref: "LeavePolicy", default: null },
    leavePolicyVersion: { type: Schema.Types.ObjectId, ref: "LeavePolicyVersion", default: null },
    creditTransaction: {
      type: Schema.Types.ObjectId,
      ref: "LeaveBalanceTransaction",
      default: null,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

LeaveCarryForwardLotSchema.index({ sourceClosure: 1, sequence: 1 }, { unique: true });
LeaveCarryForwardLotSchema.index({
  company: 1,
  employee: 1,
  leaveType: 1,
  leaveYearKey: 1,
  status: 1,
  expiresOn: 1,
});
LeaveCarryForwardLotSchema.index({ company: 1, status: 1, expiresOn: 1 });

const LeaveCarryForwardLot =
  (mongoose.models.LeaveCarryForwardLot as mongoose.Model<LeaveCarryForwardLotI>) ||
  mongoose.model<LeaveCarryForwardLotI>("LeaveCarryForwardLot", LeaveCarryForwardLotSchema);

export default LeaveCarryForwardLot;
