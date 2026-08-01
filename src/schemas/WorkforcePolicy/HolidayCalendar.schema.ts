import mongoose, { Document, Schema } from "mongoose";

export interface HolidayCalendarI extends Document {
  company: mongoose.Types.ObjectId;
  name: string;
  code: string;
  description?: string;
  status: "active" | "archived";
  latestVersionNumber: number;
  createdBy: mongoose.Types.ObjectId;
  archivedAt?: Date | null;
  archivedBy?: mongoose.Types.ObjectId | null;
  archiveReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const HolidayCalendarSchema = new Schema<HolidayCalendarI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, trim: true },
    status: {
      type: String,
      enum: ["active", "archived"],
      default: "active",
      index: true,
    },
    latestVersionNumber: { type: Number, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    archiveReason: { type: String, trim: true },
  },
  { timestamps: true }
);

HolidayCalendarSchema.index({ company: 1, code: 1 }, { unique: true });
HolidayCalendarSchema.index({ company: 1, status: 1, name: 1 });

const HolidayCalendar =
  (mongoose.models.HolidayCalendar as mongoose.Model<HolidayCalendarI>) ||
  mongoose.model<HolidayCalendarI>("HolidayCalendar", HolidayCalendarSchema);

export default HolidayCalendar;
