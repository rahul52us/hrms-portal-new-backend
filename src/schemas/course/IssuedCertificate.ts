import mongoose, { Document, Schema } from "mongoose";

export type IssuedCertificateStatus = "issued" | "revoked" | "regenerated";

export interface IIssuedCertificate extends Document {
  certificateNo: string;
  userId: mongoose.Types.ObjectId;
  courseId: mongoose.Types.ObjectId;
  companyId?: mongoose.Types.ObjectId | null;
  templateId: mongoose.Types.ObjectId;
  templateVersion: number;
  issuedAt: Date;
  status: IssuedCertificateStatus;
  renderedPdfUrl?: string;
  renderedPdfPath?: string;
  renderedHtmlSnapshot?: string;
  metadata: {
    learnerName?: string;
    learnerEmail?: string;
    courseName?: string;
    score?: number | null;
    completionDate?: Date | null;
    issuedOnLabel?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const IssuedCertificateSchema = new Schema<IIssuedCertificate>(
  {
    certificateNo: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      uppercase: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    courseId: {
      type: Schema.Types.ObjectId,
      ref: "Course",
      required: true,
      index: true,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },
    templateId: {
      type: Schema.Types.ObjectId,
      ref: "CertificateTemplate",
      required: true,
    },
    templateVersion: {
      type: Number,
      default: 1,
      min: 1,
    },
    issuedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    status: {
      type: String,
      enum: ["issued", "revoked", "regenerated"],
      default: "issued",
      index: true,
    },
    renderedPdfUrl: {
      type: String,
      default: "",
      trim: true,
    },
    renderedPdfPath: {
      type: String,
      default: "",
      trim: true,
    },
    renderedHtmlSnapshot: {
      type: String,
      default: "",
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

IssuedCertificateSchema.index(
  { userId: 1, courseId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "issued" },
  }
);
IssuedCertificateSchema.index({ companyId: 1, issuedAt: -1 });

export default mongoose.model<IIssuedCertificate>("IssuedCertificate", IssuedCertificateSchema);
