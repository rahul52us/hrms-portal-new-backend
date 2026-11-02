import mongoose, { Schema } from "mongoose";

export interface TimesheetRules {
  required: boolean;
  remindersEnabled: boolean;
  remindBeforeHours: number;
  reminderEveryDays: number;
  approverEscalationDays: number;
  deadlineMode: "after_shift" | "payroll_cycle";
  payrollCutoffEnabled: boolean;
  payrollSubmissionDaysAfterCycleEnd: number;
  payrollSubmissionTime: string;
  payrollApprovalDaysAfterCycleEnd: number;
  payrollApprovalTime: string;
  deadlineDaysAfterShift: number;
  deadlineTime: string;
  maxBackdateDays: number;
  minimumEntryMinutes: number;
  maximumDailyEntries: number;
  notesRequired: boolean;
  minimumNotesLength: number;
  allowExtraHours: boolean;
  maximumExtraMinutes: number;
  payrollMode: "report_only" | "block" | "shortfall";
  approvalWorkflowId: string | null;
}

const rules = new Schema<TimesheetRules>({
  approvalWorkflowId: { type: String, default: null },
  required: { type: Boolean, required: true },
  remindersEnabled: { type: Boolean, default: true },
  remindBeforeHours: { type: Number, min: 0, max: 168, default: 24 },
  reminderEveryDays: { type: Number, min: 1, max: 7, default: 1 },
  approverEscalationDays: { type: Number, min: 1, max: 31, default: 2 },
  deadlineMode: { type: String, enum: ["after_shift", "payroll_cycle"], default: "after_shift" },
  payrollCutoffEnabled: { type: Boolean, default: false },
  payrollSubmissionDaysAfterCycleEnd: { type: Number, min: 0, max: 31, default: 1 },
  payrollSubmissionTime: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, default: "10:00" },
  payrollApprovalDaysAfterCycleEnd: { type: Number, min: 0, max: 31, default: 1 },
  payrollApprovalTime: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, default: "14:00" },
  deadlineDaysAfterShift: { type: Number, required: true, min: 0, max: 31 },
  deadlineTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  maxBackdateDays: { type: Number, required: true, min: 0, max: 366 },
  minimumEntryMinutes: { type: Number, required: true, min: 1, max: 480 },
  maximumDailyEntries: { type: Number, required: true, min: 1, max: 100 },
  notesRequired: { type: Boolean, required: true },
  minimumNotesLength: { type: Number, required: true, min: 0, max: 500 },
  allowExtraHours: { type: Boolean, required: true },
  maximumExtraMinutes: { type: Number, required: true, min: 0, max: 720 },
  payrollMode: { type: String, enum: ["report_only", "block", "shortfall"], required: true },
}, { _id: false });

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  policy: { type: Schema.Types.ObjectId, ref: "TimesheetPolicy", required: true, immutable: true },
  versionNumber: { type: Number, required: true, immutable: true },
  revision: { type: Number, required: true, default: 1 },
  status: { type: String, enum: ["draft", "published", "cancelled"], default: "draft", required: true },
  effectiveFrom: { type: Date, default: null },
  rules: { type: rules, required: true },
  changeReason: { type: String, required: true, maxlength: 500 },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  publishedAt: { type: Date, default: null },
  cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, default: "" },
}, { timestamps: true });
schema.index({ company: 1, policy: 1, versionNumber: 1 }, { unique: true });
schema.index({ company: 1, policy: 1, status: 1 }, { unique: true, partialFilterExpression: { status: "draft" } });
schema.index({ company: 1, policy: 1, effectiveFrom: 1 }, { unique: true, partialFilterExpression: { status: "published" } });
schema.index({ company: 1, updatedAt: 1, _id: 1 });
export default mongoose.models.TimesheetPolicyVersion || mongoose.model("TimesheetPolicyVersion", schema);
