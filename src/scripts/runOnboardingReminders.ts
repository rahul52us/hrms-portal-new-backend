import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import Instance from "../schemas/Onboarding/EmployeeOnboarding.schema";
import Notification from "../schemas/Notification/notification.schema";
import { OnboardingAutomationAudit as Audit, OnboardingAutomationJob as Job, OnboardingAutomationSettings as Settings } from "../schemas/Onboarding/OnboardingAutomation.schema";
import { drainOnboardingAutomation } from "../services/onboarding/onboardingAutomation.service";
import { runScheduledOnboarding } from "../services/onboarding/onboardingScheduler";

/** External cron entry point: create only indexes (never drop data), then drain within a bounded process lifetime. */
async function main() {
  try {
    await connectToDatabase();
    for (const model of [Settings, Audit, Job, Instance, Notification]) await model.createIndexes();
    await runScheduledOnboarding(new Date(), false);
    const until = Date.now() + 240000;
    while (Date.now() < until) {
      const pending: any[] = await Job.find({ active: true, status: "queued" }).sort({ updatedAt: 1, _id: 1 }).select("_id").limit(10).lean();
      if (!pending.length) break;
      for (const job of pending) {
        if (Date.now() >= until) break;
        await drainOnboardingAutomation(job._id);
      }
    }
    const failed = await Job.countDocuments({ active: true, status: "failed" });
    if (failed) { console.error(`${failed} onboarding reminder job(s) need retry; inspect the Automation tab.`); process.exitCode = 1; }
    else console.log("Onboarding reminder check finished; remaining durable work will resume on the next run.");
  } finally { await mongoose.disconnect(); }
}
main().catch((error) => { console.error("Onboarding reminder check failed", error.message); process.exitCode = 1; });
