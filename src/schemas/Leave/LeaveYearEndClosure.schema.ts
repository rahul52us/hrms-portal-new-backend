import mongoose, { Document, Schema } from "mongoose";

export const LEAVE_YEAR_END_CLOSURE_STATUSES = [
  "partial",
  "completed",
  "not_applicable",
  "configuration_error",
] as const;

export interface LeaveYearEndClosureI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  leaveType: mongoose.Types.ObjectId;
  sourceLeaveYearKey: string;
  sourceLeaveYearStart: string;
  sourceLeaveYearEnd: string;
  destinationLeaveYearKey?: string;
  destinationLeaveYearStart?: string;
  destinationLeaveYearEnd?: string;
  sourceLeavePolicyAssignment?: mongoose.Types.ObjectId | null;
  sourceLeavePolicy?: mongoose.Types.ObjectId | null;
  sourceLeavePolicyVersion?: mongoose.Types.ObjectId | null;
  carryForwardEnabledSnapshot: boolean;
  maxCarryForwardSnapshot: number;
  carryForwardExpiryMonthsSnapshot: number;
  carriedUnits: number;
  lapsedUnits: number;
  pendingUnits: number;
  remainingBalanceUnits: number;
  iteration: number;
  status: (typeof LEAVE_YEAR_END_CLOSURE_STATUSES)[number];
  message?: string;
  lastRun?: mongoose.Types.ObjectId | null;
  completedAt?: Date | null;
  lastProcessedAt: Date;
  createdBy?: mongoose.Types.ObjectId | null;
  updatedBy?: mongoose.Types.ObjectId | null;
}

const LeaveYearEndClosureSchema = new Schema<LeaveYearEndClosureI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    leaveType: { type: Schema.Types.ObjectId, ref: "LeaveType", required: true, index: true },
    sourceLeaveYearKey: { type: String, required: true, trim: true, index: true },
    sourceLeaveYearStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    sourceLeaveYearEnd: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    destinationLeaveYearKey: { type: String, trim: true, default: "" },
    destinationLeaveYearStart: { type: String, default: undefined, match: /^\d{4}-\d{2}-\d{2}$/ },
    destinationLeaveYearEnd: { type: String, default: undefined, match: /^\d{4}-\d{2}-\d{2}$/ },
    sourceLeavePolicyAssignment: {
      type: Schema.Types.ObjectId,
      ref: "WorkforcePolicyAssignment",
      default: null,
    },
    sourceLeavePolicy: { type: Schema.Types.ObjectId, ref: "LeavePolicy", default: null },
    sourceLeavePolicyVersion: { type: Schema.Types.ObjectId, ref: "LeavePolicyVersion", default: null },
    carryForwardEnabledSnapshot: { type: Boolean, required: true, default: false },
    maxCarryForwardSnapshot: { type: Number, required: true, min: 0, default: 0 },
    carryForwardExpiryMonthsSnapshot: { type: Number, required: true, min: 0, default: 0 },
    carriedUnits: { type: Number, required: true, min: 0, default: 0 },
    lapsedUnits: { type: Number, required: true, min: 0, default: 0 },
    pendingUnits: { type: Number, required: true, min: 0, default: 0 },
    remainingBalanceUnits: { type: Number, required: true, default: 0 },
    iteration: { type: Number, required: true, min: 0, default: 0 },
    status: {
      type: String,
      enum: LEAVE_YEAR_END_CLOSURE_STATUSES,
      required: true,
      default: "partial",
      index: true,
    },
    message: { type: String, trim: true, maxlength: 1000, default: "" },
    lastRun: { type: Schema.Types.ObjectId, ref: "LeaveYearEndRun", default: null },
    completedAt: { type: Date, default: null },
    lastProcessedAt: { type: Date, required: true, default: Date.now },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

LeaveYearEndClosureSchema.index(
  { company: 1, employee: 1, leaveType: 1, sourceLeaveYearKey: 1 },
  { unique: true }
);
LeaveYearEndClosureSchema.index({ company: 1, status: 1, sourceLeaveYearEnd: -1 });

const LeaveYearEndClosure =
  (mongoose.models.LeaveYearEndClosure as mongoose.Model<LeaveYearEndClosureI>) ||
  mongoose.model<LeaveYearEndClosureI>("LeaveYearEndClosure", LeaveYearEndClosureSchema);

export default LeaveYearEndClosure;
