import mongoose, { Schema } from "mongoose";
import { ASSET_CURRENCIES } from "./Asset.schema";

const purchase = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, asset: { type: Schema.Types.ObjectId, required: true, immutable: true },
  vendor: { type: String, default: "", maxlength: 200 }, invoiceReference: { type: String, default: "", maxlength: 150 }, purchaseDate: { type: String, default: "" },
  costMinor: { type: Number, default: null, min: 0, max: 1000000000000 }, currency: { type: String, enum: ASSET_CURRENCIES, default: "INR" },
  warrantyStart: { type: String, default: "" }, warrantyEnd: { type: String, default: "" }, warrantyNotes: { type: String, default: "", maxlength: 2000 },
  remindersEnabled: { type: Boolean, default: true }, reminderDays: { type: Number, default: 30, min: 0, max: 90 },
  noticeKey: { type: String, required: true, select: false }, soonNoticeKey: { type: String, default: "", select: false }, expiredNoticeKey: { type: String, default: "", select: false },
  noRecipientDay: { type: String, default: "", select: false },
  revision: { type: Number, default: 1 }, updatedBy: { type: Schema.Types.ObjectId, required: true }, updaterName: { type: String, required: true },
}, { timestamps: true });
purchase.index({ company: 1, asset: 1 }, { unique: true }); purchase.index({ company: 1, warrantyEnd: 1, _id: 1 });
const purchaseEvent = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, asset: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true }, actorName: { type: String, required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, immutable: true, select: false },
  before: { type: Schema.Types.Mixed, immutable: true }, after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
purchaseEvent.index({ company: 1, actor: 1, requestId: 1 }, { unique: true }); purchaseEvent.index({ company: 1, asset: 1, createdAt: -1, _id: -1 });
export const DISPOSAL_STATES = ["pending", "approved", "completed", "rejected", "withdrawn"] as const;
export const DISPOSAL_METHODS = ["sale", "scrap", "donation"] as const;
const disposal = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, asset: { type: Schema.Types.ObjectId, required: true, immutable: true }, reference: { type: String, required: true, immutable: true },
  assetSnapshot: { type: Schema.Types.Mixed, required: true, immutable: true }, purchaseSnapshot: { type: Schema.Types.Mixed, immutable: true },
  method: { type: String, enum: DISPOSAL_METHODS, required: true, immutable: true }, recipient: { type: String, required: true, maxlength: 200, immutable: true }, proceedsMinor: { type: Number, required: true, min: 0, max: 1000000000000, immutable: true }, currency: { type: String, enum: ASSET_CURRENCIES, required: true, immutable: true },
  reason: { type: String, required: true, maxlength: 2000, immutable: true }, requestedBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, requesterName: { type: String, required: true, immutable: true },
  status: { type: String, enum: DISPOSAL_STATES, default: "pending" }, active: { type: Boolean, default: true }, revision: { type: Number, default: 1 },
  decidedBy: Schema.Types.ObjectId, deciderName: String, decidedAt: Date, decisionReason: String,
  completedBy: Schema.Types.ObjectId, completerName: String, completedAt: Date, evidenceReference: String, completionReason: String, completionChecks: Schema.Types.Mixed,
  withdrawnByName: String, withdrawnAt: Date, withdrawalReason: String,
}, { timestamps: true });
disposal.index({ company: 1, asset: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
disposal.index({ company: 1, asset: 1, status: 1 }, { unique: true, partialFilterExpression: { status: "completed" } });
disposal.index({ company: 1, status: 1, createdAt: -1, _id: -1 }); disposal.index({ company: 1, asset: 1, createdAt: -1, _id: -1 });
const disposalEvent = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, disposal: { type: Schema.Types.ObjectId, required: true, immutable: true }, asset: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true }, actorName: { type: String, required: true, immutable: true }, action: { type: String, enum: ["created", "approve", "reject", "withdraw", "complete"], required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, immutable: true, select: false }, before: { type: Schema.Types.Mixed, immutable: true }, after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
disposalEvent.index({ company: 1, actor: 1, requestId: 1 }, { unique: true }); disposalEvent.index({ company: 1, disposal: 1, createdAt: -1, _id: -1 });
for (const schema of [purchaseEvent, disposalEvent]) {
  schema.pre("save", function(next) { next(this.isNew ? undefined : new Error("Asset lifecycle history is append-only")); });
  for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) schema.pre(operation as any, function(next) { next(new Error("Asset lifecycle history is append-only")); });
}
export const AssetPurchase = mongoose.models.AssetPurchase || mongoose.model("AssetPurchase", purchase);
export const AssetPurchaseEvent = mongoose.models.AssetPurchaseEvent || mongoose.model("AssetPurchaseEvent", purchaseEvent);
export const AssetDisposal = mongoose.models.AssetDisposal || mongoose.model("AssetDisposal", disposal);
export const AssetDisposalEvent = mongoose.models.AssetDisposalEvent || mongoose.model("AssetDisposalEvent", disposalEvent);
