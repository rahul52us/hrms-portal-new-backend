import mongoose, { Document, Schema } from "mongoose";

export interface HolidayEntry {
  date: Date;
  name: string;
  type: "mandatory" | "optional";
  isHalfDay: boolean;
  description?: string;
}

export interface HolidayCalendarVersionI extends Document {
  company: mongoose.Types.ObjectId;
  calendar: mongoose.Types.ObjectId;
  versionNumber: number;
  status: "draft" | "published" | "cancelled";
  effectiveFrom?: Date | null;
  timezone: string;
  holidays: HolidayEntry[];
  changeReason?: string;
  createdBy: mongoose.Types.ObjectId;
  publishedAt?: Date | null;
  publishedBy?: mongoose.Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const HolidayEntrySchema = new Schema<HolidayEntry>(
  {
    date: { type: Date, required: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ["mandatory", "optional"], default: "mandatory" },
    isHalfDay: { type: Boolean, default: false },
    description: { type: String, trim: true },
  },
  { _id: true }
);

const HolidayCalendarVersionSchema = new Schema<HolidayCalendarVersionI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    calendar: { type: Schema.Types.ObjectId, ref: "HolidayCalendar", required: true, index: true },
    versionNumber: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["draft", "published", "cancelled"],
      default: "draft",
      index: true,
    },
    effectiveFrom: { type: Date, default: null, index: true },
    timezone: { type: String, required: true, trim: true, default: "Asia/Kolkata" },
    holidays: { type: [HolidayEntrySchema], default: [] },
    changeReason: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

HolidayCalendarVersionSchema.index({ company: 1, calendar: 1, versionNumber: 1 }, { unique: true });
HolidayCalendarVersionSchema.index({ company: 1, calendar: 1, status: 1, effectiveFrom: -1 });

const HolidayCalendarVersion =
  (mongoose.models.HolidayCalendarVersion as mongoose.Model<HolidayCalendarVersionI>) ||
  mongoose.model<HolidayCalendarVersionI>("HolidayCalendarVersion", HolidayCalendarVersionSchema);

export default HolidayCalendarVersion;
