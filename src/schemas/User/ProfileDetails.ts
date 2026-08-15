import mongoose, { Schema, Document } from "mongoose";

interface IFamilyContact {
  name: string;
  relationship?: string;
  address?: string;
  telephone?: string;
  mobile?: string;
  dateOfBirth?: Date;
  isResidingWithEmployee?: boolean;
  isPfNominee?: boolean;
  isMedicalInsuranceCovered?: boolean;
  comments?: string;
}

interface ISkill {
  coreDomainAreas?: string[];
  skills?: string[];
  totalYearsOfExperience?: number;
}

interface IEmployeeDocument {
  documentType: string; // e.g., "Aadhar", "PAN", "Passport", "Driving License", "Graduation Marksheet"
  issueDate?: Date;
  expiryDate?: Date;
  documentFileId?: mongoose.Types.ObjectId; // Link to actual file in document.schema.ts
  status?: string; // e.g., "pending", "approved", "rejected"
  createdBy?: mongoose.Types.ObjectId;
  approvedBy?: mongoose.Types.ObjectId;
  createdAt?: Date;
  approvedAt?: Date;
}

export interface ProfileDetailsI extends Document {
  user: mongoose.Schema.Types.ObjectId;
  personalDetails?: {
    firstName?: string;
    middleName?: string;
    lastName?: string;
    knownAs?: string;
    maritalStatus?: string;
    anniversaryDate?: Date;
    fatherHusbandName?: string;
  };
  employmentDetails?: {
    continuousServiceDate?: Date;
    additionalReportsTo?: mongoose.Schema.Types.ObjectId[];
    grade?: string;
    employmentType?: string;
    onContract?: boolean;
  };
  statutoryDetails?: {
    aadharNumber?: string;
    nameAsPerAadhar?: string;
    panNumber?: string;
    nameAsPerPan?: string;
    nationality?: string;
  };
  skills?: ISkill;
  familyContacts?: IFamilyContact[];
  employeeDocuments?: IEmployeeDocument[];
  personalInfo?: mongoose.Schema.Types.Mixed;
}

const FamilyContactSchema = new Schema<IFamilyContact>({
  name: { type: String, required: true },
  relationship: { type: String },
  address: { type: String },
  telephone: { type: String },
  mobile: { type: String },
  dateOfBirth: { type: Date },
  isResidingWithEmployee: { type: Boolean, default: false },
  isPfNominee: { type: Boolean, default: false },
  isMedicalInsuranceCovered: { type: Boolean, default: false },
  comments: { type: String },
}, { _id: true });

const SkillSchema = new Schema<ISkill>({
  coreDomainAreas: [{ type: String }],
  skills: [{ type: String }],
  totalYearsOfExperience: { type: Number },
}, { _id: false });

const EmployeeDocumentSchema = new Schema<IEmployeeDocument>({
  documentType: { type: String, required: true },
  issueDate: { type: Date },
  expiryDate: { type: Date },
  documentFileId: { type: Schema.Types.ObjectId, ref: "Document" },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
  approvedAt: { type: Date },
}, { _id: true });

const ProfileDetailsSchema = new mongoose.Schema<ProfileDetailsI>({
  user: {
    type: Schema.Types.ObjectId,
    required: true,
    unique: true,
    ref: "User",
  },
  personalDetails: {
    firstName: { type: String },
    middleName: { type: String },
    lastName: { type: String },
    knownAs: { type: String },
    maritalStatus: { type: String, lowercase: true, enum: ['single', 'married', 'divorced', 'widowed', 'other'] },
    anniversaryDate: { type: Date },
    fatherHusbandName: { type: String },
  },
  employmentDetails: {
    continuousServiceDate: { type: Date },
    additionalReportsTo: [{ type: Schema.Types.ObjectId, ref: "User" }],
    grade: { type: String },
    employmentType: { type: String },
    onContract: { type: Boolean, default: false },
  },
  statutoryDetails: {
    aadharNumber: { type: String },
    nameAsPerAadhar: { type: String },
    panNumber: { type: String, uppercase: true },
    nameAsPerPan: { type: String },
    nationality: { type: String, lowercase: true, default: "indian" },
  },
  skills: { type: SkillSchema },
  familyContacts: [FamilyContactSchema],
  employeeDocuments: [EmployeeDocumentSchema],
  personalInfo: {
    type: mongoose.Schema.Types.Mixed
  }
});

export default mongoose.model<ProfileDetailsI>(
  "ProfileDetails",
  ProfileDetailsSchema
);
