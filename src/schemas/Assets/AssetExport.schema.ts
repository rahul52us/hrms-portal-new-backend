import mongoose, { Schema } from "mongoose";

export const ASSET_EXPORT_STATES = ["queued", "running", "ready", "failed", "cancelled", "expired"] as const;
const job = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, requestedBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, requesterName: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true, select: false }, requestHash: { type: String, required: true, immutable: true, select: false },
  filters: { type: Schema.Types.Mixed, required: true, immutable: true }, filterLabels: { type: Schema.Types.Mixed, required: true, immutable: true }, format: { type: String, enum: ["csv"], default: "csv", immutable: true }, reason: { type: String, required: true, immutable: true },
  state: { type: String, enum: ASSET_EXPORT_STATES, default: "queued" }, active: { type: Boolean, default: true }, revision: { type: Number, default: 1 }, attempts: { type: Number, default: 0 },
  rows: { type: Number, default: 0 }, bytes: { type: Number, default: 0 }, artifact: { type: Schema.Types.ObjectId, default: null, select: false },
  lease: { type: String, default: null, select: false }, leaseUntil: { type: Date, default: null, select: false }, startedAt: Date, completedAt: Date, expiresAt: Date,
  error: { type: String, default: "" }, retryable: { type: Boolean, default: true },
}, { timestamps: true });
job.index({ company: 1, requestedBy: 1, requestId: 1 }, { unique: true });
job.index({ company: 1, requestedBy: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
job.index({ company: 1, requestedBy: 1, createdAt: -1, _id: -1 });
job.index({ state: 1, leaseUntil: 1, createdAt: 1 }); job.index({ state: 1, expiresAt: 1 });
const artifact = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, job: { type: Schema.Types.ObjectId, required: true, immutable: true },
  lease: { type: String, required: true, immutable: true, select: false }, provider: { type: String, enum: ["mongodb", "r2"], required: true, immutable: true },
  storageBucket: { type: String, immutable: true, select: false }, storageKey: { type: String, required: true, immutable: true, select: false },
  state: { type: String, enum: ["staged", "attached", "cleanup_pending", "deleted"], default: "staged" },
  size: Number, sha256: { type: String, select: false }, chunks: Number, rows: Number, cleanupAfter: Date, chunksPruned: { type: Boolean, default: false },
}, { timestamps: true });
artifact.index({ state: 1, cleanupAfter: 1, createdAt: 1 });
const chunk = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, artifact: { type: Schema.Types.ObjectId, required: true, immutable: true },
  sequence: { type: Number, required: true, immutable: true }, bytes: { type: Buffer, required: true, immutable: true, select: false },
}, { timestamps: { createdAt: true, updatedAt: false } });
chunk.index({ company: 1, artifact: 1, sequence: 1 }, { unique: true });
const event = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, job: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, default: null, immutable: true }, actorName: { type: String, required: true, immutable: true },
  action: { type: String, enum: ["queued", "started", "ready", "failed", "cancelled", "retried", "expired"], required: true, immutable: true },
  reason: { type: String, required: true, immutable: true }, requestId: { type: String, required: true, immutable: true, select: false }, requestHash: { type: String, required: true, immutable: true, select: false },
  state: { type: String, required: true, immutable: true }, rows: { type: Number, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
event.index({ company: 1, actor: 1, requestId: 1 }, { unique: true }); event.index({ company: 1, job: 1, createdAt: -1, _id: -1 });
const control = new Schema({ company: { type: Schema.Types.ObjectId, required: true }, actor: { type: Schema.Types.ObjectId, required: true }, revision: { type: Number, default: 0 } });
control.index({ company: 1, actor: 1 }, { unique: true });
event.pre("save", function(next) { next(this.isNew ? undefined : new Error("Export events are append-only")); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) event.pre(operation as any, function(next) { next(new Error("Export events are append-only")); });
export const AssetExportJob = mongoose.models.AssetExportJob || mongoose.model("AssetExportJob", job);
export const AssetExportArtifact = mongoose.models.AssetExportArtifact || mongoose.model("AssetExportArtifact", artifact);
export const AssetExportChunk = mongoose.models.AssetExportChunk || mongoose.model("AssetExportChunk", chunk);
export const AssetExportEvent = mongoose.models.AssetExportEvent || mongoose.model("AssetExportEvent", event);
export const AssetExportControl = mongoose.models.AssetExportControl || mongoose.model("AssetExportControl", control);
