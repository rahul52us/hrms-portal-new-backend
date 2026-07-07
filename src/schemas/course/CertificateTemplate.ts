import mongoose, { Document, Schema } from "mongoose";

export type CertificateTemplateStatus = "draft" | "active" | "archived";

export interface ICertificateTemplate extends Document {
  name: string;
  companyId?: mongoose.Types.ObjectId | null;
  html: string;
  placeholders: string[];
  backgroundAssetUrl?: string;
  status: CertificateTemplateStatus;
  version: number;
  createdBy?: mongoose.Types.ObjectId | null;
  updatedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const CertificateTemplateSchema = new Schema<ICertificateTemplate>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },
    html: {
      type: String,
      required: true,
    },
    placeholders: {
      type: [String],
      default: ["student_name", "course_name", "issued_on"],
    },
    backgroundAssetUrl: {
      type: String,
      default: "",
      trim: true,
    },
    status: {
      type: String,
      enum: ["draft", "active", "archived"],
      default: "active",
      index: true,
    },
    version: {
      type: Number,
      default: 1,
      min: 1,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

CertificateTemplateSchema.index({ companyId: 1, status: 1, createdAt: -1 });
CertificateTemplateSchema.index({ name: 1, companyId: 1 });

export default mongoose.model<ICertificateTemplate>("CertificateTemplate", CertificateTemplateSchema);
