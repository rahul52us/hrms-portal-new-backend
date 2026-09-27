import { NextFunction, Response } from "express";
import mongoose, { ClientSession } from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceProcessorRun from "../../schemas/Attendance/AttendanceProcessorRun.schema";
import AttendancePeriod from "../../schemas/Attendance/AttendancePeriod.schema";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";
import AttendanceRecordRevision from "../../schemas/Attendance/AttendanceRecordRevision.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import RemoteWorkRequest from "../../schemas/Request/RemoteWorkRequest.schema";
import User from "../../schemas/User/User";
import AttendancePolicyVersion from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import type { AttendanceRules } from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import { calendarEmployeeActive } from "../calendar/calendar.utils";
import {
  getEmployeeRequestActor,
  resolveEmployeeRequestCompanyId,
} from "../leave/leaveAccess.utils";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { calculateAttendance } from "./attendanceCalculator.utils";
import { resolveEmployeeDayContext } from "./employeeDayContext.service";
import { parseAttendanceDate } from "./employeeDayContext.utils";
import {
  contextSnapshotFields,
  localAttendanceTimeToUtc,
} from "./attendanceRegularization.service";
import {
  assertAttendanceDateWritable,
  loadPeriodReadiness,
  parseAttendancePeriodKey,
  resolveAttendanceCycleRange,
} from "./attendancePeriod.service";
import { ensureOvertimeReviewForFinalizedRecord } from "./attendanceOvertime.service";

type ProcessorResult =
  | "created"
  | "updated"
  | "skipped"
  | "not_closed"
  | "setup_gap";

type ProcessorOutcome = {
  result: ProcessorResult;
  message?: string;
  autoFinalized?: boolean;
  awaitingFinalization?: boolean;
  reviewRequired?: boolean;
};

const FAILURE_SAMPLE_LIMIT = 50;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function objectId(value: unknown, label: string) {
  const normalized = text((value as any)?._id || value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) {
    throw generateError(`Invalid ${label}`, 400);
  }
  return new mongoose.Types.ObjectId(normalized);
}

function processorRequestContext(req: any) {
  const actor = getEmployeeRequestActor(req);
  if (!["admin", "hradmin"].includes(actor.role)) {
    throw generateError("Only Company Admin or HR Admin can process company attendance", 403);
  }
  if (!hasPermission(actor, PERMISSION_KEYS.ADJUST_ATTENDANCE)) {
    throw generateError("You do not have permission to process attendance", 403);
  }
  const company = resolveEmployeeRequestCompanyId(actor, undefined, "attendance processing");
  return { actor, company };
}

function processorComparable(record: any) {
  return JSON.stringify({
    state: record.state,
    status: record.status,
    workMode: record.workMode,
    workModeSource: record.workModeSource,
    remoteWorkRequest: text(record.remoteWorkRequest),
    remoteWorkPortion: record.remoteWorkPortion || null,
    leaveRequest: text(record.leaveRequest),
    leaveType: text(record.leaveType),
    leaveUnits: Number(record.leaveUnits || 0),
    leaveUnit: record.leaveUnit || null,
    workedMinutes: Number(record.workedMinutes || 0),
    breakMinutes: Number(record.breakMinutes || 0),
    lateMinutes: Number(record.lateMinutes || 0),
    earlyExitMinutes: Number(record.earlyExitMinutes || 0),
    overtimeMinutes: Number(record.overtimeMinutes || 0),
    overtimeApprovalStatus: record.overtimeApprovalStatus || "not_required",
    approvedOvertimeMinutes: Number(record.approvedOvertimeMinutes || 0),
    isLate: record.isLate === true,
    isEarlyExit: record.isEarlyExit === true,
    hasMissingPunch: record.hasMissingPunch === true,
  });
}

function recordSnapshot(record: any) {
  return record?.toObject
    ? record.toObject({ depopulate: true })
    : record
      ? { ...record }
      : null;
}

