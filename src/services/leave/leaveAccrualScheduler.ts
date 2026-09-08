import cron from "node-cron";
import { runAllCompaniesLeaveAccrualCatchUp } from "./leaveAccrual.service";
import { runAllCompaniesLeaveYearEnd } from "./leaveYearEnd.service";

let schedulerStarted = false;

export function startLeaveAccrualScheduler() {
  if (schedulerStarted || process.env.LEAVE_ACCRUAL_SCHEDULER_ENABLED === "false") return;
  schedulerStarted = true;
  const expression = process.env.LEAVE_ACCRUAL_CRON || "15 0 * * *";
  if (!cron.validate(expression)) {
    schedulerStarted = false;
    console.error(`Leave accrual scheduler disabled: invalid cron expression ${expression}`);
    return;
  }

  cron.schedule(
    expression,
    async () => {
      try {
        const results = await runAllCompaniesLeaveAccrualCatchUp();
        const postedCredits = results.reduce(
          (total, result: any) => total + Number(result.postedCredits || 0),
          0
        );
        console.log(`Leave accrual catch-up completed: ${postedCredits} credits posted`);
      } catch (error: any) {
        console.error("Leave accrual catch-up failed:", error?.message || error);
      }
      try {
        const yearEndResults = await runAllCompaniesLeaveYearEnd();
        const carriedUnits = yearEndResults.reduce(
          (total, result: any) => total + Number(result.carriedUnits || 0),
          0
        );
        const lapsedUnits = yearEndResults.reduce(
          (total, result: any) => total + Number(result.lapsedUnits || 0),
          0
        );
        console.log(
          `Leave year-end processing completed: ${carriedUnits} carried, ${lapsedUnits} lapsed`
        );
      } catch (error: any) {
        console.error("Leave year-end processing failed:", error?.message || error);
      }
    },
    { timezone: process.env.LEAVE_ACCRUAL_TIMEZONE || "UTC" }
  );
}
