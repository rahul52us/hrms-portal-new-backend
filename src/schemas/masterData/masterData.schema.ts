import mongoose, { Document, Schema } from "mongoose";

const MasterDataSchema = new Schema<any>({
  documentTypes: [{ type: String }],
  employmentTypes: [{ type: String }],
  tdsSections: [{ type: String }],
  coreDomains: [{ type: String }],
  skills: [{ type: String }],
  domainSkills: [{
    domain: { type: String, required: true },
    skills: [{ type: String }]
  }],
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