import mongoose, { Document, Schema } from "mongoose";

export interface IBatch extends Document {
  name: string;
  companyId: mongoose.Types.ObjectId;
  courseIds: mongoose.Types.ObjectId[];
  userIds: mongoose.Types.ObjectId[];
  startDate: Date;
  endDate?: Date | null;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const BatchSchema = new Schema<IBatch>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    courseIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Course" }],
      default: [],
    },
    userIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    startDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    endDate: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

BatchSchema.index({ companyId: 1, createdAt: -1 });
BatchSchema.index({ createdBy: 1, createdAt: -1 });

export default mongoose.model<IBatch>("Batch", BatchSchema);
