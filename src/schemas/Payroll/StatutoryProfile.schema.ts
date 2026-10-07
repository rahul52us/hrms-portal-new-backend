import mongoose, { Document, Schema } from "mongoose";

export interface StatutoryProfileI extends Document {
  company: mongoose.Types.ObjectId;
  name: string;
  code: string;
  description?: string;
  countryCode: string;
  providerKey: string;
  latestVersionNumber: number;
  latestPublishedVersion?: mongoose.Types.ObjectId | null;
  revision: number;
  createdBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const StatutoryProfileSchema = new Schema<StatutoryProfileI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, unique: true, index: true, immutable: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    code: { type: String, required: true, trim: true, uppercase: true, match: /^[A-Z][A-Z0-9_]{1,29}$/, immutable: true },
    description: { type: String, trim: true, maxlength: 500 },
    countryCode: { type: String, required: true, trim: true, uppercase: true, match: /^[A-Z]{2}$/, immutable: true, index: true },
    providerKey: { type: String, required: true, trim: true, lowercase: true, immutable: true, index: true },
    latestVersionNumber: { type: Number, required: true, min: 1, default: 1 },
    latestPublishedVersion: { type: Schema.Types.ObjectId, ref: "StatutoryProfileVersion", default: null },
    revision: { type: Number, required: true, min: 1, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

StatutoryProfileSchema.index({ company: 1, code: 1 }, { unique: true });

const StatutoryProfile =
  (mongoose.models.StatutoryProfile as mongoose.Model<StatutoryProfileI>) ||
  mongoose.model<StatutoryProfileI>("StatutoryProfile", StatutoryProfileSchema);

export default StatutoryProfile;
