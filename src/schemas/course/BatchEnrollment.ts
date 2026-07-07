import mongoose, { Document, Schema } from "mongoose";

export type BatchEnrollmentStatus = "active" | "completed" | "expired";

export interface IBatchEnrollment extends Document {
  batchId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  assignedBy: mongoose.Types.ObjectId;
  status: BatchEnrollmentStatus;
  createdAt: Date;
  updatedAt: Date;
}

const BatchEnrollmentSchema = new Schema<IBatchEnrollment>(
  {
    batchId: {
      type: Schema.Types.ObjectId,
      ref: "Batch",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "completed", "expired"],
      default: "active",
    },
  },
  { timestamps: true }
);

BatchEnrollmentSchema.index({ batchId: 1, userId: 1 }, { unique: true });
BatchEnrollmentSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model<IBatchEnrollment>("BatchEnrollment", BatchEnrollmentSchema);
