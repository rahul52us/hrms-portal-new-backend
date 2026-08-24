import mongoose, { Document, Schema } from "mongoose";

export interface LeaveAttachmentI extends Document {
  company: mongoose.Types.ObjectId;
  uploadedBy: mongoose.Types.ObjectId;
  name: string;
  url: string;
  type: string;
  size: number;
  linkedRequest?: mongoose.Types.ObjectId | null;
  createdAt?: Date;
}

const LeaveAttachmentSchema = new Schema<LeaveAttachmentI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true },
    size: { type: Number, min: 1, required: true },
    linkedRequest: { type: Schema.Types.ObjectId, ref: "LeaveRequest", default: null, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

LeaveAttachmentSchema.index({ company: 1, uploadedBy: 1, createdAt: -1 });

const LeaveAttachment =
  (mongoose.models.LeaveAttachment as mongoose.Model<LeaveAttachmentI>) ||
  mongoose.model<LeaveAttachmentI>("LeaveAttachment", LeaveAttachmentSchema);

export default LeaveAttachment;
