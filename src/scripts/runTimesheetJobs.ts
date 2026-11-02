import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import { runScheduledTimesheets } from "../services/timesheet/timesheetScheduler";

async function main() {
  try { await connectToDatabase(); await runScheduledTimesheets(); }
  finally { await mongoose.disconnect(); }
}
main().catch((error) => { console.error("Timesheet job check failed", error.message); process.exitCode = 1; });
