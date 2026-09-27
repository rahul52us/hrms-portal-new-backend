import { NextFunction, Response } from "express";
import mongoose, { ClientSession } from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceImportBatch from "../../schemas/Attendance/AttendanceImportBatch.schema";
import AttendancePeriod from "../../schemas/Attendance/AttendancePeriod.schema";
import AttendancePeriodRevision from "../../schemas/Attendance/AttendancePeriodRevision.schema";
import AttendanceProcessorRun from "../../schemas/Attendance/AttendanceProcessorRun.schema";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";
import AttendanceRegularizationRequest from "../../schemas/Attendance/AttendanceRegularizationRequest.schema";
import AttendanceOvertimeReview from "../../schemas/Attendance/AttendanceOvertimeReview.schema";
import LeaveCancellationRequest from "../../schemas/Leave/LeaveCancellationRequest.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import RemoteWorkRequest from "../../schemas/Request/RemoteWorkRequest.schema";
import Company from "../../schemas/company/Company";
import {
  getEmployeeRequestActor,
  resolveEmployeeRequestCompanyId,
} from "../leave/leaveAccess.utils";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { createAttendanceMonthlySummaries } from "./attendanceSummary.service";

export type AttendancePeriodReadiness = {
  periodEnded: boolean;
  totalRecords: number;
  finalizedRecords: number;
  unfinalizedRecords: number;
  openRecords: number;
  pendingRecords: number;
  missingPunchRecords: number;
  pendingRegularizations: number;
  pendingOvertimeReviews: number;
  pendingLeaveRequests: number;
  pendingLeaveCancellations: number;
  pendingRemoteWorkRequests: number;
  activeProcessorRuns: number;
  activeImportBatches: number;
  calendarDays: number;
  closedCalendarDays: number;
  upcomingDays: number;
  processedDays: number;
  missingProcessorDays: number;
  problemProcessorDays: number;
  missingProcessorDates: string[];
  problemProcessorDates: string[];
  upcomingDates: string[];
  blockers: string[];
  readyToLock: boolean;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function requiredReason(value: unknown) {
  const reason = text(value);
  if (reason.length < 3) throw generateError("Reason must contain at least 3 characters", 422);
  if (reason.length > 1000) throw generateError("Reason cannot exceed 1000 characters", 422);
  return reason;
}

export function parseAttendancePeriodKey(value: unknown) {
  const periodKey = text(value);
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(periodKey);
  if (!match) throw generateError("Attendance period must use YYYY-MM", 422);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const finalDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    periodKey,
    startDate: `${periodKey}-01`,
    endDate: `${periodKey}-${String(finalDay).padStart(2, "0")}`,
  };
}

