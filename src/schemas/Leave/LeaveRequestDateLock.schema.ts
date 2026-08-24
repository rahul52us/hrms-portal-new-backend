import mongoose, { Document, Schema } from "mongoose";

export interface LeaveRequestDateLockI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  attendanceDate: string;
  request: mongoose.Types.ObjectId;
  leaveType: mongoose.Types.ObjectId;
  createdAt?: Date;
}

const LeaveRequestDateLockSchema = new Schema<LeaveRequestDateLockI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    attendanceDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    request: { type: Schema.Types.ObjectId, ref: "LeaveRequest", required: true, index: true },
    leaveType: { type: Schema.Types.ObjectId, ref: "LeaveType", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

LeaveRequestDateLockSchema.index(
  { company: 1, employee: 1, attendanceDate: 1 },
  { unique: true }
);

const LeaveRequestDateLock =
  (mongoose.models.LeaveRequestDateLock as mongoose.Model<LeaveRequestDateLockI>) ||
  mongoose.model<LeaveRequestDateLockI>("LeaveRequestDateLock", LeaveRequestDateLockSchema);

export default LeaveRequestDateLock;
