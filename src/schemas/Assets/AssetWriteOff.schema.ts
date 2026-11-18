import mongoose, { Schema } from "mongoose";
import { ASSET_CONDITIONS, ASSET_CURRENCIES } from "./Asset.schema";

export const WRITE_OFF_STATES = ["pending", "approved", "rejected", "withdrawn", "recovered"] as const;
const record = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, asset: { type: Schema.Types.ObjectId, required: true, immutable: true }, incident: { type: Schema.Types.ObjectId, required: true, immutable: true },
  assignment: { type: Schema.Types.ObjectId, default: null, immutable: true }, serviceOrder: { type: Schema.Types.ObjectId, default: null, immutable: true },
  reference: { type: String, required: true, immutable: true }, incidentReference: { type: String, required: true, immutable: true },
  assetSnapshot: { type: new Schema({ name: String, tag: String, category: String, categoryName: String, serialNumber: String }, { _id: false }), required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, default: null, immutable: true }, employeeName: { type: String, default: "", immutable: true }, employeeCode: { type: String, default: "", immutable: true },
  lastKnownCustody: { type: String, enum: ["employee", "service_provider", "company"], required: true, immutable: true }, providerName: { type: String, default: "", immutable: true },
  kind: { type: String, enum: ["loss", "theft"], required: true, immutable: true }, reason: { type: String, required: true, maxlength: 2000, immutable: true }, evidenceReference: { type: String, default: "", maxlength: 200, immutable: true },
  amountMinor: { type: Number, default: null, min: 0, max: 1000000000000, immutable: true, validate: { validator: (value: any) => value === null || Number.isSafeInteger(value) } }, currency: { type: String, enum: ASSET_CURRENCIES, required: true, immutable: true },
  recoveredAmountMinor: { type: Number, default: 0, min: 0, max: 1000000000000 },
  requestedBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, requesterName: { type: String, required: true, immutable: true },
  status: { type: String, enum: WRITE_OFF_STATES, default: "pending" }, active: { type: Boolean, default: true }, revision: { type: Number, default: 1 },
  decidedBy: Schema.Types.ObjectId, deciderName: String, decidedAt: Date, decisionReason: String,
  recoveredBy: Schema.Types.ObjectId, recovererName: String, recoveredAt: Date, recoveredCondition: { type: String, enum: ASSET_CONDITIONS }, recoveryReason: String,
}, { timestamps: true });
record.index({ company: 1, asset: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
record.index({ company: 1, status: 1, createdAt: -1, _id: -1 });
record.index({ company: 1, asset: 1, createdAt: -1, _id: -1 });
record.index({ company: 1, employee: 1, status: 1 });
const event = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, writeOff: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true }, actorName: { type: String, required: true, immutable: true }, action: { type: String, required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, immutable: true, select: false },
  before: { type: Schema.Types.Mixed, immutable: true }, after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
event.index({ company: 1, actor: 1, requestId: 1 }, { unique: true });
event.index({ company: 1, writeOff: 1, createdAt: -1, _id: -1 });
const ledger = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, writeOff: { type: Schema.Types.ObjectId, required: true, immutable: true }, event: { type: Schema.Types.ObjectId, required: true, immutable: true },
  kind: { type: String, enum: ["write_off", "physical_recovery", "recovery_receipt", "recovery_reversal"], required: true, immutable: true },
  amountMinor: { type: Number, default: null, min: 0, max: 1000000000000, immutable: true, validate: { validator: (value: any) => value === null || Number.isSafeInteger(value) } }, currency: { type: String, enum: ASSET_CURRENCIES, required: true, immutable: true },
  source: { type: String, enum: ["insurance", "supplier", "other"] }, receiptReference: { type: String, maxlength: 150 }, receiptRefKey: { type: String, immutable: true },
  reverses: { type: Schema.Types.ObjectId, immutable: true }, actor: { type: Schema.Types.ObjectId, required: true, immutable: true }, actorName: { type: String, required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
ledger.index({ company: 1, event: 1 }, { unique: true });
ledger.index({ company: 1, writeOff: 1, reverses: 1 }, { unique: true, partialFilterExpression: { reverses: { $type: "objectId" } } });
ledger.index({ company: 1, writeOff: 1, createdAt: -1, _id: -1 });
ledger.index({ company: 1, writeOff: 1, receiptRefKey: 1, kind: 1 });
for (const schema of [event, ledger]) {
  schema.pre("save", function(next) { next(this.isNew ? undefined : new Error("Write-off evidence is append-only")); });
  for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) schema.pre(operation as any, function(next) { next(new Error("Write-off evidence is append-only")); });
}
export const AssetWriteOff = mongoose.models.AssetWriteOff || mongoose.model("AssetWriteOff", record);
export const AssetWriteOffEvent = mongoose.models.AssetWriteOffEvent || mongoose.model("AssetWriteOffEvent", event);
export const AssetLossLedger = mongoose.models.AssetLossLedger || mongoose.model("AssetLossLedger", ledger);
