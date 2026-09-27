import cron from "node-cron";
import mongoose from "mongoose";
import AttendancePeriod from "../../schemas/Attendance/AttendancePeriod.schema";
import AttendanceProcessorRun from "../../schemas/Attendance/AttendanceProcessorRun.schema";
import User from "../../schemas/User/User";
import { queueAttendanceProcessorRunSeries } from "./attendanceProcessor.service";

let schedulerStarted = false;

export function scheduledAttendanceDate(reference = new Date()) {
  return new Date(reference.getTime() - 86_400_000).toISOString().slice(0, 10);
}

export function scheduledAttendanceDates(reference = new Date(), lookbackDays = 3) {
  const days = Number.isInteger(lookbackDays)
    ? Math.max(1, Math.min(366, lookbackDays))
    : 3;
  return Array.from({ length: days }, (_, index) =>
    new Date(reference.getTime() - (index + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10)
  );
}

function configuredBatchSize() {
  const value = Number(process.env.ATTENDANCE_PROCESSOR_BATCH_SIZE || 100);
  return Number.isInteger(value) && value >= 10 && value <= 500 ? value : 100;
}

function configuredCatchupDays() {
  const value = Number(process.env.ATTENDANCE_PROCESSOR_CATCHUP_DAYS || 45);
  return Number.isInteger(value) && value >= 3 && value <= 366 ? value : 45;
}

function configuredMaxQueuedPerCompany() {
  const value = Number(process.env.ATTENDANCE_PROCESSOR_MAX_QUEUED_PER_COMPANY || 10);
  return Number.isInteger(value) && value >= 1 && value <= 31 ? value : 10;
}

export function attendanceProcessorRunIsComplete(run: any) {
  return run?.status === "completed" &&
    Number(run.counts?.notClosed || 0) === 0 &&
    Number(run.counts?.awaitingFinalization || 0) === 0 &&
    Number(run.counts?.reviewRequired || 0) === 0 &&
    Number(run.counts?.setupGaps || 0) === 0 &&
    Number(run.counts?.failures || 0) === 0;
}

export async function runScheduledAttendanceProcessor(reference = new Date()) {
  const attendanceDates = scheduledAttendanceDates(reference, configuredCatchupDays());
  const oldestFirstDates = [...attendanceDates].reverse();
  const hourKey = reference.toISOString().slice(0, 13).replace(/[-T:]/g, "");
  const companies = await User.distinct("company", {
    company: { $ne: null },
    is_enabled: true,
    deletedAt: null,
    role: { $ne: "superadmin" },
  });
  const queued: string[] = [];

  for (const company of companies) {
    const [lockedPeriods, priorRuns] = await Promise.all([
      AttendancePeriod.find({
        company,
        status: "locked",
        startDate: { $lte: attendanceDates[0] },
        endDate: { $gte: oldestFirstDates[0] },
      }).select("startDate endDate").lean(),
      AttendanceProcessorRun.find({
        company,
        attendanceDate: { $gte: oldestFirstDates[0], $lte: attendanceDates[0] },
      }).sort({ attendanceDate: 1, createdAt: -1 }).lean(),
    ]);
    const latestRunByDate = new Map<string, any>();
    for (const run of priorRuns) {
      if (!latestRunByDate.has(run.attendanceDate)) {
        latestRunByDate.set(run.attendanceDate, run);
      }
    }

    const companyRunIds: mongoose.Types.ObjectId[] = [];
    for (const attendanceDate of oldestFirstDates) {
      if (companyRunIds.length >= configuredMaxQueuedPerCompany()) break;
      if (lockedPeriods.some((period) =>
        attendanceDate >= period.startDate && attendanceDate <= period.endDate
      )) continue;
      const latest = latestRunByDate.get(attendanceDate);
      if (latest && ["pending", "running"].includes(latest.status)) continue;
      if (attendanceProcessorRunIsComplete(latest)) continue;
      try {
        const run = await AttendanceProcessorRun.create({
          company,
          attendanceDate,
          idempotencyKey: `scheduled:${attendanceDate}:${hourKey}`,
          trigger: "scheduled",
          status: "pending",
          active: true,
          requestedBy: null,
          batchSize: configuredBatchSize(),
        });
        queued.push(String(run._id));
        companyRunIds.push(run._id);
      } catch (error: any) {
        if (error?.code !== 11000) throw error;
      }
    }
    queueAttendanceProcessorRunSeries(companyRunIds);
  }

  return {
    attendanceDates,
    companies: companies.length,
    queued,
    lookbackDays: attendanceDates.length,
  };
}

export function startAttendanceProcessorScheduler() {
  if (
    schedulerStarted ||
    process.env.ATTENDANCE_PROCESSOR_SCHEDULER_ENABLED === "false"
  ) {
    return false;
  }
  const expression = process.env.ATTENDANCE_PROCESSOR_CRON || "15 */4 * * *";
  if (!cron.validate(expression)) {
    console.error(`Attendance processor scheduler disabled: invalid cron expression ${expression}`);
    return false;
  }
  schedulerStarted = true;
  cron.schedule(
    expression,
    async () => {
      try {
        const result = await runScheduledAttendanceProcessor();
        if (result.queued.length) {
          console.log(
            `Queued ${result.queued.length} attendance run(s) from a ${result.lookbackDays}-day catch-up window`
          );
        }
      } catch (error: any) {
        console.error("Scheduled attendance processing failed:", error?.message || error);
      }
    },
    { timezone: "UTC" }
  );
  return true;
}
