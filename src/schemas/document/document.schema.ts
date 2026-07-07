import mongoose, { Schema, Document } from "mongoose";

export interface IDocument extends Document {
  documentId?: string;
  createdBy?: mongoose.Types.ObjectId;
  currentLevel?: number;
  status?: "pending" | "approved" | "rejected" | "completed";
  created_At?: Date;
  updated_At?: Date;
  deleted_At?: Date;
  file?: mongoose.Types.ObjectId;
  values?: Object;
  document?: string;
  approval?: IApproval[];
  user?: string;
  tags?: any;
  additionalFiles?: any;
}
export interface IApproval extends Document {
  comment?: string;
  status?: string;
  action?: "approved" | "rejected";
  level: number;
  name?: string;
  user?: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId;
  date?: Date;
  createdAt?: Date;
}
const ApprovalSchema: Schema = new mongoose.Schema({
  comment: {
    type: String,
    default: "",
  },
  /* values: {
      type: mongoose.Schema.Types.Mixed,
    }, */
  type: {
    type: String,
    default: "",
  },
  status: {
    type: String,
    // default: "approved", // Default status is approved, change as needed
  },
  action: {
    type: String,
    enum: ["approved", "rejected"],
  },
  name: {
    type: String,
  },
  level: {
    type: Number,
    required: true,
  },
  fileId: {
    type: mongoose.Types.ObjectId,
    ref: "fs.files",
  },
  user: {
    type: mongoose.Types.ObjectId,
    ref: "User",
  },
  userId: {
    type: mongoose.Types.ObjectId,
    ref: "User",
  },
  date: {
    type: Date,
    default: Date.now,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
  },
});

export const DocumentSchema: Schema = new mongoose.Schema({
  documentId: {
    type: String,
    default: () => `DI-${Date.now().toString()}`,
  },
  workflow: {
    type: mongoose.Schema.Types.ObjectId,
    default: "WorkFlow",
  },
  partnerName : {
    type : String,
    default : ""
  },
  partnerId : {
    type : String,
    default : ""
  },
  order_taken_by:{
    type : String,
    default : ""
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organisation",
  },
  documentType: {
    type: String,
    default: "field",
  },
  deliveryDate: {
    type: String,
  },
  approval_on: {
    type: Date,
  },
  modified_on: {
    type: String,
  },
  createdBy: {
    type: mongoose.Types.ObjectId,
    ref: "User",
  },
  created_At: {
    type: Date,
    default: Date.now,
  },
  updated_At: {
    type: Date,
  },
  deleted_At: {
    type: Date,
  },
  file: {
    type: mongoose.Types.ObjectId,
    ref: "GridFSFile",
  },
  additionalFiles: { type: mongoose.Schema.Types.Mixed },
  values: {
    type: mongoose.Schema.Types.Mixed,
  },
  document: {
    type: String,
  },
  originalValues: {
    type: mongoose.Schema.Types.Mixed,
  },
  approval: [ApprovalSchema],
  currentLevel: {
    type: Number,
    default: 1,
    min: 1,
  },
  user: {
    type: mongoose.Types.ObjectId,
    required: [true, "User is not logged in"],
    ref: "User",
  },
  tags: {
    extraction: mongoose.Schema.Types.Mixed,
  },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected", "completed"],
    default: "pending",
  },
  helpInfo: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
});

DocumentSchema.index({ workflow: 1, currentLevel: 1, status: 1, company: 1 });
DocumentSchema.index({ workflow: 1, createdBy: 1, created_At: -1 });
DocumentSchema.index({ "approval.user": 1, "approval.action": 1, created_At: -1 });
DocumentSchema.index({ workflow: 1 });
DocumentSchema.index({ status: 1 });
DocumentSchema.index({ currentLevel: 1 });
DocumentSchema.index({ "approval.user": 1 });

const GridFSFileSchema = new mongoose.Schema(
  {
    filename: String,
    metadata: mongoose.Schema.Types.Mixed,
  },
  { collection: "fs.files", strict: false }
);

export const GridFSFile = mongoose.models.GridFSFile || mongoose.model("GridFSFile", GridFSFileSchema);

export const DocumentModel = mongoose.models.WorkflowDocument || mongoose.model("WorkflowDocument", DocumentSchema);
// export default mongoose.model<IDocument>("WorkflowDocument", DocumentSchema);
