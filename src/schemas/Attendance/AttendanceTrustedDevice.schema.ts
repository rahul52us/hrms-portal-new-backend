import mongoose, { Document, Schema } from "mongoose";

export const ATTENDANCE_TRUSTED_DEVICE_STATUSES = ["pending", "trusted", "revoked"] as const;

export interface AttendanceTrustedDeviceI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  deviceHash: string;
  deviceIdSuffix: string;
  deviceName: string;
  platform: string;
  userAgent: string;
  status: (typeof ATTENDANCE_TRUSTED_DEVICE_STATUSES)[number];
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSeenIp?: string;
  trustedAt?: Date | null;
  trustedBy?: mongoose.Types.ObjectId | null;
  revokedAt?: Date | null;
  revokedBy?: mongoose.Types.ObjectId | null;
  decisions: Array<{
    status: "trusted" | "revoked";
    actor: mongoose.Types.ObjectId;
    reason: string;
    decidedAt: Date;
  }>;
  createdAt?: Date;
  updatedAt?: Date;
}

const AttendanceTrustedDeviceSchema = new Schema<AttendanceTrustedDeviceI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    deviceHash: { type: String, required: true, select: false },
    deviceIdSuffix: { type: String, required: true, trim: true },
    deviceName: { type: String, trim: true, maxlength: 120, default: "Browser" },
    platform: { type: String, trim: true, maxlength: 120, default: "" },
    userAgent: { type: String, trim: true, maxlength: 500, default: "" },
    status: { type: String, enum: ATTENDANCE_TRUSTED_DEVICE_STATUSES, default: "pending", index: true },
    firstSeenAt: { type: Date, required: true, default: Date.now },
    lastSeenAt: { type: Date, required: true, default: Date.now },
    lastSeenIp: { type: String, trim: true, default: "" },
    trustedAt: { type: Date, default: null },
    trustedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decisions: {
      type: [{
        status: { type: String, enum: ["trusted", "revoked"], required: true },
        actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
        reason: { type: String, trim: true, minlength: 3, maxlength: 500, required: true },
        decidedAt: { type: Date, required: true },
      }],
      default: [],
    },
  },
  { timestamps: true }
);

AttendanceTrustedDeviceSchema.index(
  { company: 1, employee: 1, deviceHash: 1 },
  { unique: true }
);
AttendanceTrustedDeviceSchema.index({ company: 1, status: 1, lastSeenAt: -1 });

const AttendanceTrustedDevice =
  (mongoose.models.AttendanceTrustedDevice as mongoose.Model<AttendanceTrustedDeviceI>) ||
  mongoose.model<AttendanceTrustedDeviceI>("AttendanceTrustedDevice", AttendanceTrustedDeviceSchema);

export default AttendanceTrustedDevice;
