import mongoose, { Document, Schema } from "mongoose";

export const POLICY_RESOURCE_TYPES = [
  "attendance_policy",
  "work_schedule",
  "holiday_calendar",
  "leave_policy",
] as const;
export const POLICY_SCOPE_TYPES = ["company", "location", "department", "team", "employee"] as const;

export interface WorkforcePolicyAssignmentI extends Document {
  company: mongoose.Types.ObjectId;
  resourceType: (typeof POLICY_RESOURCE_TYPES)[number];
  resourceModel: "AttendancePolicy" | "WorkSchedule" | "HolidayCalendar" | "LeavePolicy";
  resource: mongoose.Types.ObjectId;
  scopeType: (typeof POLICY_SCOPE_TYPES)[number];
  scopeId?: mongoose.Types.ObjectId | null;
  scopeNameSnapshot: string;
  priority: number;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  changeReason: string;
  createdBy: mongoose.Types.ObjectId;
  endedBy?: mongoose.Types.ObjectId | null;
  endedAt?: Date | null;
  endReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const WorkforcePolicyAssignmentSchema = new Schema<WorkforcePolicyAssignmentI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    resourceType: { type: String, enum: POLICY_RESOURCE_TYPES, required: true, index: true },
    resourceModel: {
      type: String,
      enum: ["AttendancePolicy", "WorkSchedule", "HolidayCalendar", "LeavePolicy"],
      required: true,
    },
    resource: { type: Schema.Types.ObjectId, refPath: "resourceModel", required: true, index: true },
    scopeType: { type: String, enum: POLICY_SCOPE_TYPES, required: true, index: true },
    scopeId: { type: Schema.Types.ObjectId, default: null, index: true },
    scopeNameSnapshot: { type: String, required: true, trim: true },
    priority: { type: Number, required: true, min: 100 },
    effectiveFrom: { type: Date, required: true, index: true },
    effectiveTo: { type: Date, default: null, index: true },
    changeReason: { type: String, required: true, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    endedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    endedAt: { type: Date, default: null },
    endReason: { type: String, trim: true },
  },
  { timestamps: true }
);

WorkforcePolicyAssignmentSchema.index({
  company: 1,
  resourceType: 1,
  scopeType: 1,
  scopeId: 1,
  effectiveFrom: -1,
});
WorkforcePolicyAssignmentSchema.index({ company: 1, resource: 1, effectiveFrom: -1 });

const WorkforcePolicyAssignment =
  (mongoose.models.WorkforcePolicyAssignment as mongoose.Model<WorkforcePolicyAssignmentI>) ||
  mongoose.model<WorkforcePolicyAssignmentI>(
    "WorkforcePolicyAssignment",
    WorkforcePolicyAssignmentSchema
  );

export default WorkforcePolicyAssignment;
