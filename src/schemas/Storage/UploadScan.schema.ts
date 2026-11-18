import { Schema } from "mongoose";

// An absent receipt is legacy/unknown, never evidence that a file passed a scanner.
export const UploadScanSchema = new Schema({
  status: { type: String, enum: ["clean", "not_scanned"], required: true, immutable: true },
  provider: { type: String, enum: ["clamav", "disabled"], required: true, immutable: true },
  sha256: { type: String, match: /^[a-f0-9]{64}$/, required: true, immutable: true },
  scannedAt: { type: Date, default: null, immutable: true, required: function(this: any) { return this.status === "clean"; } },
}, { _id: false });
