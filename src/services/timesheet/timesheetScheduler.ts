import cron from "node-cron";
import Company from "../../schemas/company/Company";
import Assignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import { TimesheetAutomationJob as Job } from "../../schemas/Timesheet/TimesheetAutomation.schema";
import { TimesheetPayrollInput as PayrollInput } from "../../schemas/Timesheet/TimesheetPayroll.schema";
import { drainTimesheetAutomation, queueTimesheetAutomation } from "./timesheetAutomation.service";
import { drainTimesheetPayrollLock, finishTimesheetPayrollCancellation } from "./timesheetPayroll.service";

let started = false, running = false;
export async function runScheduledTimesheets(reference = new Date(), keepDraining = false) {
  if (running) return;
  running = true;
  try {
    let after: any = null;
    for (;;) {
      const companies: any[] = await Company.find({ is_active: true, deletedAt: null, ...(after ? { _id: { $gt: after } } : {}) }).select("_id").sort({ _id: 1 }).limit(100).lean();
      if (!companies.length) break;
      for (const company of companies) if (await Assignment.exists({ company: company._id, resourceType: "timesheet_policy" })) await queueTimesheetAutomation(company._id, `scheduled:${reference.toISOString().slice(0, 13)}`, null, reference);
      after = companies[companies.length - 1]._id;
    }
    const jobs: any[] = await Job.find({ active: true, $or: [{ status: "queued" }, { status: "running", leaseUntil: { $lt: reference } }, { status: "failed", failures: { $lt: 5 }, nextAttemptAt: { $lte: reference } }] }).sort({ updatedAt: 1 }).limit(20).lean();
    for (const job of jobs) await drainTimesheetAutomation(job._id, 5000, keepDraining);
    const payroll: any[] = await PayrollInput.find({ active: true, $or: [{ status: "locking", leaseUntil: null }, { status: "locking", leaseUntil: { $lt: reference } }, { status: "failed", failures: { $lt: 5 }, nextAttemptAt: { $lte: reference } }] }).sort({ updatedAt: 1 }).limit(20).lean();
    for (const input of payroll) await drainTimesheetPayrollLock(input._id, 5000, keepDraining);
    const cancelling = await PayrollInput.find({ active: true, status: "cancelling" }).select("_id").limit(20).lean();
    for (const input of cancelling) await finishTimesheetPayrollCancellation(input._id);
  } finally { running = false; }
}
export function startTimesheetScheduler() {
  if (started || process.env.TIMESHEET_SCHEDULER_ENABLED === "false") return false;
  const expression = process.env.TIMESHEET_SCHEDULER_CRON || "*/5 * * * *";
  if (!cron.validate(expression)) throw new Error("Invalid TIMESHEET_SCHEDULER_CRON");
  started = true;
  cron.schedule(expression, () => { void runScheduledTimesheets(new Date(), true).catch((error) => console.error("Timesheet scheduler failed", error.message)); }, { timezone: "UTC" });
  return true;
}
