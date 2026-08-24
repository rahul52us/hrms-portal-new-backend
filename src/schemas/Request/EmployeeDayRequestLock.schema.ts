import mongoose, { Document, Schema } from "mongoose";

export interface EmployeeDayRequestLockI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  attendanceDate: string;
  requestType: "leave" | "remote_work";
  requestModel: "LeaveRequest" | "RemoteWorkRequest";
  request: mongoose.Types.ObjectId;
  createdAt?: Date;
}

const EmployeeDayRequestLockSchema = new Schema<EmployeeDayRequestLockI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    attendanceDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    requestType: { type: String, enum: ["leave", "remote_work"], required: true, index: true },
    requestModel: { type: String, enum: ["LeaveRequest", "RemoteWorkRequest"], required: true },
    request: { type: Schema.Types.ObjectId, refPath: "requestModel", required: true, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

EmployeeDayRequestLockSchema.index(
  { company: 1, employee: 1, attendanceDate: 1 },
  { unique: true }
);
EmployeeDayRequestLockSchema.index({ company: 1, requestType: 1, request: 1 });

const EmployeeDayRequestLock =
  (mongoose.models.EmployeeDayRequestLock as mongoose.Model<EmployeeDayRequestLockI>) ||
  mongoose.model<EmployeeDayRequestLockI>("EmployeeDayRequestLock", EmployeeDayRequestLockSchema);

export default EmployeeDayRequestLock;