function revisionSummary(record: any) {
  if (!record) return null;
  return {
    state: record.state,
    status: record.status,
    workMode: record.workMode,
    workedMinutes: Number(record.workedMinutes || 0),
    breakMinutes: Number(record.breakMinutes || 0),
    lateMinutes: Number(record.lateMinutes || 0),
    earlyExitMinutes: Number(record.earlyExitMinutes || 0),
    overtimeMinutes: Number(record.overtimeMinutes || 0),
    hasMissingPunch: record.hasMissingPunch === true,
  };
}

function timeMinutes(value: unknown) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text(value));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function attendanceDayCloseAt(options: {
  attendanceDate: string;
  timezone: string;
  startTime: string;
  endTime: string;
  graceMinutes?: number;
}) {
  parseAttendanceDate(options.attendanceDate);
  const start = timeMinutes(options.startTime);
  const end = timeMinutes(options.endTime);
  if (start === null || end === null || start === end) {
    throw generateError("Work schedule has an invalid shift window", 422);
  }
  const closeAt = localAttendanceTimeToUtc(
    options.attendanceDate,
    options.endTime,
    options.timezone,
    end <= start
  );
  return new Date(
    closeAt.getTime() + Math.max(0, Number(options.graceMinutes || 0)) * 60_000
  );
}

const CLEAN_AUTO_FINALIZE_STATUSES = new Set([
  "present",
  "leave",
  "holiday",
  "weekly_off",
]);

export function attendanceAutoFinalizeDecision(options: {
  state: string;
  status: string;
  rules?: Partial<AttendanceRules> | null;
  closeAt: Date;
  now: Date;
}): "disabled" | "wait" | "review" | "finalize" {
  const config = options.rules?.autoFinalize;
  if (!config?.enabled || options.state !== "calculated") return "disabled";
  if (
    config.mode !== "all_calculated" &&
    !CLEAN_AUTO_FINALIZE_STATUSES.has(options.status)
  ) {
    return "review";
  }
  const finalizeAt = options.closeAt.getTime() +
    Math.max(0, Number(config.graceMinutes || 0)) * 60_000;
  return options.now.getTime() >= finalizeAt ? "finalize" : "wait";
}

export function attendanceCycleFinalizeDecision(options: {
  state: string;
  status: string;
  hasMissingPunch?: boolean;
  hasOpenPunch?: boolean;
}) {
  return options.state === "calculated" &&
    !["pending", "incomplete"].includes(options.status) &&
    options.hasMissingPunch !== true &&
    options.hasOpenPunch !== true;
}

function defaultStatus(record: any, context: any) {
  const dayType = record?.dayTypeSnapshot || context.dayType;
  if (dayType === "mandatory_holiday") return "holiday" as const;
  if (dayType === "weekly_off") return "weekly_off" as const;
  return context.defaultAttendanceStatus || ("pending" as const);
}

function setupGaps(record: any, context: any) {
  const attendanceVersion =
    record?.attendancePolicyVersion || context.policyReferences?.attendancePolicy?.versionId;
  const scheduleVersion =
    record?.workScheduleVersion || context.policyReferences?.workSchedule?.versionId;
  const holidayVersion =
    record?.holidayCalendarVersion || context.policyReferences?.holidayCalendar?.versionId;
  return [
    !attendanceVersion ? "Attendance Policy" : null,
    !scheduleVersion ? "Work Schedule" : null,
    !holidayVersion ? "Holiday Calendar" : null,
  ].filter(Boolean) as string[];
}

async function attendanceRules(
  record: any,
  context: any,
  company: mongoose.Types.ObjectId,
  session: ClientSession,
  cache: Map<string, Promise<any>>
) {
  const versionId = text(
    record?.attendancePolicyVersion || context.policyReferences?.attendancePolicy?.versionId
  );
  if (!versionId) throw generateError("Attendance policy is not configured for this date", 422);
  const cacheKey = `${company}:${versionId}`;
  let pending = cache.get(cacheKey);
  if (!pending) {
    pending = AttendancePolicyVersion.findOne({ _id: versionId, company })
      .session(session)
      .lean()
      .exec();
    cache.set(cacheKey, pending);
  }
  const version = await pending;
  if (!version) throw generateError("Attendance policy snapshot is unavailable", 409);
  return version.rules || {};
}

