import mongoose, { Schema } from "mongoose";
import { assetRequirementSchema, TASK_OWNERS } from "./OnboardingTemplate.schema";
import { UploadScanSchema } from "../Storage/UploadScan.schema";

const documentMetadata = new Schema({ document: { type: Schema.Types.ObjectId, required: true }, name: String, type: String, size: Number, uploadedBy: { type: Schema.Types.ObjectId, ref: "User" }, uploadedAt: Date, scan: { type: UploadScanSchema, default: undefined } }, { _id: false });
const task = new Schema({
  kind: { type: String, enum: ["standard", "policy_acknowledgement", "asset_provisioning"], default: "standard", immutable: true },
  assetRequirement: { type: assetRequirementSchema, default: null, immutable: true },
  assetCycle: { type: Number, default: 1 },
  assetProvision: { type: new Schema({ linked: Number, issued: Number, acknowledged: Number, fulfilled: Number, required: Number, receiptRequired: Boolean, evaluatedAt: Date }, { _id: false }), default: null },
  policySnapshot: { type: new Schema({ policy: Schema.Types.ObjectId, policyVersion: Schema.Types.ObjectId, name: String, version: Number, contentHash: String, acknowledgementText: String }, { _id: false }), default: null, immutable: true },
  acknowledgementCycle: { type: Number, default: 1 },
  acknowledgement: { type: new Schema({ receipt: Schema.Types.ObjectId, employeeName: String, acknowledgedAt: Date, cycle: Number }, { _id: false }), default: null },
  templateTask: { type: Schema.Types.ObjectId, required: true, immutable: true },
  title: { type: String, required: true, immutable: true },
  instructions: { type: String, default: "", immutable: true },
  owner: { type: String, enum: TASK_OWNERS, required: true, immutable: true },
  dueDays: { type: Number, required: true, immutable: true },
  required: { type: Boolean, required: true, immutable: true },
  requiresDocument: { type: Boolean, required: true, immutable: true },
  assignees: [{ user: { type: Schema.Types.ObjectId, ref: "User", required: true }, name: { type: String, required: true } }],
  ownerIssue: { type: String, default: "" },
  ownerResolution: { type: String, enum: ["template", "manual"], default: "template" },
  dueDate: { type: String, required: true },
  dueAt: { type: Date, required: true },
  status: { type: String, enum: ["blocked", "pending", "pending_review", "completed", "waived"], required: true },
  documents: { type: [documentMetadata], default: [] },
  completionNote: { type: String, default: "" },
  completedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  completedAt: { type: Date, default: null },
});
const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  employeeNameSnapshot: { type: String, required: true, immutable: true },
  employeeCodeSnapshot: { type: String, default: "", immutable: true },
  template: { type: Schema.Types.ObjectId, ref: "OnboardingTemplate", required: true, immutable: true },
  templateVersion: { type: Schema.Types.ObjectId, ref: "OnboardingTemplateVersion", required: true, immutable: true },
  versionNumber: { type: Number, required: true, immutable: true },
  templateName: { type: String, required: true, immutable: true },
  templateDescription: { type: String, default: "", immutable: true },
  joiningDate: { type: String, required: true },
  timezone: { type: String, required: true },
  status: { type: String, enum: ["active", "completed", "cancelled"], default: "active", required: true },
  isCurrent: { type: Boolean, default: true, required: true },
  revision: { type: Number, default: 1, required: true },
  automationFence: { type: Number, default: 0, select: false },
  retentionFence: { type: Number, default: 0, select: false },
  tasks: { type: [task], required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });
schema.index({ company: 1, employee: 1, template: 1, joiningDate: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } });
schema.index({ company: 1, employee: 1, createdAt: -1, _id: -1 });
schema.index({ company: 1, "tasks.assignees.user": 1, status: 1 });
schema.index({ company: 1, status: 1, createdAt: -1, _id: -1 });
schema.index({ company: 1, isCurrent: 1, "tasks.dueAt": 1, _id: 1 });
schema.index({ company: 1, "tasks.documents.document": 1 });
export default mongoose.models.EmployeeOnboarding || mongoose.model("EmployeeOnboarding", schema);
