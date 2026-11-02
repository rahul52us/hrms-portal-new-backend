import mongoose, { Schema } from "mongoose";

const evidence = {
  eventId: { type: Schema.Types.ObjectId, required: true },
  reason: { type: String, required: true, maxlength: 500 },
  actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
  actorNameSnapshot: { type: String, required: true },
  at: { type: Date, required: true },
};
const exemption = new Schema({ ...evidence,
  mode: { type: String, enum: ["full_day", "minutes"], required: true },
  minutes: { type: Number, default: null, min: 1, max: 1440 },
}, { _id: false });
const extension = new Schema({ ...evidence,
  until: { type: Date, required: true },
  timezone: { type: String, required: true },
}, { _id: false });
const schema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: "Company", required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  attendanceDate: { type: String, required: true, immutable: true },
  revision: { type: Number, required: true, min: 0, default: 0 },
  writeVersion: { type: Number, required: true, min: 0, default: 0 },
  exemption: { type: exemption, default: null },
  extension: { type: extension, default: null },
  payrollLockedAt: { type: Date, default: null },
  payrollInput: { type: Schema.Types.ObjectId, ref: "TimesheetPayrollInput", default: null },
}, { timestamps: true });
schema.index({ company: 1, employee: 1, attendanceDate: 1 }, { unique: true });
schema.index({ company: 1, attendanceDate: 1, employee: 1 });
export default mongoose.models.TimesheetDayControl || mongoose.model("TimesheetDayControl", schema);
