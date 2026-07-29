import mongoose, { Document, Schema } from "mongoose";

export interface EmployeeAssignmentHistoryI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  department?: mongoose.Types.ObjectId;
  departmentNameSnapshot?: string;
  teamId?: mongoose.Types.ObjectId;
  teamNameSnapshot?: string;
  officeLocation?: mongoose.Types.ObjectId;
  officeLocationNameSnapshot?: string;
  designationSnapshot?: string;
  reportingManager?: mongoose.Types.ObjectId;
  reportingManagerNameSnapshot?: string;
  roleSnapshot?: string;
  isDepartmentHead: boolean;
  effectiveFrom: Date;
  effectiveTo?: Date;
  isCurrent: boolean;
  changeType: string;
  changeReason?: string;
  changedBy?: mongoose.Types.ObjectId;
  changeBatchId?: string;
  source?: string;
  endChangeType?: string;
  endReason?: string;
  endedBy?: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const EmployeeAssignmentHistorySchema = new Schema<EmployeeAssignmentHistoryI>(
  {
    company: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    employee: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    department: {
      type: Schema.Types.ObjectId,
      ref: "Department",
      default: null,
      index: true,
    },
    departmentNameSnapshot: { type: String, trim: true },
    teamId: { type: Schema.Types.ObjectId, default: null },
    teamNameSnapshot: { type: String, trim: true },
    officeLocation: {
      type: Schema.Types.ObjectId,
      ref: "OfficeLocation",
      default: null,
      index: true,
    },
    officeLocationNameSnapshot: { type: String, trim: true },
    designationSnapshot: { type: String, trim: true },
    reportingManager: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    reportingManagerNameSnapshot: { type: String, trim: true },
    roleSnapshot: { type: String, trim: true },
    isDepartmentHead: { type: Boolean, default: false },
    effectiveFrom: { type: Date, required: true, index: true },
    effectiveTo: { type: Date, default: null, index: true },
    isCurrent: { type: Boolean, required: true, default: true, index: true },
    changeType: { type: String, required: true, trim: true },
    changeReason: { type: String, trim: true },
    changedBy: { type: Schema.Types.ObjectId, ref: "User" },
    changeBatchId: { type: String, trim: true, index: true },
    source: { type: String, trim: true },
    endChangeType: { type: String, trim: true },
    endReason: { type: String, trim: true },
    endedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

EmployeeAssignmentHistorySchema.index(
  { company: 1, employee: 1, isCurrent: 1 },
  {
    unique: true,
    partialFilterExpression: { isCurrent: true },
  }
);

EmployeeAssignmentHistorySchema.index({
  company: 1,
  employee: 1,
  effectiveFrom: -1,
});

const EmployeeAssignmentHistory = mongoose.model<EmployeeAssignmentHistoryI>(
  "EmployeeAssignmentHistory",
  EmployeeAssignmentHistorySchema
);

export default EmployeeAssignmentHistory;
