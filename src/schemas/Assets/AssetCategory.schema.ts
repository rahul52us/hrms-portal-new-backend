import mongoose, { Schema } from "mongoose";

export const ASSET_CATEGORIES = ["laptop", "desktop", "monitor", "phone", "tablet", "accessory", "other"] as const;
export const BUILTIN_ASSET_CATEGORIES: Record<string, string> = Object.freeze(Object.assign(Object.create(null), { laptop: "Laptop", desktop: "Desktop", monitor: "Monitor", phone: "Phone", tablet: "Tablet", accessory: "Accessory", other: "Other" }));
export const ASSET_CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const category = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, code: { type: String, required: true, immutable: true, match: ASSET_CATEGORY_PATTERN, validate: { validator: (value: string) => value !== "all" && !ASSET_CATEGORIES.includes(value as any), message: "Built-in/filter codes are reserved" } },
  name: { type: String, required: true, minlength: 2, maxlength: 80 }, nameKey: { type: String, required: true },
  state: { type: String, enum: ["active", "archived"], default: "active" }, revision: { type: Number, default: 1 }, useFence: { type: Number, select: false },
  createdBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, updatedBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
category.index({ company: 1, code: 1 }, { unique: true });
// Archived identities keep their names/codes reserved; restoration must never mean a different category.
category.index({ company: 1, nameKey: 1 }, { unique: true });
category.index({ company: 1, state: 1, nameKey: 1, _id: 1 });
const event = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true }, category: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true }, actorName: { type: String, required: true, immutable: true },
  action: { type: String, enum: ["created", "updated", "archived", "restored"], required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true }, requestHash: { type: String, required: true, select: false, immutable: true },
  before: { type: Schema.Types.Mixed, immutable: true }, after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
event.index({ company: 1, actor: 1, requestId: 1 }, { unique: true });
event.index({ company: 1, category: 1, createdAt: -1, _id: -1 });
event.pre("save", function(next) { next(this.isNew ? undefined : new Error("Asset category history is append-only")); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) event.pre(operation as any, function(next) { next(new Error("Asset category history is append-only")); });
export const AssetCategory = mongoose.models.AssetCategory || mongoose.model("AssetCategory", category);
export const AssetCategoryEvent = mongoose.models.AssetCategoryEvent || mongoose.model("AssetCategoryEvent", event);
