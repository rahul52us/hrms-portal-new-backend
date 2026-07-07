import mongoose, { Schema, Document } from "mongoose";

interface FamilyDetailsI extends Document {
  user: mongoose.Schema.Types.ObjectId;
  relations:mongoose.Schema.Types.Mixed;
  deletedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const FamilyDetails = new mongoose.Schema<FamilyDetailsI>({
  user: {
    type: Schema.Types.ObjectId,
    required: true,
    unique: true,
    ref: "User",
  },
  relations:[{
    type : mongoose.Schema.Types.Mixed
  }],
  deletedAt: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
  updatedAt: {
    type: Date,
  },
});

export default mongoose.model<FamilyDetailsI>(
  "FamilyDetails",
  FamilyDetails
);