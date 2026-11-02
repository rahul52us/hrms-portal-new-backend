import mongoose, { Schema } from "mongoose";
import { generateError } from "../../config/Error/functions";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, required: true }, actor: { type: Schema.Types.ObjectId, required: true },
  bucket: { type: Number, required: true }, count: { type: Number, default: 0 }, expiresAt: { type: Date, required: true },
});
schema.index({ company: 1, actor: 1, bucket: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const TimesheetWriteBucket = mongoose.models.TimesheetWriteBucket || mongoose.model("TimesheetWriteBucket", schema);

export async function guardTimesheetWrite(req: any, res: any, next: any) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  try {
    if (Buffer.byteLength(JSON.stringify(req.body || {}), "utf8") > 262144) throw generateError("Timesheet payload exceeds 256 KB", 413);
    const actor = req.bodyData || req.user;
    const key = { company: String(actor?.company?._id || actor?.company || ""), actor: String(actor?._id || actor?.userId || ""), bucket: Math.floor(Date.now() / 60000) };
    if (!mongoose.Types.ObjectId.isValid(key.company) || !mongoose.Types.ObjectId.isValid(key.actor)) return next();
    let result: any;
    try { result = await TimesheetWriteBucket.findOneAndUpdate(key, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + 120000) } }, { upsert: true, new: true }).lean(); }
    catch (error: any) { if (error.code !== 11000) throw error; result = await TimesheetWriteBucket.findOneAndUpdate(key, { $inc: { count: 1 } }, { new: true }).lean(); }
    if (result.count > 120) { res.setHeader("Retry-After", String(60 - new Date().getSeconds())); throw generateError("Too many Timesheet changes. Retry in a minute.", 429); }
    next();
  } catch (error) { next(error); }
}

export function timesheetBackgroundTask(task: () => Promise<unknown>) {
  setImmediate(() => { void task().catch((error) => console.error("Timesheet background task failed", error.message)); });
}
