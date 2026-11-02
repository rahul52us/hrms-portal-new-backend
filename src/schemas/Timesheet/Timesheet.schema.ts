import mongoose, { Schema } from "mongoose";

export const timesheetEntrySchema = new Schema({
  entryId: { type: String, required: true },
  project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
  workType: { type: Schema.Types.ObjectId, ref: "ProjectWorkType", required: true },
  assignment: { type: Schema.Types.ObjectId, ref: "ProjectAssignment", required: true },
  projectNameSnapshot: { type: String, required: true },
  projectCodeSnapshot: { type: String, required: true },
  projectRevisionSnapshot: { type: Number, required: true },
  workTypeNameSnapshot: { type: String, required: true },
  workTypeCodeSnapshot: { type: String, required: true },
  startDate: { type: String, required: true },
  startTime: { type: String, required: true },
  endDate: { type: String, required: true },
  endTime: { type: String, required: true },
  startedAt: { type: Date, required: true },
  endedAt: { type: Date, required: true },
  minutes: { type: Number, required: true, min: 1 },
  notes: { type: String, maxlength: 2000, default: "" },
}, { _id: false });

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  attendanceDate: { type: String, required: true, immutable: true },
  timezone: { type: String, required: true },
  status: { type: String, enum: ["draft", "submitted", "returned", "rejected", "approved"], default: "draft", required: true },
  currentSubmission: { type: Schema.Types.ObjectId, ref: "TimesheetSubmission", default: null },
  submissionCount: { type: Number, default: 0, min: 0 },
  entries: { type: [timesheetEntrySchema], default: [], validate: [(value: any[]) => value.length <= 100, "Too many entries"] },
  loggedMinutes: { type: Number, required: true, min: 0 },
  requiredMinutes: { type: Number, default: null, min: 0 },
  shortfallMinutes: { type: Number, default: null, min: 0 },
  revision: { type: Number, required: true, min: 1 },
  contextSnapshot: { type: Schema.Types.Mixed, required: true },
  payrollLockedAt: { type: Date, default: null },
  payrollInput: { type: Schema.Types.ObjectId, ref: "TimesheetPayrollInput", default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });
schema.index({ company: 1, employee: 1, attendanceDate: 1 }, { unique: true });
schema.index({ company: 1, attendanceDate: 1, status: 1, employee: 1 });
export default mongoose.models.Timesheet || mongoose.model("Timesheet", schema);
