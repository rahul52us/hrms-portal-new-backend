import mongoose, { Schema } from "mongoose";
import { ASSET_CONDITIONS, ASSET_CURRENCIES } from "./Asset.schema";

export const SERVICE_STATES = ["open", "in_progress", "awaiting_inspection", "completed", "unrepairable", "cancelled", "written_off"] as const;
export const SERVICE_CURRENCIES = ASSET_CURRENCIES;
export const SERVICE_KINDS = ["repair", "preventive_service"] as const;
const order = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, asset: { type: Schema.Types.ObjectId, required: true, immutable: true },
  reference: { type: String, required: true, immutable: true },
  assetSnapshot: { type: new Schema({ name: String, tag: String, category: String, categoryName: String, serialNumber: String }, { _id: false }), required: true, immutable: true },
  incident: { type: Schema.Types.ObjectId, default: null, immutable: true }, incidentReference: { type: String, default: "", immutable: true },
  kind: { type: String, enum: SERVICE_KINDS, required: true, immutable: true }, issueDescription: { type: String, required: true, maxlength: 2000, immutable: true },
  providerType: { type: String, enum: ["internal", "external"], required: true, immutable: true },
  providerName: { type: String, default: "", maxlength: 150, immutable: true }, providerReference: { type: String, default: "", maxlength: 100, immutable: true },
  expectedCompletionDate: { type: String, default: "", immutable: true },
  status: { type: String, enum: SERVICE_STATES, default: "open" }, active: { type: Boolean, default: true }, revision: { type: Number, default: 1 }, cycle: { type: Number, default: 1 },
  externalDispatched: { type: Boolean, default: false }, dispatchedAt: Date, dispatchedBy: Schema.Types.ObjectId, dispatcherName: String,
  receivedAt: Date, receivedBy: Schema.Types.ObjectId, receiverName: String,
  startedAt: Date, startedBy: Schema.Types.ObjectId, starterName: String,
  workCompletedAt: Date, workCompletedBy: Schema.Types.ObjectId, workCompletedName: String,
  workPerformed: { type: String, default: "", maxlength: 2000 }, actualCostMinor: { type: Number, default: null, min: 0, max: 1000000000000, validate: { validator: (value: any) => value === null || Number.isSafeInteger(value) } },
  currency: { type: String, enum: SERVICE_CURRENCIES, default: "INR" },
  inspectedAt: Date, inspectedBy: Schema.Types.ObjectId, inspectorName: String,
  inspectionResult: { type: String, enum: ["passed", "rework", "unrepairable"] }, inspectionCondition: { type: String, enum: ASSET_CONDITIONS }, inspectionReason: String,
  closedAt: Date, closedBy: Schema.Types.ObjectId, closerName: String, closeReason: String,
  writeOffRecord: { type: Schema.Types.ObjectId, default: null }, recoveredAfterWriteOffAt: Date,
  createdBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, creatorName: { type: String, required: true, immutable: true },
}, { timestamps: true });
order.index({ company: 1, asset: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
order.index({ company: 1, status: 1, createdAt: -1, _id: -1 });
order.index({ company: 1, asset: 1, createdAt: -1, _id: -1 });
const event = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, serviceOrder: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true }, actorName: { type: String, required: true, immutable: true },
  action: { type: String, required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, immutable: true, select: false },
  before: { type: Schema.Types.Mixed, immutable: true }, after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
event.index({ company: 1, actor: 1, requestId: 1 }, { unique: true });
event.index({ company: 1, serviceOrder: 1, createdAt: -1, _id: -1 });
event.pre("save", function(next) { next(this.isNew ? undefined : new Error("Service events are append-only")); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) event.pre(operation as any, function(next) { next(new Error("Service events are append-only")); });
export const AssetServiceOrder = mongoose.models.AssetServiceOrder || mongoose.model("AssetServiceOrder", order);
export const AssetServiceEvent = mongoose.models.AssetServiceEvent || mongoose.model("AssetServiceEvent", event);
