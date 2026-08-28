import mongoose, { Schema, Document } from "mongoose";
import Company from "../company/Company";
import { buildEmployeeIdentifier } from "../../services/employeeCode/employeeCode.utils";

export interface UserPicture {
  name?: string;
  url?: string;
  type?: string;
}

export interface UserInterface extends Document {
  name: string;
  mobileNumber:string;
  username: string;
  code: string;
  employeeNumber?: string;
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
  pic?: UserPicture | null;
  bio?: string;
  designation?: string;
  joiningDate?: Date;
  confirmationDate?: Date;
  employmentEndDate?: Date;
  dateOfBirth?: Date;
  gender?: number;
  company: Schema.Types.ObjectId;
  createdBy?: Schema.Types.ObjectId;
  reportingManager?: Schema.Types.ObjectId;
  profile_details: Schema.Types.ObjectId;
  is_enabled: boolean;
  role: string;
  password?: string;
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
  hrScope?: {
    departments?: string[];
    teams?: string[];
    officeLocations?: Schema.Types.ObjectId[];
  };
}

const UserPictureSchema = new Schema<UserPicture>(
  {
    name: { type: String, trim: true },
    url: { type: String, trim: true },
    type: { type: String, trim: true },
  },
  { _id: false }
);

const UserSchema: Schema<UserInterface> = new Schema<UserInterface>({
  name: { type: String, trim: true },
  username: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  },
  mobileNumber:{type : String, index : true},
  code: {
    type: String,
    trim: true,
    uppercase: true,
    index: true,
    unique: true,
    required: true,
  },
  employeeNumber: {
    type: String,
    trim: true,
    uppercase: true,
  },
  city: { type: String, trim: true, lowercase: true },
  state: { type: String, trim: true, lowercase: true },
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
  confirmationDate: { type: Date },
  employmentEndDate: { type: Date },
  dateOfBirth: { type: Date },
  gender: { type: Number, enum: [1, 2, 3, 4] },
  company : {type : Schema.Types.ObjectId, ref:'Company'},
  createdBy: { type: Schema.Types.ObjectId, ref: "User", index: true },
  reportingManager: {
    type: Schema.Types.ObjectId,
    ref: "User",
    index: true,
  },
  pic: { type: UserPictureSchema, default: null },
  bio: { type: String, trim: true },
  profile_details: { type: Schema.Types.ObjectId, ref: "ProfileDetails" },
  is_enabled: { type: Boolean, default: true, required: true },
  role: {
    type: String,
    default: "user",
    required: true,
    trim: true,
    lowercase: true,
    index: true,
  },
  department: { type: String, trim: true, ref: "Department" },
  team: { type: String, trim: true },
  hrScope: {
    departments: {
      type: [{ type: String, trim: true }],
      default: [],
    },
    teams: {
      type: [{ type: String, trim: true }],
      default: [],
    },
    officeLocations: {
      type: [{ type: Schema.Types.ObjectId, ref: "OfficeLocation" }],
      default: [],
    },
  },
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

UserSchema.pre("validate", async function enforceCompanyEmployeeIdentifier() {
  if (!this.company || String(this.role).toLowerCase() === "superadmin") {
    return;
  }

  const companyId = (this.company as any)?._id || this.company;
  const company = await Company.findById(companyId).select("companyCode").lean();
  if (!company) {
    throw new Error("A valid company is required for an employee identifier");
  }

  const identifier = buildEmployeeIdentifier(
    company.companyCode,
    this.employeeNumber || this.code
  );
  if (!identifier) {
    throw new Error("A valid employee number is required for company users");
  }

  this.employeeNumber = identifier.employeeNumber;
  this.code = identifier.code;
});

UserSchema.index({ company: 1, reportingManager: 1, deletedAt: 1 });
UserSchema.index({ company: 1, name: 1, _id: 1 });
UserSchema.index(
  { username: 1 },
  {
    name: "username_active_unique",
    unique: true,
    partialFilterExpression: { deletedAt: null },
  }
);
UserSchema.index(
  { company: 1, employeeNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      company: { $type: "objectId" },
      employeeNumber: { $type: "string" },
    },
  }
);

const UserModel = mongoose.model<UserInterface>("User", UserSchema);
export default UserModel;
