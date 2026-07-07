import mongoose, { Document } from "mongoose";

interface addressInfo {
  address?: string;
  country?: string;
  state?: string;
  city?: string;
  pinCode?: string;
  formattedAddress?: string;
  placeId?: string;
  lat?: number;
  lng?: number;
}

interface CompanyI extends Document {
  type?: string;
  company_name: string;
  companyCode: string;
  companyOrg: mongoose.Schema.Types.ObjectId,
  companyType: string;
  userId?: mongoose.Schema.Types.ObjectId;
  tenantSlug: string;
  tenantUrl: string;
  customDomain?: string;
  companyEmail?: string;
  managerLevels?: number;
  verified_email_allowed: boolean;
  createdBy: mongoose.Schema.Types.ObjectId;
  activeUser: mongoose.Schema.Types.ObjectId;
  is_active?: boolean;
  logo?: {
    name?: string;
    url?: string;
    type?: string;
  };
  bio?: string;
  mobileNo?: string;
  workNo?: string;
  facebookLink?: string;
  instagramLink?: string;
  linkedInLink?: string;
  twitterLink?: string;
  githubLink?: string;
  telegramLink?: string;
  otherLinks?: string[];
  webLink?: string;
  address1?: string;
  address2?: string;
  pinCode?: string;
  country?: string;
  state?: string;
  city?: string;
  deletedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  addressInfo?: addressInfo[];
  primaryThemeColor?: string;
  sidebarColors?: any;
  departments?: string[];
  rolePermissions?: any;
  lastActiveAt?: Date;
}

const companySchema = new mongoose.Schema<CompanyI>({
  type: {
    type: String,
    default: "company",
    index: true,
    trim: true,
  },
  company_name: {
    type: String,
    unique: true,
    index: true,
    trim: true,
  },
  companyOrg: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
  },
  companyCode: {
    type: String,
    required: true
  },
  companyType: {
    type: String,
    default: 'company'
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    sparse: true,
  },
  tenantSlug: {
    type: String,
    unique: true,
    index: true,
    trim: true,
  },
  tenantUrl: {
    type: String,
    trim: true,
  },
  customDomain: {
    type: String,
    trim: true,
  },
  companyEmail: {
    type: String,
    trim: true,
  },
  managerLevels: {
    type: Number,
    default: 3,
    min: 1,
  },
  is_active: {
    type: Boolean,
    default: false
  },
  verified_email_allowed: {
    type: Boolean,
    default: false,
  },
  logo: {
    name: {
      type: String
    },
    url: {
      type: String
    },
    type: {
      type: String
    }
  },
  bio: {
    type: String,
  },
  mobileNo: {
    type: String,
  },
  workNo: {
    type: String,
  },
  facebookLink: {
    type: String,
  },
  instagramLink: {
    type: String,
  },
  twitterLink: {
    type: String,
  },
  githubLink: {
    type: String,
  },
  telegramLink: {
    type: String,
  },
  linkedInLink: {
    type: String,
  },
  otherLinks: {
    type: [{ type: String }],
  },
  addressInfo: {
    type: [{
      address: String,
      country: String,
      state: String,
      city: String,
      pinCode: String,
      formattedAddress: String,
      placeId: String,
      lat: Number,
      lng: Number
    }]
  },
  primaryThemeColor: {
    type: String,
    trim: true,
    default: "#2563EB",
  },
  sidebarColors: { type: mongoose.Schema.Types.Mixed, default: {} },
  departments: { type: [{ type: String, trim: true }], default: [] },
  rolePermissions: { type: mongoose.Schema.Types.Mixed, default: {} },
  lastActiveAt: {
    type: Date,
  },
  activeUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
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

companySchema.index(
  { type: 1, userId: 1, companyOrg: 1 },
  {
    unique: true,
    partialFilterExpression: {
      type: "user",
      userId: { $exists: true },
      companyOrg: { $exists: true },
    },
  }
);

export default mongoose.model<CompanyI>("Company", companySchema);
