import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, default: null, immutable: true },
  uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  purpose: { type: String, enum: ["onboarding", "employee_document", "request_attachment", "company_logo", "profile_photo", "asset_document"], required: true, immutable: true },
  outcome: { type: String, enum: ["blocked", "unavailable"], required: true, immutable: true },
  provider: { type: String, enum: ["clamav", "misconfigured"], required: true, immutable: true },
  sha256: { type: String, match: /^[a-f0-9]{64}$/, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ company: 1, createdAt: -1, _id: -1 });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  schema.pre(operation as any, function(next) { next(new Error("Upload security events are append-only")); });
}
export default mongoose.models.UploadSecurityEvent || mongoose.model("UploadSecurityEvent", schema);
