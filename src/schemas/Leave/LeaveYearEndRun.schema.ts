import mongoose, { Document, Schema } from "mongoose";

export interface LeaveYearEndRunI extends Document {
  company: mongoose.Types.ObjectId;
  asOf: string;
  trigger: "manual" | "scheduler";
  employee?: mongoose.Types.ObjectId | null;
  status: "running" | "completed" | "partial" | "failed";
  processedBalances: number;
  completedClosures: number;
  partialClosures: number;
  configurationErrors: number;
  carriedUnits: number;
  lapsedUnits: number;
  expiredUnits: number;
  deferredExpiryLots: number;
  failedItems: number;
  failures: Array<{ employee?: mongoose.Types.ObjectId | null; leaveType?: mongoose.Types.ObjectId | null; message: string }>;
  startedAt: Date;
  completedAt?: Date | null;
  triggeredBy?: mongoose.Types.ObjectId | null;
}

const LeaveYearEndRunSchema = new Schema<LeaveYearEndRunI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    asOf: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    trigger: { type: String, enum: ["manual", "scheduler"], required: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    status: {
      type: String,
      enum: ["running", "completed", "partial", "failed"],
      default: "running",
      index: true,
    },
    processedBalances: { type: Number, min: 0, default: 0 },
    completedClosures: { type: Number, min: 0, default: 0 },
    partialClosures: { type: Number, min: 0, default: 0 },
    configurationErrors: { type: Number, min: 0, default: 0 },
    carriedUnits: { type: Number, min: 0, default: 0 },
    lapsedUnits: { type: Number, min: 0, default: 0 },
    expiredUnits: { type: Number, min: 0, default: 0 },
    deferredExpiryLots: { type: Number, min: 0, default: 0 },
    failedItems: { type: Number, min: 0, default: 0 },
    failures: {
      type: [
        new Schema(
          {
            employee: { type: Schema.Types.ObjectId, ref: "User", default: null },
            leaveType: { type: Schema.Types.ObjectId, ref: "LeaveType", default: null },
            message: { type: String, required: true, trim: true, maxlength: 1000 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    startedAt: { type: Date, required: true, default: Date.now },
    completedAt: { type: Date, default: null },
    triggeredBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

LeaveYearEndRunSchema.index({ company: 1, createdAt: -1 });

const LeaveYearEndRun =
  (mongoose.models.LeaveYearEndRun as mongoose.Model<LeaveYearEndRunI>) ||
  mongoose.model<LeaveYearEndRunI>("LeaveYearEndRun", LeaveYearEndRunSchema);

export default LeaveYearEndRun;
