import mongoose, { Schema } from "mongoose";

const batch = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  createdBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, creatorName: { type: String, required: true, immutable: true },
  fileName: { type: String, required: true, immutable: true }, fileHash: { type: String, required: true, immutable: true, select: false },
  status: { type: String, enum: ["ready", "invalid", "applied", "cancelled"], required: true }, revision: { type: Number, default: 1 },
  totalRows: { type: Number, required: true, immutable: true }, validRows: { type: Number, required: true, immutable: true }, invalidRows: { type: Number, required: true, immutable: true },
  validUntil: { type: Date, required: true, immutable: true }, appliedRows: { type: Number, default: 0 },
  appliedAt: Date, appliedByName: String, applyReason: String, cancelledAt: Date, cancellerName: String, cancellationReason: String,
}, { timestamps: true });
batch.index({ company: 1, createdAt: -1, _id: -1 });
batch.index({ company: 1, status: 1, createdAt: -1, _id: -1 });
// Identical files cannot create duplicate equipment, even through two concurrently reviewed previews.
batch.index({ company: 1, fileHash: 1 }, { unique: true, partialFilterExpression: { status: "applied" } });

const row = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, batch: { type: Schema.Types.ObjectId, required: true, immutable: true },
  rowNumber: { type: Number, required: true, immutable: true }, source: { type: Schema.Types.Mixed, required: true, immutable: true },
  content: { type: Schema.Types.Mixed, default: null, immutable: true }, categoryRevision: { type: Number, default: null, immutable: true }, locationCode: { type: String, default: "", immutable: true }, locationName: { type: String, default: "", immutable: true },
  validationStatus: { type: String, enum: ["valid", "invalid"], required: true, immutable: true }, errors: { type: [String], default: [], immutable: true },
  asset: { type: Schema.Types.ObjectId, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });
row.index({ company: 1, batch: 1, rowNumber: 1 }, { unique: true });
row.index({ company: 1, batch: 1, validationStatus: 1, rowNumber: 1 });

const event = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, batch: { type: Schema.Types.ObjectId, default: null, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true }, actorName: { type: String, required: true, immutable: true },
  action: { type: String, enum: ["preview", "apply", "cancel", "export"], required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, immutable: true, select: false },
  before: { type: Schema.Types.Mixed, immutable: true }, after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
event.index({ company: 1, actor: 1, requestId: 1 }, { unique: true });
event.index({ company: 1, batch: 1, createdAt: -1, _id: -1 });
event.pre("save", function(next) { next(this.isNew ? undefined : new Error("Asset transfer events are append-only")); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) event.pre(operation as any, function(next) { next(new Error("Asset transfer events are append-only")); });
export const AssetImportBatch = mongoose.models.AssetImportBatch || mongoose.model("AssetImportBatch", batch);
export const AssetImportRow = mongoose.models.AssetImportRow || mongoose.model("AssetImportRow", row);
export const AssetTransferEvent = mongoose.models.AssetTransferEvent || mongoose.model("AssetTransferEvent", event);
