import mongoose, { Schema } from "mongoose";

const link = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  onboarding: { type: Schema.Types.ObjectId, required: true, immutable: true },
  task: { type: Schema.Types.ObjectId, required: true, immutable: true },
  cycle: { type: Number, required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, required: true, immutable: true },
  assignment: { type: Schema.Types.ObjectId, required: true, immutable: true },
  asset: { type: Schema.Types.ObjectId, required: true, immutable: true },
  assetSnapshot: { type: new Schema({ tag: String, name: String, category: String, brand: String, model: String, serialNumber: String }, { _id: false }), required: true, immutable: true },
  issuedAt: { type: Date, required: true, immutable: true },
  linkedBy: { type: Schema.Types.ObjectId, required: true, immutable: true }, linkedByName: { type: String, required: true, immutable: true },
  linkedAt: { type: Date, required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  active: { type: Boolean, required: true, default: true },
  status: { type: String, enum: ["linked", "detached", "custody_closed", "released"], default: "linked" },
  endedAt: Date, endedBy: { type: Schema.Types.ObjectId }, endReason: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
link.index({ company: 1, assignment: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
link.index({ company: 1, onboarding: 1, task: 1, cycle: 1, active: 1, createdAt: -1, _id: -1 });
link.index({ company: 1, onboarding: 1, task: 1, createdAt: -1, _id: -1 });
const event = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  onboarding: { type: Schema.Types.ObjectId, required: true, immutable: true }, task: { type: Schema.Types.ObjectId, required: true, immutable: true },
  cycle: { type: Number, required: true, immutable: true }, link: { type: Schema.Types.ObjectId, default: null, immutable: true }, assignment: { type: Schema.Types.ObjectId, default: null, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true }, actorName: { type: String, required: true, immutable: true },
  action: { type: String, required: true, immutable: true }, reason: { type: String, required: true, immutable: true },
  eventKey: { type: String, required: true, immutable: true }, requestId: { type: String, immutable: true }, requestHash: { type: String, immutable: true, select: false },
  before: { type: Schema.Types.Mixed, immutable: true }, after: { type: Schema.Types.Mixed, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
event.index({ company: 1, eventKey: 1 }, { unique: true });
event.index({ company: 1, actor: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: "string" } } });
event.index({ company: 1, onboarding: 1, task: 1, createdAt: -1, _id: -1 });
event.pre("save", function(next) { next(this.isNew ? undefined : new Error("Onboarding asset events are append-only")); });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  event.pre(operation as any, function(next) { next(new Error("Onboarding asset events are append-only")); });
}
export const OnboardingAssetLink = mongoose.models.OnboardingAssetLink || mongoose.model("OnboardingAssetLink", link);
export const OnboardingAssetEvent = mongoose.models.OnboardingAssetEvent || mongoose.model("OnboardingAssetEvent", event);