function previousPeriodKey(periodKey: string) {
  const parsed = parseAttendancePeriodKey(periodKey);
  const [year, month] = parsed.periodKey.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nextPeriodKey(periodKey: string) {
  const parsed = parseAttendancePeriodKey(periodKey);
  const [year, month] = parsed.periodKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nextDate(date: string) {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function attendanceCycleRange(
  periodKey: string,
  attendanceCutoffDay: number,
  previousEndDate?: string | null
) {
  const parsed = parseAttendancePeriodKey(periodKey);
  if (!Number.isInteger(attendanceCutoffDay) || attendanceCutoffDay < 1 || attendanceCutoffDay > 31) {
    throw generateError("Attendance cutoff day must be between 1 and 31", 422);
  }
  const [year, month] = parsed.periodKey.split("-").map(Number);
  const finalDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const endDate = `${parsed.periodKey}-${String(Math.min(attendanceCutoffDay, finalDay)).padStart(2, "0")}`;
  if (previousEndDate) {
    const startDate = nextDate(previousEndDate);
    if (startDate > endDate) {
      throw generateError("The configured attendance cutoff overlaps the previous cycle", 409);
    }
    return { periodKey: parsed.periodKey, startDate, endDate, attendanceCutoffDay };
  }

  const previousKey = previousPeriodKey(parsed.periodKey);
  const [previousYear, previousMonth] = previousKey.split("-").map(Number);
  const previousFinalDay = new Date(Date.UTC(previousYear, previousMonth, 0)).getUTCDate();
  const previousEnd = `${previousKey}-${String(Math.min(attendanceCutoffDay, previousFinalDay)).padStart(2, "0")}`;
  return {
    periodKey: parsed.periodKey,
    startDate: nextDate(previousEnd),
    endDate,
    attendanceCutoffDay,
  };
}

export function attendancePeriodKeyForDate(attendanceDate: unknown) {
  const date = text(attendanceDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw generateError("Attendance date must use YYYY-MM-DD", 422);
  }
  return parseAttendancePeriodKey(date.slice(0, 7)).periodKey;
}

export function attendancePeriodLabel(periodKey: string) {
  const { startDate } = parseAttendancePeriodKey(periodKey);
  return new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${startDate}T00:00:00Z`));
}

function currentDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function withSession<T extends mongoose.Query<any, any>>(query: T, session?: ClientSession | null) {
  return session ? query.session(session) : query;
}

export async function resolveAttendanceCycleRange(options: {
  company: mongoose.Types.ObjectId;
  periodKey: string;
  session?: ClientSession | null;
}) {
  const parsed = parseAttendancePeriodKey(options.periodKey);
  const [company, previousPeriod] = await Promise.all([
    withSession(
      Company.findById(options.company).select("payrollSettings.attendanceCutoffDay").lean(),
      options.session
    ),
    withSession(
      AttendancePeriod.findOne({
        company: options.company,
        periodKey: previousPeriodKey(parsed.periodKey),
      }).select("endDate").lean(),
      options.session
    ),
  ]);
  if (!company) throw generateError("Company not found", 404);
  const attendanceCutoffDay = Number((company as any).payrollSettings?.attendanceCutoffDay || 31);
  return attendanceCycleRange(parsed.periodKey, attendanceCutoffDay, previousPeriod?.endDate);
}

export function attendancePeriodBlockers(
  counts: Omit<AttendancePeriodReadiness, "blockers" | "readyToLock">
) {
  const blockers: string[] = [];
  if (!counts.periodEnded) blockers.push("The attendance cycle end date has not been reached yet");
  if (counts.totalRecords === 0) blockers.push("No attendance records exist for this cycle");
  if (counts.unfinalizedRecords > 0) {
    blockers.push(`${counts.unfinalizedRecords} attendance record(s) are not finalized`);
  }
  if (counts.pendingRegularizations > 0) {
    blockers.push(`${counts.pendingRegularizations} attendance correction request(s) are pending`);
  }
  if (counts.pendingOvertimeReviews > 0) {
    blockers.push(`${counts.pendingOvertimeReviews} overtime review(s) are pending`);
  }
  if (counts.pendingLeaveRequests > 0) {
    blockers.push(`${counts.pendingLeaveRequests} leave request(s) are pending`);
  }
  if (counts.pendingLeaveCancellations > 0) {
    blockers.push(`${counts.pendingLeaveCancellations} leave cancellation request(s) are pending`);
  }
  if (counts.pendingRemoteWorkRequests > 0) {
    blockers.push(`${counts.pendingRemoteWorkRequests} WFH request(s) are pending`);
  }
  if (counts.activeProcessorRuns > 0) {
    blockers.push(`${counts.activeProcessorRuns} attendance processor run(s) are active`);
  }
  if (counts.activeImportBatches > 0) {
    blockers.push(`${counts.activeImportBatches} attendance import(s) are active`);
  }
  if (counts.missingProcessorDays > 0) {
    blockers.push(`${counts.missingProcessorDays} day(s) have not been processed`);
  }
  if (counts.problemProcessorDays > 0) {
    blockers.push(`${counts.problemProcessorDays} processed day(s) still have setup, failure, open-shift, or finalization issues`);
  }
  return blockers;
}

function datesInRange(startDate: string, endDate: string) {
  const dates: string[] = [];
  let cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}

export async function loadPeriodReadiness(options: {
  company: mongoose.Types.ObjectId;
  periodKey: string;
  startDate: string;
  endDate: string;
  session?: ClientSession | null;
}): Promise<AttendancePeriodReadiness> {
  const range = { startDate: options.startDate, endDate: options.endDate };
  const recordMatch = {
    company: options.company,
    attendanceDate: { $gte: range.startDate, $lte: range.endDate },
  };
  const pendingCancellations = await withSession(
    LeaveCancellationRequest.find({
      company: options.company,
      status: "submitted",
    }).select("leaveRequest").lean(),
    options.session
  );
  const cancellationLeaveIds = pendingCancellations.map((item: any) => item.leaveRequest);
  const [
    totalRecords,
    finalizedRecords,
    openRecords,
    pendingRecords,
    missingPunchRecords,
    pendingRegularizations,
    pendingOvertimeReviews,
    pendingLeaveRequests,
    pendingLeaveCancellations,
    pendingRemoteWorkRequests,
    activeProcessorRuns,
    activeImportBatches,
    processorRuns,
  ] = await Promise.all([
    withSession(AttendanceRecord.countDocuments(recordMatch), options.session),
    withSession(AttendanceRecord.countDocuments({ ...recordMatch, state: "finalized" }), options.session),
    withSession(AttendanceRecord.countDocuments({ ...recordMatch, state: "open" }), options.session),
    withSession(AttendanceRecord.countDocuments({ ...recordMatch, status: "pending" }), options.session),
    withSession(AttendanceRecord.countDocuments({ ...recordMatch, hasMissingPunch: true }), options.session),
    withSession(AttendanceRegularizationRequest.countDocuments({
      company: options.company,
      attendanceDate: { $gte: range.startDate, $lte: range.endDate },
      status: "submitted",
    }), options.session),
    withSession(AttendanceOvertimeReview.countDocuments({
      company: options.company,
      attendanceDate: { $gte: range.startDate, $lte: range.endDate },
      status: "pending",
    }), options.session),
    withSession(LeaveRequest.countDocuments({
      company: options.company,
      fromDate: { $lte: range.endDate },
      toDate: { $gte: range.startDate },
      status: "submitted",
    }), options.session),
    cancellationLeaveIds.length
      ? withSession(LeaveRequest.countDocuments({
          _id: { $in: cancellationLeaveIds },
          company: options.company,
          fromDate: { $lte: range.endDate },
          toDate: { $gte: range.startDate },
        }), options.session)
      : Promise.resolve(0),
    withSession(RemoteWorkRequest.countDocuments({
      company: options.company,
      fromDate: { $lte: range.endDate },
      toDate: { $gte: range.startDate },
      status: { $in: ["submitted", "manager_approved"] },
    }), options.session),
    withSession(AttendanceProcessorRun.countDocuments({
      company: options.company,
      attendanceDate: { $gte: range.startDate, $lte: range.endDate },
      active: true,
      status: { $in: ["pending", "running"] },
    }), options.session),
    withSession(AttendanceImportBatch.countDocuments({
      company: options.company,
      status: "processing",
    }), options.session),
    withSession(AttendanceProcessorRun.find({
      company: options.company,
      attendanceDate: { $gte: range.startDate, $lte: range.endDate },
    }).select("attendanceDate status counts createdAt").sort({ attendanceDate: 1, createdAt: -1 }).lean(), options.session),
  ]);

  const latestRunByDate = new Map<string, any>();
  for (const run of processorRuns as any[]) {
    if (!latestRunByDate.has(run.attendanceDate)) latestRunByDate.set(run.attendanceDate, run);
  }
  const cycleDates = datesInRange(range.startDate, range.endDate);
  const today = currentDateKey();
  const closedDates = cycleDates.filter((date) => date <= today);
  const upcomingDates = cycleDates.filter((date) => date > today);
  const missingProcessorDates = closedDates.filter((date) => !latestRunByDate.has(date));
  const problemProcessorDates = closedDates.filter((date) => {
    const run = latestRunByDate.get(date);
    if (!run) return false;
    return run.status !== "completed" ||
      Number(run.counts?.notClosed || 0) > 0 ||
      Number(run.counts?.awaitingFinalization || 0) > 0 ||
      Number(run.counts?.reviewRequired || 0) > 0 ||
      Number(run.counts?.setupGaps || 0) > 0 ||
      Number(run.counts?.failures || 0) > 0;
  });

  const counts = {
    periodEnded: range.endDate <= currentDateKey(),
    totalRecords,
    finalizedRecords,
    unfinalizedRecords: Math.max(0, totalRecords - finalizedRecords),
    openRecords,
    pendingRecords,
    missingPunchRecords,
    pendingRegularizations,
    pendingOvertimeReviews,
    pendingLeaveRequests,
    pendingLeaveCancellations,
    pendingRemoteWorkRequests,
    activeProcessorRuns,
    activeImportBatches,
    calendarDays: cycleDates.length,
    closedCalendarDays: closedDates.length,
    upcomingDays: upcomingDates.length,
    processedDays: closedDates.length - missingProcessorDates.length - problemProcessorDates.length,
    missingProcessorDays: missingProcessorDates.length,
    problemProcessorDays: problemProcessorDates.length,
    missingProcessorDates,
    problemProcessorDates,
    upcomingDates,
  };
  const blockers = attendancePeriodBlockers(counts);
  return { ...counts, blockers, readyToLock: blockers.length === 0 };
}

export async function assertAttendanceDatesWritable(options: {
  company: mongoose.Types.ObjectId;
  attendanceDates: unknown[];
  session?: ClientSession | null;
}) {
  const attendanceDates = [...new Set(options.attendanceDates.map((value) => {
    const date = text(value);
    attendancePeriodKeyForDate(date);
    return date;
  }))].sort();
  if (!attendanceDates.length) return;
  const lockedPeriods = await withSession(
    AttendancePeriod.find({
      company: options.company,
      status: "locked",
      startDate: { $lte: attendanceDates[attendanceDates.length - 1] },
      endDate: { $gte: attendanceDates[0] },
    }).select("periodKey startDate endDate").lean(),
    options.session
  );
  const locked = lockedPeriods.find((period) =>
    attendanceDates.some((date) => date >= period.startDate && date <= period.endDate)
  );
  if (locked) {
    throw generateError(
      `Attendance cycle ${locked.startDate} to ${locked.endDate} is locked. Reopen the cycle before making changes`,
      409
    );
  }
}

export async function assertAttendanceDateWritable(options: {
  company: mongoose.Types.ObjectId;
  attendanceDate: unknown;
  session?: ClientSession | null;
}) {
  return assertAttendanceDatesWritable({
    company: options.company,
    attendanceDates: [options.attendanceDate],
    session: options.session,
  });
}

function requestContext(req: any) {
  const actor = getEmployeeRequestActor(req);
  if (actor.role === "superadmin") {
    throw generateError("Attendance-period operations require a company account", 403);
  }
  const company = resolveEmployeeRequestCompanyId(actor, undefined, "attendance period");
  return { actor, company };
}

function expectedVersion(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw generateError("Expected version must be a non-negative integer", 422);
  }
  return version;
}

async function periodView(company: mongoose.Types.ObjectId, periodKey: string) {
  const period: any = await AttendancePeriod.findOne({ company, periodKey })
    .populate("lockedBy", "name code role")
    .populate("reopenedBy", "name code role")
    .lean();
  const range = period
    ? {
        periodKey,
        startDate: period.startDate,
        endDate: period.endDate,
        attendanceCutoffDay: Number(period.attendanceCutoffDay || 31),
      }
    : await resolveAttendanceCycleRange({ company, periodKey });
  const [readiness, history] = await Promise.all([
    loadPeriodReadiness({ company, ...range }),
    AttendancePeriodRevision.find({ company, periodKey })
      .sort({ version: -1 })
      .limit(50)
      .populate("actor", "name code role")
      .lean(),
  ]);
  return {
    period: period || {
      _id: null,
      company,
      ...range,
      status: "open",
      version: 0,
      lockedAt: null,
      lockedBy: null,
      lockReason: "",
      reopenedAt: null,
      reopenedBy: null,
      reopenReason: "",
    },
    cycle: range,
    readiness,
    history,
  };
}

export async function getAttendancePeriodService(req: any, res: Response, next: NextFunction) {
  try {
    const { actor, company } = requestContext(req);
    if (!hasPermission(actor, PERMISSION_KEYS.VIEW_ATTENDANCE)) {
      throw generateError("You do not have permission to view attendance periods", 403);
    }
    const periodKey = parseAttendancePeriodKey(req.params.periodKey).periodKey;
    return res.status(200).json({ success: true, data: await periodView(company, periodKey) });
  } catch (error) {
    next(error);
  }
}

export async function getAttendancePeriodForDateService(
  req: any,
  res: Response,
  next: NextFunction
) {
  try {
    const { actor, company } = requestContext(req);
    if (!hasPermission(actor, PERMISSION_KEYS.VIEW_ATTENDANCE)) {
      throw generateError("You do not have permission to view attendance periods", 403);
    }
    const attendanceDate = text(req.params.attendanceDate);
    const calendarPeriodKey = attendancePeriodKeyForDate(attendanceDate);
    const existing: any = await AttendancePeriod.findOne({
      company,
      startDate: { $lte: attendanceDate },
      endDate: { $gte: attendanceDate },
    }).select("periodKey").lean();
    if (existing) {
      return res.status(200).json({
        success: true,
        data: await periodView(company, existing.periodKey),
      });
    }

    const candidateKeys = [calendarPeriodKey, nextPeriodKey(calendarPeriodKey)];
    for (const periodKey of candidateKeys) {
      const range = await resolveAttendanceCycleRange({ company, periodKey });
      if (attendanceDate >= range.startDate && attendanceDate <= range.endDate) {
        return res.status(200).json({
          success: true,
          data: await periodView(company, periodKey),
        });
      }
    }
    throw generateError("No attendance cycle covers this date", 409);
  } catch (error) {
    next(error);
  }
}

export async function lockAttendancePeriodService(req: any, res: Response, next: NextFunction) {
  try {
    const { actor, company } = requestContext(req);
    if (!hasPermission(actor, PERMISSION_KEYS.LOCK_ATTENDANCE_PERIOD)) {
      throw generateError("You do not have permission to lock attendance periods", 403);
    }
    const periodKey = parseAttendancePeriodKey(req.params.periodKey).periodKey;
    const existingPeriod: any = await AttendancePeriod.findOne({ company, periodKey }).lean();
    const range = existingPeriod
      ? {
          periodKey,
          startDate: existingPeriod.startDate,
          endDate: existingPeriod.endDate,
          attendanceCutoffDay: Number(existingPeriod.attendanceCutoffDay || 31),
        }
      : await resolveAttendanceCycleRange({ company, periodKey });
    const reason = requiredReason(req.body?.reason);
    const requestedVersion = expectedVersion(req.body?.expectedVersion);

    try {
      await AttendancePeriod.updateOne(
        { company, periodKey: range.periodKey },
        {
          $setOnInsert: {
            company,
            ...range,
            status: "open",
            version: 0,
            createdBy: actor._id,
            updatedBy: actor._id,
          },
        },
        { upsert: true }
      );
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
    }

    await mongoose.connection.transaction(async (session) => {
      const period: any = await AttendancePeriod.findOne({
        company,
        periodKey: range.periodKey,
      }).session(session);
      if (!period) throw generateError("Attendance period could not be initialized", 409);
      if (period.status === "locked") throw generateError("This attendance period is already locked", 409);
      if (requestedVersion !== null && Number(period.version || 0) !== requestedVersion) {
        throw generateError("Attendance period changed. Refresh and try again", 409);
      }
      const overlapping = await AttendancePeriod.findOne({
        _id: { $ne: period._id },
        company,
        startDate: { $lte: period.endDate },
        endDate: { $gte: period.startDate },
      }).session(session).lean();
      if (overlapping) {
        throw generateError(
          `Attendance cycle overlaps ${overlapping.startDate} to ${overlapping.endDate}`,
          409
        );
      }
      const readiness = await loadPeriodReadiness({
        company,
        periodKey: range.periodKey,
        startDate: period.startDate,
        endDate: period.endDate,
        session,
      });
      if (!readiness.readyToLock) {
        throw generateError(`Attendance period is not ready to lock: ${readiness.blockers.join("; ")}`, 409);
      }
      const previousStatus = period.status;
      period.status = "locked";
      period.version = Number(period.version || 0) + 1;
      period.lockedAt = new Date();
      period.lockedBy = actor._id;
      period.lockReason = reason;
      period.updatedBy = actor._id;
      await period.save({ session });
      await createAttendanceMonthlySummaries({
        company,
        attendancePeriod: period._id,
        periodKey: range.periodKey,
        attendancePeriodVersion: period.version,
        startDate: period.startDate,
        endDate: period.endDate,
        actor: actor._id,
        session,
      });
      await AttendancePeriodRevision.create([{
        company,
        attendancePeriod: period._id,
        periodKey: range.periodKey,
        version: period.version,
        action: "locked",
        previousStatus,
        nextStatus: "locked",
        reason,
        readinessSnapshot: readiness,
        actor: actor._id,
      }], { session });
    });

    return res.status(200).json({
      success: true,
      message: `${attendancePeriodLabel(range.periodKey)} attendance cycle locked`,
      data: await periodView(company, range.periodKey),
    });
  } catch (error) {
    next(error);
  }
}

export async function reopenAttendancePeriodService(req: any, res: Response, next: NextFunction) {
  try {
    const { actor, company } = requestContext(req);
    if (!hasPermission(actor, PERMISSION_KEYS.REOPEN_ATTENDANCE_PERIOD)) {
      throw generateError("You do not have permission to reopen attendance periods", 403);
    }
    const range = parseAttendancePeriodKey(req.params.periodKey);
    const reason = requiredReason(req.body?.reason);
    const requestedVersion = expectedVersion(req.body?.expectedVersion);

    await mongoose.connection.transaction(async (session) => {
      const period: any = await AttendancePeriod.findOne({
        company,
        periodKey: range.periodKey,
      }).session(session);
      if (!period || period.status !== "locked") {
        throw generateError("Only a locked attendance period can be reopened", 409);
      }
      if (requestedVersion !== null && Number(period.version || 0) !== requestedVersion) {
        throw generateError("Attendance period changed. Refresh and try again", 409);
      }
      const previousStatus = period.status;
      period.status = "open";
      period.version = Number(period.version || 0) + 1;
      period.reopenedAt = new Date();
      period.reopenedBy = actor._id;
      period.reopenReason = reason;
      period.updatedBy = actor._id;
      await period.save({ session });
      await AttendancePeriodRevision.create([{
        company,
        attendancePeriod: period._id,
        periodKey: range.periodKey,
        version: period.version,
        action: "reopened",
        previousStatus,
        nextStatus: "open",
        reason,
        readinessSnapshot: {},
        actor: actor._id,
      }], { session });
    });

    return res.status(200).json({
      success: true,
      message: `${attendancePeriodLabel(range.periodKey)} attendance reopened`,
      data: await periodView(company, range.periodKey),
    });
  } catch (error) {
    next(error);
  }
}
