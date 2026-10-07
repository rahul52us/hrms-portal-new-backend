import mongoose, { Document, Schema } from "mongoose";

export const STATUTORY_PROFILE_VERSION_STATUSES = ["draft", "published", "cancelled"] as const;

export interface StatutoryProfileVersionI extends Document {
  company: mongoose.Types.ObjectId;
  statutoryProfile: mongoose.Types.ObjectId;
  versionNumber: number;
  status: (typeof STATUTORY_PROFILE_VERSION_STATUSES)[number];
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  countryCode: string;
  providerKey: string;
  providerImplementationVersion: string;
  enabledModules: string[];
  configuration: Record<string, string>;
  revision: number;
  changeReason?: string;
  createdBy: mongoose.Types.ObjectId;
  publishedAt?: Date | null;
  publishedBy?: mongoose.Types.ObjectId | null;
  cancelledAt?: Date | null;
  cancelledBy?: mongoose.Types.ObjectId | null;
  cancelReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const StatutoryProfileVersionSchema = new Schema<StatutoryProfileVersionI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    statutoryProfile: { type: Schema.Types.ObjectId, ref: "StatutoryProfile", required: true, index: true, immutable: true },
    versionNumber: { type: Number, required: true, min: 1, immutable: true },
    status: { type: String, enum: STATUTORY_PROFILE_VERSION_STATUSES, required: true, default: "draft", index: true },
    effectiveFrom: { type: Date, default: null, index: true },
    effectiveTo: { type: Date, default: null, index: true },
    countryCode: { type: String, required: true, trim: true, uppercase: true, match: /^[A-Z]{2}$/, immutable: true },
    providerKey: { type: String, required: true, trim: true, lowercase: true, immutable: true },
    providerImplementationVersion: { type: String, required: true, trim: true },
    enabledModules: { type: [{ type: String, trim: true }], required: true, default: [] },
    configuration: { type: Schema.Types.Mixed, required: true, default: {} },
    revision: { type: Number, required: true, min: 1, default: 1 },
    changeReason: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancelReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

StatutoryProfileVersionSchema.index({ company: 1, statutoryProfile: 1, versionNumber: 1 }, { unique: true });
StatutoryProfileVersionSchema.index(
  { company: 1, statutoryProfile: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "draft" } }
);
StatutoryProfileVersionSchema.index(
  { company: 1, statutoryProfile: 1, effectiveFrom: 1 },
  { unique: true, partialFilterExpression: { status: "published" } }
);

const StatutoryProfileVersion =
  (mongoose.models.StatutoryProfileVersion as mongoose.Model<StatutoryProfileVersionI>) ||
  mongoose.model<StatutoryProfileVersionI>("StatutoryProfileVersion", StatutoryProfileVersionSchema);

export default StatutoryProfileVersion;
