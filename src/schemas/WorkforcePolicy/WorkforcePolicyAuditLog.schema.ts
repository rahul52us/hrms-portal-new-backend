import mongoose, { Document, Schema } from "mongoose";

export interface WorkforcePolicyAuditLogI extends Document {
  company: mongoose.Types.ObjectId;
  entityType:
    | "attendance_policy"
    | "attendance_version"
    | "work_schedule"
    | "work_schedule_version"
    | "holiday_calendar"
    | "holiday_version"
    | "leave_type"
    | "leave_policy"
    | "leave_version"
    | "remote_work_policy"
    | "remote_work_version"
    | "assignment";
  entityId: mongoose.Types.ObjectId;
  action: string;
  actor: mongoose.Types.ObjectId;
  details?: any;
  createdAt?: Date;
}

const WorkforcePolicyAuditLogSchema = new Schema<WorkforcePolicyAuditLogI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    entityType: {
      type: String,
      enum: [
        "attendance_policy",
        "attendance_version",
        "work_schedule",
        "work_schedule_version",
        "holiday_calendar",
        "holiday_version",
        "leave_type",
        "leave_policy",
        "leave_version",
        "remote_work_policy",
        "remote_work_version",
        "assignment",
      ],
      required: true,
      index: true,
    },
    entityId: { type: Schema.Types.ObjectId, required: true, index: true },
    action: { type: String, required: true, trim: true, index: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    details: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

WorkforcePolicyAuditLogSchema.index({ company: 1, entityType: 1, entityId: 1, createdAt: -1 });

const WorkforcePolicyAuditLog =
  (mongoose.models.WorkforcePolicyAuditLog as mongoose.Model<WorkforcePolicyAuditLogI>) ||
  mongoose.model<WorkforcePolicyAuditLogI>("WorkforcePolicyAuditLog", WorkforcePolicyAuditLogSchema);

export default WorkforcePolicyAuditLog;
