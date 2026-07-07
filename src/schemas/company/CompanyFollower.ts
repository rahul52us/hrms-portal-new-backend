import mongoose, { Schema } from "mongoose";

const companyFollowSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
  },
  follower: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  following: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
});

export default  mongoose.model("CompanyFollow", companyFollowSchema);