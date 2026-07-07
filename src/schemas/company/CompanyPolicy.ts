import mongoose, { Document } from "mongoose";

interface WorkTiming {
  startTime: string;
  endTime: string;
  daysOfWeek: string[]; // ["Monday", "Tuesday", "Wednesday", ...]
}

interface WorkLocation {
  ipAddress: string;
  locationName: string;
}

interface CompanyPolicyI extends Document {
  title : string;
  company: mongoose.Schema.Types.ObjectId;
  createdBy: mongoose.Schema.Types.ObjectId;
  officeStartTime: string;
  officeEndTime: string;
  gracePeriodMinutesLate: number;
  gracePeriodMinutesEarly: number;
  workLocations: WorkLocation[];
  workTiming: WorkTiming[];
  holidays: mongoose.Schema.Types.Mixed;
  ipAddressRange: mongoose.Schema.Types.Mixed;
  is_active?: boolean;
  deletedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const workLocationSchema = new mongoose.Schema<WorkLocation>({
  ipAddress: {
    type: String,
    required: true
  },
  locationName: {
    type: String,
    required: true
  }
});

const workTimingSchema = new mongoose.Schema<WorkTiming>({
  startTime: {
    type: String,
    required: true
  },
  endTime: {
    type: String,
    required: true
  },
  daysOfWeek: {
    type: [String],
    required: true,
    enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
  }
});

const companyPolicySchema = new mongoose.Schema<CompanyPolicyI>({
  title : {
    type : String
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  officeStartTime: {
    type: String
  },
  officeEndTime: {
    type: String
  },
  gracePeriodMinutesLate: {
    type: Number,
    required: true,
    default: 0
  },
  gracePeriodMinutesEarly: {
    type: Number,
    required: true,
    default: 0
  },
  workLocations: {
    type: [workLocationSchema],
    default: []
  },
  workTiming: {
    type: [workTimingSchema],
    default: []
  },
  holidays: {
    type: mongoose.Schema.Types.Mixed,
    default: []
  },
  ipAddressRange: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  is_active: {
    type: Boolean,
    default: true
  },
  deletedAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date
  }
});

export default mongoose.model<CompanyPolicyI>("CompanyPolicy", companyPolicySchema);
