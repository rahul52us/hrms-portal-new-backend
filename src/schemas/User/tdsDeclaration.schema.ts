import mongoose, { Schema, Document } from "mongoose";

export interface ITdsDeclaration extends Document {
  user: mongoose.Types.ObjectId;
  financialYear: string;
  declarations: {
    section80C?: {
      lic?: number;
      ppf?: number;
      epf?: number;
      mutualFunds?: number;
      tuitionFee?: number;
      homeLoanPrincipal?: number;
      totalDeclared?: number;
    };
    section80D?: {
      medicalInsuranceSelf?: number;
      medicalInsuranceParents?: number;
      preventiveHealthCheckup?: number;
      totalDeclared?: number;
    };
    hra?: {
      rentPaid?: number;
      landlordPan?: string;
      landlordName?: string;
    };
    homeLoanInterest?: {
      lenderName?: string;
      lenderPan?: string;
      interestAmount?: number;
    };
    otherDeclarations?: mongoose.Schema.Types.Mixed;
  };
  proofDocuments: [
    {
      documentType: string;
      fileId: mongoose.Types.ObjectId;
      amountVerified?: number;
      status: "pending" | "approved" | "rejected";
      remarks?: string;
    }
  ];
  overallStatus: "pending" | "partially_verified" | "verified" | "rejected";
  submittedAt: Date;
  verifiedAt?: Date;
  verifiedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const TdsDeclarationSchema: Schema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    financialYear: {
      type: String,
      required: true,
      index: true, // e.g., "2025-2026"
    },
    declarations: {
      section80C: {
        lic: { type: Number, default: 0 },
        ppf: { type: Number, default: 0 },
        epf: { type: Number, default: 0 },
        mutualFunds: { type: Number, default: 0 },
        tuitionFee: { type: Number, default: 0 },
        homeLoanPrincipal: { type: Number, default: 0 },
        totalDeclared: { type: Number, default: 0 },
      },
      section80D: {
        medicalInsuranceSelf: { type: Number, default: 0 },
        medicalInsuranceParents: { type: Number, default: 0 },
        preventiveHealthCheckup: { type: Number, default: 0 },
        totalDeclared: { type: Number, default: 0 },
      },
      hra: {
        rentPaid: { type: Number, default: 0 },
        landlordPan: { type: String, uppercase: true },
        landlordName: { type: String },
      },
      homeLoanInterest: {
        lenderName: { type: String },
        lenderPan: { type: String, uppercase: true },
        interestAmount: { type: Number, default: 0 },
      },
      otherDeclarations: { type: mongoose.Schema.Types.Mixed },
    },
    proofDocuments: [
      {
        documentType: { type: String }, // e.g., "Rent Receipt", "LIC Premium"
        fileId: { type: mongoose.Schema.Types.ObjectId, ref: "Document" },
        amountVerified: { type: Number },
        status: {
          type: String,
          enum: ["pending", "approved", "rejected"],
          default: "pending",
        },
        remarks: { type: String },
      },
    ],
    overallStatus: {
      type: String,
      enum: ["pending", "partially_verified", "verified", "rejected"],
      default: "pending",
    },
    submittedAt: {
      type: Date,
      default: Date.now,
    },
    verifiedAt: {
      type: Date,
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

// Ensure one TDS declaration per user per financial year
TdsDeclarationSchema.index({ user: 1, financialYear: 1 }, { unique: true });

export default mongoose.model<ITdsDeclaration>(
  "TdsDeclaration",
  TdsDeclarationSchema
);
