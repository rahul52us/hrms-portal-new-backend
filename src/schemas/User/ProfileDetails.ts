import mongoose, { Schema, Document } from "mongoose";


interface addressInfo  {
  address?:string;
  country?:string;
  state?:string;
  city?:string;
  pinCode?:string
}

interface ProfileDetailsI extends Document {
  user: mongoose.Schema.Types.ObjectId;
  personalInfo?:mongoose.Schema.Types.Mixed
}

const ProfileDetailsSchema = new mongoose.Schema<ProfileDetailsI>({
  user: {
    type: Schema.Types.ObjectId,
    required: true,
    unique: true,
    ref: "User",
  },
  personalInfo : {
    type : mongoose.Schema.Types.Mixed
  }
});

export default mongoose.model<ProfileDetailsI>(
  "ProfileDetails",
  ProfileDetailsSchema
);