function applyLeave(record: any, request: any, day: any, context: any) {
  if (!request || !day) return false;
  record.leaveRequest = request._id;
  record.leaveType = request.leaveType;
  record.leaveUnits = Number(day.chargedUnits || 0);
  record.leaveUnit = request.leaveUnit;
  if (request.leaveUnit === "days") {
    record.status = Number(day.chargedUnits || 0) >= 1 ? "leave" : "half_day";
  } else {
    const expectedHours = Number(
      record.expectedWorkMinutesSnapshot || context.expectedWorkMinutes || 0
    ) / 60;
    record.status = expectedHours > 0 && Number(day.chargedUnits || 0) >= expectedHours
      ? "leave"
      : "half_day";
  }
  return true;
}

function applyRemoteWork(record: any, request: any, day: any) {
  if (!request || !day || record.leaveRequest) return;
  if (!["default", "remote_work_request"].includes(record.workModeSource || "default")) return;
  record.workMode = day.portion === "full" ? "remote" : "hybrid";
  record.workModeSource = "remote_work_request";
  record.remoteWorkRequest = request._id;
  record.remoteWorkPortion = day.portion;
  record.remoteWorkPolicyAssignment = request.remoteWorkPolicyAssignment;
  record.remoteWorkPolicy = request.remoteWorkPolicy;
  record.remoteWorkPolicyVersion = request.remoteWorkPolicyVersion;
}

