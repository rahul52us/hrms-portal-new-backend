import mongoose, { Schema } from "mongoose";

/** A per-employee write fence serialises issue, source custody changes and clearance decisions. */
const control = new Schema({
  company: { type: Schema.Types.ObjectId, required: true }, employee: { type: Schema.Types.ObjectId, required: true },
  revision: { type: Number, default: 0 }, sourceRevision: { type: Number, default: 0 }, clearance: { type: Schema.Types.ObjectId, default: null }, issueBlocked: { type: Boolean, default: false },
}, { timestamps: true });
control.index({ company: 1, employee: 1 }, { unique: true });
control.index({ company: 1, issueBlocked: 1, employee: 1 });
const clearance = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, employee: { type: Schema.Types.ObjectId, required: true, immutable: true },
  employeeName: { type: String, required: true, immutable: true }, employeeCode: { type: String, default: "", immutable: true },
  reference: { type: String, required: true, immutable: true }, openedAt: { type: Date, required: true, immutable: true },
  issueSequenceCutoff: { type: Number, required: true, immutable: true }, initialOutstanding: { type: Number, required: true, immutable: true },
  lastWorkingDate: { type: String, required: true }, status: { type: String, enum: ["open", "cleared", "cancelled"], default: "open" }, isCurrent: { type: Boolean, default: true },
  revision: { type: Number, default: 1 }, cycle: { type: Number, default: 1 },
  createdBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, creatorName: { type: String, required: true, immutable: true },
  openingReason: { type: String, required: true, maxlength: 1000, immutable: true },
  clearedAt: Date, clearedBy: Schema.Types.ObjectId, clearerName: String, clearanceReason: String,
  cancelledAt: Date, cancelledBy: Schema.Types.ObjectId, cancellerName: String, cancellationReason: String,
  lastSummary: { type: Schema.Types.Mixed, default: null }, clearanceEvidence: { type: Schema.Types.Mixed, default: null },
}, { timestamps: true });
clearance.index({ company: 1, employee: 1, isCurrent: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } });
clearance.index({ company: 1, status: 1, createdAt: -1, _id: -1 });
clearance.index({ company: 1, employee: 1, createdAt: -1, _id: -1 });
const event = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, clearance: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true }, actorName: { type: String, required: true, immutable: true },
  action: { type: String, required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, immutable: true, select: false },
  before: { type: Schema.Types.Mixed, immutable: true }, after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
event.index({ company: 1, actor: 1, requestId: 1 }, { unique: true });
event.index({ company: 1, clearance: 1, createdAt: -1, _id: -1 });
event.pre("save", function(next) { next(this.isNew ? undefined : new Error("Asset clearance events are append-only")); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) event.pre(operation as any, function(next) { next(new Error("Asset clearance events are append-only")); });
export const AssetEmployeeControl = mongoose.models.AssetEmployeeControl || mongoose.model("AssetEmployeeControl", control);
export const AssetClearance = mongoose.models.AssetClearance || mongoose.model("AssetClearance", clearance);
export const AssetClearanceEvent = mongoose.models.AssetClearanceEvent || mongoose.model("AssetClearanceEvent", event);
