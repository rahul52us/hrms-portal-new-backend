import mongoose, { Document, Schema } from "mongoose";

export interface LeaveTypeI extends Document {
  company: mongoose.Types.ObjectId;
  name: string;
  code: string;
  description?: string;
  paid: boolean;
  balanceTracked: boolean;
  unit: "days" | "hours";
  allowHalfDay: boolean;
  color: string;
  status: "active" | "archived";
  displayOrder: number;
  createdBy: mongoose.Types.ObjectId;
  archivedAt?: Date | null;
  archivedBy?: mongoose.Types.ObjectId | null;
  archiveReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const LeaveTypeSchema = new Schema<LeaveTypeI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, trim: true },
    paid: { type: Boolean, default: true },
    balanceTracked: { type: Boolean, default: true },
    unit: { type: String, enum: ["days", "hours"], default: "days" },
    allowHalfDay: { type: Boolean, default: true },
    color: { type: String, trim: true, default: "#3182CE" },
    status: { type: String, enum: ["active", "archived"], default: "active", index: true },
    displayOrder: { type: Number, min: 0, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    archiveReason: { type: String, trim: true },
  },
  { timestamps: true }
);

LeaveTypeSchema.index({ company: 1, code: 1 }, { unique: true });
LeaveTypeSchema.index({ company: 1, status: 1, displayOrder: 1, name: 1 });

const LeaveType =
  (mongoose.models.LeaveType as mongoose.Model<LeaveTypeI>) ||
  mongoose.model<LeaveTypeI>("LeaveType", LeaveTypeSchema);

export default LeaveType;