async function processEmployeeDay(options: {
  company: mongoose.Types.ObjectId;
  employee: any;
  attendanceDate: string;
  actorId?: mongoose.Types.ObjectId | null;
  now: Date;
  versionCache: Map<string, Promise<any>>;
  attendanceRulesCache: Map<string, Promise<any>>;
  finalizeClean?: boolean;
  finalizationReason?: string;
}): Promise<ProcessorOutcome> {
  const { company, employee, attendanceDate, actorId, now } = options;
  if (!calendarEmployeeActive(employee, attendanceDate)) return { result: "skipped" };

  const context = await resolveEmployeeDayContext({
    companyId: company,
    employeeId: employee._id,
    attendanceDate,
    versionCache: options.versionCache,
  });

  let outcome: ProcessorOutcome = { result: "skipped" };
  await mongoose.connection.transaction(async (session) => {
    let record: any = await AttendanceRecord.findOne({
      company,
      employee: employee._id,
      attendanceDate,
    }).session(session);

    if (record?.state === "finalized") {
      outcome = { result: "skipped" };
      return;
    }

    const gaps = setupGaps(record, context);
    if (gaps.length) {
      outcome = {
        result: "setup_gap",
        message: `Missing ${gaps.join(", ")}`,
      };
      return;
    }

    const timezone = record?.timezone || context.timezone || "Asia/Kolkata";
    const startTime = record?.scheduleStartTimeSnapshot || context.schedule?.startTime || "";
    const endTime = record?.scheduleEndTimeSnapshot || context.schedule?.endTime || "";
    const closeAt = attendanceDayCloseAt({
      attendanceDate,
      timezone,
      startTime,
      endTime,
    });
    if (now.getTime() < closeAt.getTime()) {
      outcome = { result: "not_closed" };
      return;
    }

    const rules = await attendanceRules(
      record,
      context,
      company,
      session,
      options.attendanceRulesCache
    );

    const [leaveRequest, remoteWorkRequest] = await Promise.all([
      LeaveRequest.findOne({
        company,
        employee: employee._id,
        status: "approved",
        dayBreakdown: {
          $elemMatch: {
            attendanceDate,
            chargedUnits: { $gt: 0 },
            chargeReason: { $ne: "sandwich_rule" },
          },
        },
      })
        .session(session)
        .lean(),
      RemoteWorkRequest.findOne({
        company,
        employee: employee._id,
        status: "approved",
        dates: { $elemMatch: { attendanceDate } },
      })
        .session(session)
        .lean(),
    ]);
    const leaveDay = leaveRequest?.dayBreakdown?.find(
      (day: any) =>
        day.attendanceDate === attendanceDate &&
        Number(day.chargedUnits || 0) > 0 &&
        day.chargeReason !== "sandwich_rule"
    );
    const remoteWorkDay = remoteWorkRequest?.dates?.find(
      (day: any) => day.attendanceDate === attendanceDate
    );
    const isNew = !record;
    if (!record) {
      record = new AttendanceRecord({
        company,
        employee: employee._id,
        attendanceDate,
        timezone,
        state: "open",
        status: defaultStatus(null, context),
        workMode: "office",
        workModeSource: "default",
        punchSessions: [],
        revisionNumber: 0,
        calculationVersion: 0,
        source: "system",
        createdBy: actorId || null,
        ...contextSnapshotFields(context),
      });
    }

    const previous = isNew ? null : recordSnapshot(record);
    const before = processorComparable(record);
    const preserveManualValues = ["manual", "import"].includes(record.source);
    if (!preserveManualValues) {
      const hasLeave = applyLeave(record, leaveRequest, leaveDay, context);
      applyRemoteWork(record, remoteWorkRequest, remoteWorkDay);

      if (hasLeave || record.leaveRequest) {
        record.state = "calculated";
        record.workedMinutes = Number(record.workedMinutes || 0);
        record.breakMinutes = Number(record.breakMinutes || 0);
        record.lateMinutes = Number(record.lateMinutes || 0);
        record.earlyExitMinutes = Number(record.earlyExitMinutes || 0);
        record.overtimeMinutes = Number(record.overtimeMinutes || 0);
        record.hasMissingPunch = false;
      } else {
      const calculation = calculateAttendance({
        attendanceDate,
        timezone,
        punchSessions: record.punchSessions || [],
        attendanceRules: rules,
        schedule: { startTime, endTime },
        requiresAttendance:
          typeof record.requiresAttendanceSnapshot === "boolean"
            ? record.requiresAttendanceSnapshot
            : context.requiresAttendance,
        expectedWorkMinutes: Number.isFinite(Number(record.expectedWorkMinutesSnapshot))
          ? Number(record.expectedWorkMinutesSnapshot)
          : context.expectedWorkMinutes,
        defaultAttendanceStatus: defaultStatus(record, context),
        dayClosed: true,
      });
      record.state = calculation.state;
      record.status = calculation.status;
      record.workedMinutes = calculation.workedMinutes;
      record.breakMinutes = calculation.breakMinutes;
      record.lateMinutes = calculation.lateMinutes;
      record.earlyExitMinutes = calculation.earlyExitMinutes;
      record.overtimeMinutes = calculation.overtimeMinutes;
      record.isLate = calculation.isLate;
      record.isEarlyExit = calculation.isEarlyExit;
      record.hasMissingPunch = calculation.hasMissingPunch;
      }
    }

    const policyFinalizeDecision = attendanceAutoFinalizeDecision({
      state: record.state,
      status: record.status,
      rules,
      closeAt,
      now,
    });
    const cycleFinalized = options.finalizeClean === true && attendanceCycleFinalizeDecision({
      state: record.state,
      status: record.status,
      hasMissingPunch: record.hasMissingPunch,
      hasOpenPunch: (record.punchSessions || []).some(
        (session: any) => Boolean(session?.punchIn && !session?.punchOut)
      ),
    });
    const autoFinalized = cycleFinalized || policyFinalizeDecision === "finalize";
    if (autoFinalized) record.state = "finalized";

    if (!isNew && before === processorComparable(record)) {
      outcome = {
        result: "skipped",
        awaitingFinalization: policyFinalizeDecision === "wait",
        reviewRequired:
          policyFinalizeDecision === "review" ||
          (options.finalizeClean === true && !cycleFinalized),
      };
      return;
    }

    const latestRevision = await AttendanceRecordRevision.findOne({
      company,
      attendanceRecord: record._id,
    })
      .sort({ revisionNumber: -1 })
      .select("revisionNumber")
      .session(session)
      .lean();
    record.revisionNumber =
      Math.max(
        Number(record.revisionNumber || 0),
        Number(latestRevision?.revisionNumber || 0)
      ) + 1;
    record.calculationVersion = Number(record.calculationVersion || 0) + 1;
    record.calculatedAt = now;
    record.calculatedBy = actorId || null;
    record.calculationReason = cycleFinalized
      ? options.finalizationReason || "Attendance finalized during cycle preparation"
      : autoFinalized
        ? "Attendance automatically finalized after the configured grace period"
      : "Attendance day processor";
    record.updatedBy = actorId || null;
    await record.save({ session });
    if (autoFinalized) {
      await ensureOvertimeReviewForFinalizedRecord({
        record,
        actor: actorId ? { _id: actorId, role: "system" } : undefined,
        session,
      });
    }

    await AttendanceRecordRevision.create(
      [
        {
          company,
          attendanceRecord: record._id,
          employee: employee._id,
          revisionNumber: record.revisionNumber,
          action: autoFinalized ? "finalized" : isNew ? "created" : "recalculated",
          reason: cycleFinalized
            ? options.finalizationReason || "Attendance finalized during cycle preparation"
            : autoFinalized
              ? "Attendance automatically finalized after the policy grace period"
            : "Attendance day processed after the shift closed",
          changes: {
            before: revisionSummary(previous),
            after: revisionSummary(record),
          },
          snapshot: recordSnapshot(record),
          actor: actorId || null,
          source: cycleFinalized ? "manual" : "system",
        },
      ],
      { session }
    );

    outcome = {
      result: isNew ? "created" : "updated",
      autoFinalized,
      awaitingFinalization: policyFinalizeDecision === "wait",
      reviewRequired:
        policyFinalizeDecision === "review" ||
        (options.finalizeClean === true && !cycleFinalized),
    };
  });
  return outcome;
}

