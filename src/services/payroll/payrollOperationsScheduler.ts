import cron from "node-cron";
import Company from "../../schemas/company/Company";
import PayrollOperationalJob from "../../schemas/Payroll/PayrollOperationalJob.schema";
import {
  createPayrollOperationalJob,
  executePayrollOperationalJob,
} from "./payrollOperations.service";

let schedulerStarted = false;

function dateInTimeZone(reference: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(reference);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export async function runScheduledPayrollOperations(reference = new Date()) {
  const timeZone = process.env.PAYROLL_OPERATIONS_TIMEZONE || "Asia/Kolkata";
  const date = dateInTimeZone(reference, timeZone);
  const companies: any[] = await Company.find({
    is_active: true,
    deletedAt: { $exists: false },
    "payrollSettings.payrollNotificationsEnabled": { $ne: false },
  }).select("_id company_name companyCode payrollSettings rolePermissions").lean();
  const results: any[] = [];
  for (const company of companies) {
    const job = await createPayrollOperationalJob({
      company,
      idempotencyKey: `scheduled-reminders:${date}`,
      trigger: "scheduler",
    });
    results.push(await executePayrollOperationalJob(job._id, company, date));
  }
  return { date, companies: companies.length, jobs: results.map((job) => ({ id: job?._id, status: job?.status })) };
}

export async function recoverPayrollOperationalJobs() {
  const now = new Date();
  await PayrollOperationalJob.updateMany(
    { status: "running", lockExpiresAt: { $lte: now } },
    {
      $set: {
        status: "failed",
        nextRetryAt: now,
        lockToken: null,
        lockedAt: null,
        lockExpiresAt: null,
        lastError: { code: "stale_lock_recovered", message: "The prior worker lock expired and the job was recovered" },
      },
    }
  );
  const due: any[] = await PayrollOperationalJob.find({
    status: "failed",
    nextRetryAt: { $lte: now },
    $expr: { $lt: ["$attempts", "$maxAttempts"] },
  }).limit(100).lean();
  let recovered = 0;
  for (const job of due) {
    const company: any = await Company.findById(job.company).select("_id company_name companyCode payrollSettings rolePermissions").lean();
    if (!company) continue;
    await executePayrollOperationalJob(job._id, company);
    recovered += 1;
  }
  return recovered;
}

export function startPayrollOperationsScheduler() {
  if (schedulerStarted || process.env.PAYROLL_OPERATIONS_SCHEDULER_ENABLED === "false") return false;
  const expression = process.env.PAYROLL_OPERATIONS_CRON || "0 9 * * *";
  const timeZone = process.env.PAYROLL_OPERATIONS_TIMEZONE || "Asia/Kolkata";
  if (!cron.validate(expression)) {
    console.error(`Payroll operations scheduler disabled: invalid cron expression ${expression}`);
    return false;
  }
  schedulerStarted = true;
  cron.schedule(expression, async () => {
    try {
      await recoverPayrollOperationalJobs();
      const result = await runScheduledPayrollOperations();
      if (result.jobs.length) console.log(`Processed ${result.jobs.length} payroll reminder job(s) for ${result.date}`);
    } catch (error: any) {
      console.error("Scheduled payroll operations failed:", error?.message || error);
    }
  }, { timezone: timeZone });
  return true;
}
