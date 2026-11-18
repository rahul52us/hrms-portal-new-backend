import mongoose, { Schema } from "mongoose";
import { ASSET_CONDITIONS } from "./Asset.schema";

export const INCIDENT_KINDS = ["loss", "theft", "damage", "malfunction"] as const;
export const INCIDENT_STATES = ["open", "under_review", "resolved", "dismissed", "written_off"] as const;
const incident = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  asset: { type: Schema.Types.ObjectId, required: true, immutable: true },
  assignment: { type: Schema.Types.ObjectId, default: null, immutable: true },
  reference: { type: String, required: true, immutable: true },
  assetSnapshot: { type: new Schema({ name: String, tag: String, serialNumber: String, category: String, categoryName: String }, { _id: false }), required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, default: null, immutable: true },
  employeeName: { type: String, default: "", immutable: true }, employeeCode: { type: String, default: "", immutable: true },
  reportedBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, reporterName: { type: String, required: true, immutable: true },
  kind: { type: String, enum: INCIDENT_KINDS, required: true, immutable: true },
  occurredAt: { type: Date, required: true, immutable: true }, description: { type: String, required: true, immutable: true, maxlength: 2000 },
  status: { type: String, enum: INCIDENT_STATES, default: "open" }, active: { type: Boolean, default: true },
  revision: { type: Number, default: 1 }, reviewedBy: { type: Schema.Types.ObjectId, default: null }, reviewerName: String, reviewedAt: Date,
  closedBy: { type: Schema.Types.ObjectId, default: null }, closerName: String, closedAt: Date,
  resolutionReason: { type: String, default: "", maxlength: 1000 }, conditionAfter: { type: String, enum: ASSET_CONDITIONS },
  writeOffRecord: { type: Schema.Types.ObjectId, default: null }, recoveredAfterWriteOffAt: Date,
}, { timestamps: true });
incident.index({ company: 1, asset: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
incident.index({ company: 1, status: 1, createdAt: -1, _id: -1 });
incident.index({ company: 1, employee: 1, createdAt: -1, _id: -1 });
incident.index({ company: 1, employee: 1, active: 1 });
incident.index({ company: 1, reportedBy: 1, createdAt: -1, _id: -1 });
incident.index({ company: 1, asset: 1, createdAt: -1, _id: -1 });
const event = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, incident: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true }, actorName: { type: String, required: true, immutable: true },
  action: { type: String, required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, immutable: true, select: false },
  before: { type: Schema.Types.Mixed, immutable: true }, after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
event.index({ company: 1, actor: 1, requestId: 1 }, { unique: true });
event.index({ company: 1, incident: 1, createdAt: -1, _id: -1 });
event.pre("save", function(next) { next(this.isNew ? undefined : new Error("Asset incident events are append-only")); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) event.pre(operation as any, function(next) { next(new Error("Asset incident events are append-only")); });
export const AssetIncident = mongoose.models.AssetIncident || mongoose.model("AssetIncident", incident);
export const AssetIncidentEvent = mongoose.models.AssetIncidentEvent || mongoose.model("AssetIncidentEvent", event);