function emptyCounts() {
  return {
    scanned: 0,
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    notClosed: 0,
    awaitingFinalization: 0,
    autoFinalized: 0,
    reviewRequired: 0,
    setupGaps: 0,
    failures: 0,
  };
}

function addResult(counts: ReturnType<typeof emptyCounts>, outcome: ProcessorOutcome) {
  const { result } = outcome;
  counts.scanned += 1;
  if (result === "created") {
    counts.created += 1;
    counts.processed += 1;
  } else if (result === "updated") {
    counts.updated += 1;
    counts.processed += 1;
  } else if (result === "not_closed") {
    counts.notClosed += 1;
  } else if (result === "setup_gap") {
    counts.setupGaps += 1;
  } else {
    counts.skipped += 1;
    counts.processed += 1;
  }
  if (outcome.awaitingFinalization) counts.awaitingFinalization += 1;
  if (outcome.autoFinalized) counts.autoFinalized += 1;
  if (outcome.reviewRequired) counts.reviewRequired += 1;
}

export async function executeAttendanceProcessorRun(runId: mongoose.Types.ObjectId) {
  const run = await AttendanceProcessorRun.findOneAndUpdate(
    { _id: runId, status: { $in: ["pending", "failed"] } },
    {
      $set: {
        status: "running",
        startedAt: new Date(),
        completedAt: null,
        lastError: "",
      },
    },
    { new: true }
  );
  if (!run) {
    const existing = await AttendanceProcessorRun.findById(runId);
    if (!existing) throw generateError("Attendance processor run not found", 404);
    if (["completed", "completed_with_errors"].includes(existing.status)) return existing;
    throw generateError("This attendance processor run is already running", 409);
  }

  const startedAt = Date.now();
  const persistedCounts: any = run.counts;
  const counts = {
    ...emptyCounts(),
    ...(persistedCounts?.toObject?.() || persistedCounts || {}),
  };
  const failures = [...(run.failures || [])] as any[];
  const versionCache = new Map<string, Promise<any>>();
  const attendanceRulesCache = new Map<string, Promise<any>>();

  try {
    await assertAttendanceDateWritable({
      company: run.company,
      attendanceDate: run.attendanceDate,
    });
    let checkpoint = run.checkpointEmployee || null;
    while (true) {
      const employees = await User.find({
        company: run.company,
        is_enabled: true,
        deletedAt: null,
        role: { $ne: "superadmin" },
        ...(checkpoint ? { _id: { $gt: checkpoint } } : {}),
      })
        .select("_id code joiningDate employmentEndDate createdAt deletedAt")
        .sort({ _id: 1 })
        .limit(run.batchSize)
        .lean();
      if (!employees.length) break;

      let nextEmployee = 0;
      const processNextEmployee = async (): Promise<void> => {
        const index = nextEmployee++;
        if (index >= employees.length) return;
        const employee = employees[index];
        try {
          const outcome = await processEmployeeDay({
            company: run.company,
            employee,
            attendanceDate: run.attendanceDate,
            actorId: run.requestedBy || null,
            now: new Date(),
            versionCache,
            attendanceRulesCache,
            finalizeClean: run.finalizeClean === true,
            finalizationReason: run.reason,
          });
          addResult(counts, outcome);
          if (outcome.result === "setup_gap" && failures.length < FAILURE_SAMPLE_LIMIT) {
            failures.push({
              employee: employee._id,
              employeeCode: employee.code || "",
              message: outcome.message || "Attendance setup is incomplete",
            });
          }
        } catch (error: any) {
          counts.scanned += 1;
          counts.failures += 1;
          if (failures.length < FAILURE_SAMPLE_LIMIT) {
            failures.push({
              employee: employee._id,
              employeeCode: employee.code || "",
              message: text(error?.message || "Attendance processing failed").slice(0, 500),
            });
          }
        }
        await processNextEmployee();
      };
      await Promise.all(
        Array.from(
          { length: Math.min(5, employees.length) },
          () => processNextEmployee()
        )
      );

      checkpoint = employees[employees.length - 1]._id;
      run.checkpointEmployee = checkpoint;
      run.counts = counts;
      run.failures = failures;
      await run.save();
    }

    run.status = counts.failures > 0 || counts.setupGaps > 0 || counts.reviewRequired > 0
      ? "completed_with_errors"
      : "completed";
    run.active = false;
    run.completedAt = new Date();
    run.durationMs = Date.now() - startedAt;
    run.counts = counts;
    run.failures = failures;
    await run.save();
    return run;
  } catch (error: any) {
    run.status = "failed";
    run.active = false;
    run.completedAt = new Date();
    run.durationMs = Date.now() - startedAt;
    run.lastError = text(error?.message || "Attendance processor failed").slice(0, 1000);
    run.counts = counts;
    run.failures = failures;
    await run.save();
    throw error;
  }
}

