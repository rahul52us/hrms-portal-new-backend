import mongoose, { Schema } from "mongoose";
import { UploadScanSchema } from "../Storage/UploadScan.schema";

export const ASSET_DOCUMENT_KINDS = ["photo", "invoice", "warranty", "receipt", "manual", "other"] as const;
export const ASSET_DOCUMENT_LIMITS = { active: 20, documents: 100, versionsPerDocument: 20, versionsPerAsset: 200, bytes: 5 * 1024 * 1024 } as const;
const fileSnapshot = new Schema({
  privateFile: { type: Schema.Types.ObjectId, required: true }, name: { type: String, required: true }, type: { type: String, enum: ["application/pdf", "image/jpeg", "image/png"], required: true },
  size: { type: Number, min: 1, max: ASSET_DOCUMENT_LIMITS.bytes, required: true }, sha256: { type: String, required: true }, scan: { type: UploadScanSchema, required: true },
}, { _id: false });
const document = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, asset: { type: Schema.Types.ObjectId, required: true, immutable: true },
  title: { type: String, required: true, minlength: 2, maxlength: 150 }, kind: { type: String, enum: ASSET_DOCUMENT_KINDS, required: true },
  state: { type: String, enum: ["active", "archived"], default: "active" }, revision: { type: Number, default: 1 }, currentVersion: { type: Number, default: 1 }, currentFile: { type: fileSnapshot, required: true },
  createdBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, creatorName: { type: String, required: true, immutable: true },
  updatedByName: String, archivedAt: Date, archiverName: String, archiveReason: String,
}, { timestamps: true });
document.index({ company: 1, asset: 1, state: 1, updatedAt: -1, _id: -1 });
document.index({ company: 1, asset: 1, "currentFile.sha256": 1 }, { unique: true, partialFilterExpression: { state: "active" } });
const version = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, asset: { type: Schema.Types.ObjectId, required: true, immutable: true }, document: { type: Schema.Types.ObjectId, required: true, immutable: true },
  version: { type: Number, required: true, immutable: true }, title: { type: String, required: true, immutable: true }, kind: { type: String, enum: ASSET_DOCUMENT_KINDS, required: true, immutable: true },
  file: { type: fileSnapshot, required: true, immutable: true }, uploadedBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, uploaderName: { type: String, required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
version.index({ company: 1, asset: 1, document: 1, version: 1 }, { unique: true });
version.index({ company: 1, asset: 1, createdAt: -1 });
const event = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, asset: { type: Schema.Types.ObjectId, required: true, immutable: true }, document: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true }, actorName: { type: String, required: true, immutable: true },
  action: { type: String, enum: ["uploaded", "replaced", "updated", "archived", "restored"], required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, immutable: true, select: false },
  before: { type: Schema.Types.Mixed, immutable: true }, after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
event.index({ company: 1, actor: 1, requestId: 1 }, { unique: true });
event.index({ company: 1, asset: 1, document: 1, createdAt: -1, _id: -1 });
for (const schema of [version, event]) {
  schema.pre("save", function(next) { next(this.isNew ? undefined : new Error("Asset document evidence is append-only")); });
  for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) schema.pre(operation as any, function(next) { next(new Error("Asset document evidence is append-only")); });
}
// Every document write touches this row so quotas and active-content uniqueness are not phantom reads.
const control = new Schema({ company: { type: Schema.Types.ObjectId, required: true }, asset: { type: Schema.Types.ObjectId, required: true }, revision: { type: Number, default: 0 } }, { timestamps: true });
control.index({ company: 1, asset: 1 }, { unique: true });
export const AssetDocument = mongoose.models.AssetDocument || mongoose.model("AssetDocument", document);
export const AssetDocumentVersion = mongoose.models.AssetDocumentVersion || mongoose.model("AssetDocumentVersion", version);
export const AssetDocumentEvent = mongoose.models.AssetDocumentEvent || mongoose.model("AssetDocumentEvent", event);
export const AssetDocumentControl = mongoose.models.AssetDocumentControl || mongoose.model("AssetDocumentControl", control);
