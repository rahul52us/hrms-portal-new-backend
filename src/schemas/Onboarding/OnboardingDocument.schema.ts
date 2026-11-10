import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  onboarding: { type: Schema.Types.ObjectId, required: true, immutable: true },
  task: { type: Schema.Types.ObjectId, required: true, immutable: true },
  uploadedBy: { type: Schema.Types.ObjectId, required: true, immutable: true },
  name: { type: String, required: true, maxlength: 150, immutable: true },
  type: { type: String, enum: ["application/pdf", "image/jpeg", "image/png"], required: true, immutable: true },
  size: { type: Number, required: true, max: 5242880, min: 1, immutable: true },
  sha256: { type: String, required: true, immutable: true },
  storageProvider: { type: String, enum: ["mongodb", "r2"], default: "mongodb", immutable: true },
  storageBucket: { type: String, default: "", immutable: true, required: function(this: any) { return this.storageProvider === "r2"; } },
  storageKey: { type: String, default: "", immutable: true, required: function(this: any) { return this.storageProvider === "r2"; } },
  storageStatus: { type: String, enum: ["staged", "attached", "cleanup_pending", "deleted"], default: "attached" },
  bytes: { type: Buffer, required: function(this: any) { return this.storageProvider !== "r2"; }, select: false, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ company: 1, onboarding: 1, task: 1 });
schema.index({ storageProvider: 1, storageStatus: 1, createdAt: 1 });
export default mongoose.models.OnboardingDocument || mongoose.model("OnboardingDocument", schema);