export function queueAttendanceProcessorRun(runId: mongoose.Types.ObjectId) {
  setImmediate(() => {
    executeAttendanceProcessorRun(runId).catch((error: any) => {
      console.error(
        `Attendance processor run ${runId} failed:`,
        error?.message || error
      );
    });
  });
}

export function queueAttendanceProcessorRunSeries(
  runIds: Array<mongoose.Types.ObjectId>
) {
  const queuedIds = [...runIds];
  if (!queuedIds.length) return;
  setImmediate(async () => {
    for (const runId of queuedIds) {
      try {
        await executeAttendanceProcessorRun(runId);
      } catch (error: any) {
        console.error(
          `Attendance processor run ${runId} failed:`,
          error?.message || error
        );
      }
    }
  });
}

function cycleDates(startDate: string, endDate: string) {
  const dates: string[] = [];
  let cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}

export async function prepareAttendanceCycleService(
  req: any,
  res: Response,
  next: NextFunction
) {
  try {
    const { actor, company } = processorRequestContext(req);
    if (!hasPermission(actor, PERMISSION_KEYS.FINALIZE_ATTENDANCE)) {
      throw generateError("You do not have permission to finalize attendance", 403);
    }
    const periodKey = parseAttendancePeriodKey(req.params.periodKey).periodKey;
    const reason = text(req.body?.reason);
    if (reason.length < 3 || reason.length > 1000) {
      throw generateError("Preparation reason must contain 3 to 1000 characters", 422);
    }
    const idempotencyKey = text(req.body?.idempotencyKey);
    if (idempotencyKey.length < 8 || idempotencyKey.length > 150) {
      throw generateError("Idempotency key must contain between 8 and 150 characters", 422);
    }

    const existingPeriod: any = await AttendancePeriod.findOne({ company, periodKey }).lean();
    if (existingPeriod?.status === "locked") {
      throw generateError("Reopen this attendance cycle before preparing it again", 409);
    }
    const range = existingPeriod
      ? {
          periodKey,
          startDate: existingPeriod.startDate,
          endDate: existingPeriod.endDate,
          attendanceCutoffDay: Number(existingPeriod.attendanceCutoffDay || 31),
        }
      : await resolveAttendanceCycleRange({ company, periodKey });
    const readiness = await loadPeriodReadiness({ company, ...range });
    if (!readiness.periodEnded) {
      throw generateError("Only an ended attendance cycle can be prepared", 409);
    }
    const unresolvedRequests =
      readiness.pendingRegularizations +
      readiness.pendingOvertimeReviews +
      readiness.pendingLeaveRequests +
      readiness.pendingLeaveCancellations +
      readiness.pendingRemoteWorkRequests;
    if (unresolvedRequests > 0) {
      throw generateError("Resolve pending attendance, overtime, leave, and WFH decisions before preparing this cycle", 409);
    }
    if (readiness.activeProcessorRuns > 0 || readiness.activeImportBatches > 0) {
      throw generateError("Wait for active attendance processing or imports to finish", 409);
    }

    const unfinalizedDates = await AttendanceRecord.distinct("attendanceDate", {
      company,
      attendanceDate: { $gte: range.startDate, $lte: range.endDate },
      state: { $ne: "finalized" },
    });
    const validDates = new Set(cycleDates(range.startDate, range.endDate));
    const targetDates = [...new Set([
      ...readiness.missingProcessorDates,
      ...readiness.problemProcessorDates,
      ...unfinalizedDates.map(String),
    ])]
      .filter((date) => validDates.has(date))
      .sort();

    const runIds: mongoose.Types.ObjectId[] = [];
    for (const attendanceDate of targetDates) {
      const runKey = `${idempotencyKey}:${attendanceDate}`;
      let run: any = await AttendanceProcessorRun.findOne({ company, idempotencyKey: runKey });
      if (!run) {
        try {
          run = await AttendanceProcessorRun.create({
            company,
            attendanceDate,
            idempotencyKey: runKey,
            trigger: "cycle_preparation",
            status: "pending",
            active: true,
            requestedBy: actor._id,
            batchSize: 100,
            finalizeClean: true,
            reason,
          });
        } catch (error: any) {
          if (error?.code !== 11000) throw error;
          run = await AttendanceProcessorRun.findOne({ company, idempotencyKey: runKey });
        }
      }
      if (run?.status === "pending") runIds.push(run._id);
    }
    queueAttendanceProcessorRunSeries(runIds);

    return res.status(runIds.length ? 202 : 200).json({
      success: true,
      message: runIds.length
        ? `${runIds.length} attendance day preparation run(s) queued`
        : "No attendance days require preparation",
      data: {
        periodKey,
        startDate: range.startDate,
        endDate: range.endDate,
        targetDates,
        queuedRuns: runIds.length,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function recoverPendingAttendanceProcessorRuns() {
  const staleBefore = new Date(Date.now() - 15 * 60_000);
  await AttendanceProcessorRun.updateMany(
    { status: "running", updatedAt: { $lt: staleBefore } },
    {
      $set: {
        status: "failed",
        active: false,
        completedAt: new Date(),
        lastError: "Processing stopped before completion. Resume this run from its checkpoint.",
      },
    }
  );
  const pending = await AttendanceProcessorRun.find({ status: "pending" })
    .sort({ createdAt: 1 })
    .limit(20)
    .select("_id")
    .lean();
  pending.forEach((run) => queueAttendanceProcessorRun(run._id));
  return pending.length;
}

export async function createAttendanceProcessorRunService(
  req: any,
  res: Response,
  next: NextFunction
) {
  try {
    const { actor, company } = processorRequestContext(req);
    const attendanceDate = parseAttendanceDate(text(req.body?.attendanceDate)).dateKey;
    const idempotencyKey = text(req.body?.idempotencyKey);
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw generateError("Idempotency key must contain between 8 and 200 characters", 422);
    }
    const batchSize = Number(req.body?.batchSize || 100);
    if (!Number.isInteger(batchSize) || batchSize < 10 || batchSize > 500) {
      throw generateError("Batch size must be between 10 and 500", 422);
    }
    await assertAttendanceDateWritable({ company, attendanceDate });

    let run = await AttendanceProcessorRun.findOne({ company, idempotencyKey });
    if (run) {
      if (run.status === "pending") queueAttendanceProcessorRun(run._id);
      return res.status(200).json({ success: true, replayed: true, data: run });
    }
    try {
      run = await AttendanceProcessorRun.create({
        company,
        attendanceDate,
        idempotencyKey,
        trigger: "manual",
        status: "pending",
        active: true,
        requestedBy: actor._id,
        batchSize,
      });
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      run = await AttendanceProcessorRun.findOne({ company, idempotencyKey });
      if (!run) {
        throw generateError("Another processor run is already active for this date", 409);
      }
      return res.status(200).json({ success: true, replayed: true, data: run });
    }

    queueAttendanceProcessorRun(run._id);
    return res.status(202).json({
      success: true,
      message: "Attendance day processing started",
      data: run,
    });
  } catch (error) {
    next(error);
  }
}

export async function resumeAttendanceProcessorRunService(
  req: any,
  res: Response,
  next: NextFunction
) {
  try {
    const { company } = processorRequestContext(req);
    const runId = objectId(req.params.runId, "processor run id");
    const run = await AttendanceProcessorRun.findOne({ _id: runId, company });
    if (!run) throw generateError("Attendance processor run not found", 404);
    if (run.status !== "failed") {
      throw generateError("Only a failed attendance processor run can be resumed", 409);
    }
    await assertAttendanceDateWritable({ company, attendanceDate: run.attendanceDate });
    run.status = "pending";
    run.active = true;
    run.completedAt = null;
    run.lastError = "";
    try {
      await run.save();
    } catch (error: any) {
      if (error?.code === 11000) {
        throw generateError("Another processor run is already active for this date", 409);
      }
      throw error;
    }
    queueAttendanceProcessorRun(run._id);
    return res.status(202).json({
      success: true,
      message: "Attendance day processing resumed",
      data: run,
    });
  } catch (error) {
    next(error);
  }
}

export async function getAttendanceProcessorRunService(
  req: any,
  res: Response,
  next: NextFunction
) {
  try {
    const { company } = processorRequestContext(req);
    const runId = objectId(req.params.runId, "processor run id");
    const run = await AttendanceProcessorRun.findOne({ _id: runId, company })
      .populate("requestedBy", "name code role")
      .lean();
    if (!run) throw generateError("Attendance processor run not found", 404);
    return res.status(200).json({ success: true, data: run });
  } catch (error) {
    next(error);
  }
}

export async function listAttendanceProcessorRunsService(
  req: any,
  res: Response,
  next: NextFunction
) {
  try {
    const { company } = processorRequestContext(req);
    const page = Math.max(1, Number(req.query?.page || 1));
    const limit = Math.min(50, Math.max(1, Number(req.query?.limit || 10)));
    const query: any = { company };
    if (req.query?.attendanceDate) {
      query.attendanceDate = parseAttendanceDate(text(req.query.attendanceDate)).dateKey;
    }
    const [items, total] = await Promise.all([
      AttendanceProcessorRun.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("requestedBy", "name code role")
        .lean(),
      AttendanceProcessorRun.countDocuments(query),
    ]);
    return res.status(200).json({
      success: true,
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    next(error);
  }
}
