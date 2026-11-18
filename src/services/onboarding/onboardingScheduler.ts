import cron from "node-cron";
import Company from "../../schemas/company/Company";
import Instance from "../../schemas/Onboarding/EmployeeOnboarding.schema";
import { OnboardingAutomationJob as Job, OnboardingAutomationSettings as Settings } from "../../schemas/Onboarding/OnboardingAutomation.schema";
import { drainOnboardingAutomation, queueOnboardingAutomation, wakeOnboardingAutomation } from "./onboardingAutomation.service";

let started = false, running = false;
/** Page companies and resume durable jobs; employee rosters are never loaded by the scheduler. */
export async function runScheduledOnboarding(reference = new Date(), continueInBackground = true) {
  if (running) return;
  running = true;
  try {
    let after: any = null;
    for (;;) {
      const companies: any[] = await Company.find({ is_active: true, deletedAt: null, ...(after ? { _id: { $gt: after } } : {}) }).select("_id").sort({ _id: 1 }).limit(100).lean();
      if (!companies.length) break;
      for (const company of companies) {
        if (await Settings.exists({ company: company._id, enabled: false })) continue;
        if (await Instance.exists({ company: company._id, isCurrent: true, status: { $ne: "cancelled" }, tasks: { $elemMatch: { status: { $in: ["pending", "blocked", "pending_review"] }, dueAt: { $lte: new Date(reference.getTime() + 168 * 3600000) } } } })) {
          await queueOnboardingAutomation(company._id, `scheduled:${reference.toISOString().slice(0, 13)}`, "scheduled");
        }
      }
      after = companies[companies.length - 1]._id;
    }
    const jobs: any[] = await Job.find({ active: true, $or: [{ status: "queued" }, { status: "running", leaseUntil: { $lt: reference } }, { status: "failed", failures: { $lt: 5 }, nextAttemptAt: { $lte: reference } }] }).sort({ updatedAt: 1, _id: 1 }).limit(10).select("_id").lean();
    for (const job of jobs) {
      await drainOnboardingAutomation(job._id, 3000);
      if (continueInBackground && await Job.exists({ _id: job._id, active: true, status: "queued" })) wakeOnboardingAutomation(job._id);
    }
  } finally { running = false; }
}
export function startOnboardingScheduler() {
  if (started || process.env.NODE_ENV === "test" || process.env.ONBOARDING_SCHEDULER_ENABLED === "false") return false;
  const expression = process.env.ONBOARDING_SCHEDULER_CRON || "*/5 * * * *";
  if (!cron.validate(expression)) throw new Error("Invalid ONBOARDING_SCHEDULER_CRON");
  started = true;
  cron.schedule(expression, () => { void runScheduledOnboarding().catch((error) => console.error("Onboarding reminder scheduler failed", error.message)); }, { timezone: "UTC" });
  return true;
}
