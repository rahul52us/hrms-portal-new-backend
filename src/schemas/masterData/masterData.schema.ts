import mongoose, { Document, Schema } from "mongoose";

const MasterDataSchema = new Schema<any>({
  masters : {
    type : mongoose.Schema.Types.Mixed
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  deletedAt : {
    type : Date
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
});

const MasterData = mongoose.model<any>("MasterData", MasterDataSchema);
export default MasterData;