import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, default: null, immutable: true },
  purpose: { type: String, enum: ["request_attachment", "employee_document", "company_logo"], required: true, immutable: true },
  uploadedBy: { type: Schema.Types.ObjectId, required: true, immutable: true },
  name: { type: String, required: true, maxlength: 150, immutable: true },
  type: { type: String, enum: ["application/pdf", "image/jpeg", "image/png"], required: true, immutable: true },
  size: { type: Number, min: 1, max: 5242880, required: true, immutable: true },
  sha256: { type: String, match: /^[a-f0-9]{64}$/, required: true, immutable: true },
  storageProvider: { type: String, enum: ["mongodb", "r2"], required: true, immutable: true },
  storageBucket: { type: String, immutable: true },
  storageKey: { type: String, required: true, immutable: true },
  storageStatus: { type: String, enum: ["staged", "attached", "cleanup_pending", "deleted"], required: true },
  bytes: { type: Buffer, select: false, immutable: true, required: function(this: any) { return this.storageProvider === "mongodb" && this.storageStatus !== "deleted"; } },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ company: 1, employee: 1, purpose: 1 });
schema.index({ storageStatus: 1, createdAt: 1 });
export default mongoose.models.PrivateStoredFile || mongoose.model("PrivateStoredFile", schema);
