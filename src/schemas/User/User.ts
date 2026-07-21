import mongoose, { Schema, Document } from "mongoose";

export interface UserInterface extends Document {
  title: String;
  name: string;
  mobileNumber:string;
  email?: string;
  username: string;
  code: string;
  profileId?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  formattedAddress?: string;
  placeId?: string;
  location?: {
    lat?: number;
    lng?: number;
  };
  pic: any;
  bio?: string;
  designation?: string;
  joiningDate?: Date;
  dateOfBirth?: Date;
  gender?: number;
  company: Schema.Types.ObjectId;
  createdBy?: Schema.Types.ObjectId;
  assignedManagers?: Schema.Types.ObjectId[];
  managers?: {
    level: number;
    managerId?: Schema.Types.ObjectId;
    managerEmail: string;
    status: "ASSIGNED" | "PENDING";
  }[];
  profile_details: Schema.Types.ObjectId;
  is_active: boolean;
  is_enabled?: boolean;
  role: string;
  userType:string;
  password: string;
  setupToken?: string;
  setupTokenExpiry?: Date;
  deletedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  permissions?:any;
  refrenceBy?:any;
  defaultWorkflow?: mongoose.Types.ObjectId;
  department?: string;
  team?: string;
  officeLocation?: Schema.Types.ObjectId;
}

const UserSchema: Schema<UserInterface> = new Schema<UserInterface>({
  title : {
    type : String
  },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true, index: true },
  username: { type: String },
  mobileNumber:{type : String, index : true},
  code : {type : String, index : true, unique : true, required:true},
  profileId: {
    type: String,
    trim: true,
    uppercase: true,
    unique: true,
    sparse: true,
    index: true,
  },
  city: { type: String, trim: true },
  state: { type: String, trim: true },
  address: { type: String, trim: true },
  country: { type: String, trim: true },
  postalCode: { type: String, trim: true },
  formattedAddress: { type: String, trim: true },
  placeId: { type: String, trim: true },
  location: {
    lat: { type: Number },
    lng: { type: Number },
  },
  designation: { type: String, trim: true },
  joiningDate: { type: Date },
  dateOfBirth: { type: Date },
  gender: { type: Number, enum: [1, 2, 3, 4] },
  company : {type : Schema.Types.ObjectId, ref:'Company'},
  createdBy: { type: Schema.Types.ObjectId, ref: "User", index: true },
  assignedManagers: {
    type: [{ type: Schema.Types.ObjectId, ref: "User" }],
    default: [],
    index: true,
  },
  managers: {
    type: [{
      level: { type: Number, required: true },
      managerId: { type: Schema.Types.ObjectId, ref: "User" },
      managerEmail: { type: String, required: true, trim: true, lowercase: true },
      status: { type: String, enum: ["ASSIGNED", "PENDING"], default: "PENDING" },
    }],
    default: [],
  },
  userType:{type: String, required: true, index: true, trim: true},
  pic: {
    name: {
      type: String
    },
    url: {
      type: String,
    },
    type: {
      type: String,
    },
  },
  bio: { type: String, trim: true },
  profile_details: { type: Schema.Types.ObjectId, ref: "ProfileDetails" },
  is_active: { type: Boolean, default: false },
  is_enabled: { type: Boolean, default: true },
  role: {
    type: String,
    default: "user"
  },
  department: { type: String, trim: true },
  team: { type: String, trim: true },
  officeLocation: {
    type: Schema.Types.ObjectId,
    ref: "OfficeLocation",
    index: true,
  },
  permissions : {
    type : mongoose.Schema.Types.Mixed,
    default : {}
  },
  password: { type: String, trim: true },
  setupToken: { type: String, index: true },
  setupTokenExpiry: { type: Date },
  refrenceBy:{
    type : mongoose.Schema.Types.ObjectId
  },
  defaultWorkflow: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workflow',
    default: null,
  },
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

const UserModel = mongoose.model<UserInterface>("User", UserSchema);
export default UserModel;
