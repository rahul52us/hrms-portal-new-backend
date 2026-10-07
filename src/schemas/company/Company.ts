import mongoose, { Document } from "mongoose";

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
  verified_email_allowed: boolean;
  createdBy: mongoose.Schema.Types.ObjectId;
  activeUser: mongoose.Schema.Types.ObjectId;
  is_active?: boolean;
  logo?: {
    name?: string;
    url?: string;
    type?: string;
  };
  registeredAddress?: {
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
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
  deletedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  primaryThemeColor?: string;
  sidebarColors?: any;
  departments?: string[];
  rolePermissions?: any;
  payrollSettings?: {
    attendanceCutoffDay?: number;
    currency?: string;
    currencyMinorUnits?: number;
    payFrequency?: "monthly";
    payDay?: number;
    roundingMode?: "nearest" | "floor" | "ceil";
    employeeCompensationVisibility?: "hidden" | "current" | "history";
  };
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
    required: true,
    trim: true,
    uppercase: true,
    immutable: true,
    unique: true,
    index: true,
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
  registeredAddress: {
    addressLine1: {
      type: String,
      trim: true,
      maxlength: 200,
    },
    addressLine2: {
      type: String,
      trim: true,
      maxlength: 200,
    },
    city: {
      type: String,
      trim: true,
      maxlength: 100,
    },
    state: {
      type: String,
      trim: true,
      maxlength: 100,
    },
    postalCode: {
      type: String,
      trim: true,
      maxlength: 20,
    },
    country: {
      type: String,
      trim: true,
      maxlength: 100,
    },
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
  primaryThemeColor: {
    type: String,
    trim: true,
    default: "#2563EB",
  },
  sidebarColors: { type: mongoose.Schema.Types.Mixed, default: {} },
  departments: { type: [{ type: String, trim: true }], default: [] },
  rolePermissions: { type: mongoose.Schema.Types.Mixed, default: {} },
  payrollSettings: {
    attendanceCutoffDay: {
      type: Number,
      min: 1,
      max: 31,
      default: 31,
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      match: /^[A-Z]{3}$/,
      default: "INR",
    },
    currencyMinorUnits: {
      type: Number,
      min: 0,
      max: 3,
      default: 2,
    },
    payFrequency: {
      type: String,
      enum: ["monthly"],
      default: "monthly",
    },
    payDay: {
      type: Number,
      min: 1,
      max: 31,
      default: 31,
    },
    roundingMode: {
      type: String,
      enum: ["nearest", "floor", "ceil"],
      default: "nearest",
    },
    employeeCompensationVisibility: {
      type: String,
      enum: ["hidden", "current", "history"],
      default: "hidden",
    },
  },
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
