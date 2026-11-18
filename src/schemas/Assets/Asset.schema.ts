import mongoose, { Schema } from "mongoose";
import { ASSET_CATEGORY_PATTERN } from "./AssetCategory.schema";

export { ASSET_CATEGORIES } from "./AssetCategory.schema";
export const ASSET_CONDITIONS = ["new", "good", "fair", "damaged"] as const;
export const ASSET_STATES = ["available", "issued", "maintenance", "retired", "written_off", "disposed"] as const;
export const ASSET_CURRENCIES = ["INR", "USD", "EUR", "GBP"] as const;
const asset = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  tag: { type: String, required: true, immutable: true, maxlength: 40 },
  name: { type: String, required: true, maxlength: 150 },
  category: { type: String, match: ASSET_CATEGORY_PATTERN, required: true }, categoryName: { type: String, maxlength: 80 },
  brand: { type: String, default: "", maxlength: 100 }, model: { type: String, default: "", maxlength: 100 },
  serialNumber: { type: String, default: "", maxlength: 100 }, serialKey: { type: String },
  officeLocation: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null }, locationName: { type: String, default: "" },
  condition: { type: String, enum: ASSET_CONDITIONS, default: "new" },
  status: { type: String, enum: ASSET_STATES, default: "available" },
  currentAssignment: { type: Schema.Types.ObjectId, default: null },
  openIncident: { type: Schema.Types.ObjectId, default: null },
  openWriteOff: { type: Schema.Types.ObjectId, default: null }, writtenOffRecord: { type: Schema.Types.ObjectId, default: null }, lastWriteOff: { type: Schema.Types.ObjectId, default: null },
  openDisposal: { type: Schema.Types.ObjectId, default: null }, disposedRecord: { type: Schema.Types.ObjectId, default: null }, lastDisposal: { type: Schema.Types.ObjectId, default: null },
  openService: { type: Schema.Types.ObjectId, default: null }, lastService: { type: Schema.Types.ObjectId, default: null },
  maintenanceReleaseBlocked: { type: Boolean, default: false },
  lastInspection: { type: new Schema({ actor: Schema.Types.ObjectId, actorName: String, inspectedAt: Date, result: String, condition: String, reason: String, serviceOrder: { type: Schema.Types.ObjectId, default: null } }, { _id: false }), default: null },
  holder: { type: new Schema({ employee: Schema.Types.ObjectId, name: String, code: String }, { _id: false }), default: null },
  internalNotes: { type: String, default: "", maxlength: 2000 },
  revision: { type: Number, default: 1 },
  createdBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, updatedBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
asset.index({ company: 1, tag: 1 }, { unique: true });
asset.index({ company: 1, serialKey: 1 }, { unique: true, partialFilterExpression: { serialKey: { $type: "string" } } });
asset.index({ company: 1, status: 1, updatedAt: -1, _id: -1 });
asset.index({ company: 1, updatedAt: -1, _id: -1 });
asset.index({ company: 1, officeLocation: 1, category: 1 });
asset.index({ company: 1, category: 1, updatedAt: -1, _id: -1 });
asset.index({ company: 1, "holder.employee": 1 });
export const Asset = mongoose.models.Asset || mongoose.model("Asset", asset);

const assignment = new Schema({
  employeeAssetSequence: { type: Number, immutable: true },
  incidentFence: { type: Number, default: 0, select: false },
  onboardingFence: { type: Number, default: 0, select: false },
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  asset: { type: Schema.Types.ObjectId, required: true, immutable: true },
  assetSnapshot: { type: new Schema({ tag: String, name: String, category: String, categoryName: String, brand: String, model: String, serialNumber: String }, { _id: false }), required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, required: true, immutable: true },
  employeeName: { type: String, required: true, immutable: true }, employeeCode: { type: String, default: "", immutable: true },
  issuedBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, issuerName: { type: String, required: true, immutable: true },
  issuedAt: { type: Date, required: true, immutable: true }, conditionOut: { type: String, enum: ASSET_CONDITIONS, required: true, immutable: true },
  handoverNotes: { type: String, default: "", immutable: true, maxlength: 1000 }, expectedReturnDate: { type: String, default: "", immutable: true },
  active: { type: Boolean, default: true }, status: { type: String, enum: ["issued", "return_requested", "returned", "voided", "written_off"], default: "issued" },
  writeOffRecord: { type: Schema.Types.ObjectId, default: null }, writtenOffAt: Date, writtenOffByName: String, writtenOffReason: String, writtenOffRecoveredAt: Date,
  acknowledgedAt: { type: Date, default: null }, acknowledgementNote: { type: String, default: "", maxlength: 1000 },
  returnRequestedAt: { type: Date, default: null }, returnRequestReason: { type: String, default: "", maxlength: 1000 },
  returnedAt: { type: Date, default: null }, returnedBy: { type: Schema.Types.ObjectId, default: null }, receiverName: String,
  conditionIn: { type: String, enum: ASSET_CONDITIONS }, returnNotes: { type: String, default: "", maxlength: 1000 },
  voidedAt: { type: Date, default: null }, voidedBy: { type: Schema.Types.ObjectId, default: null }, voiderName: String, voidReason: { type: String, default: "", maxlength: 1000 },
  revision: { type: Number, default: 1 },
}, { timestamps: true });
assignment.index({ company: 1, asset: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
assignment.index({ company: 1, employee: 1, active: 1, issuedAt: -1, _id: -1 });
assignment.index({ company: 1, employee: 1, employeeAssetSequence: 1 });
assignment.index({ company: 1, asset: 1, issuedAt: -1, _id: -1 });
assignment.index({ company: 1, active: 1, issuedAt: -1, _id: -1 });
assignment.index({ company: 1, status: 1, issuedAt: -1, _id: -1 });
export const AssetAssignment = mongoose.models.AssetAssignment || mongoose.model("AssetAssignment", assignment);

const audit = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  asset: { type: Schema.Types.ObjectId, required: true, immutable: true }, assignment: { type: Schema.Types.ObjectId, default: null, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true }, actorName: { type: String, required: true, immutable: true },
  action: { type: String, required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, immutable: true, select: false },
  before: { type: Schema.Types.Mixed, immutable: true }, after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
audit.index({ company: 1, actor: 1, requestId: 1 }, { unique: true });
audit.index({ company: 1, asset: 1, createdAt: -1, _id: -1 });
audit.pre("save", function(next) { next(this.isNew ? undefined : new Error("Asset audit is append-only")); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  audit.pre(operation as any, function(next) { next(new Error("Asset audit is append-only")); });
}
export const AssetAudit = mongoose.models.AssetAudit || mongoose.model("AssetAudit", audit);
