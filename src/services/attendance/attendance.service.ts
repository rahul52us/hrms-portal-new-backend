import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceRecord, {
  ATTENDANCE_RECORD_STATUSES,
} from "../../schemas/Attendance/AttendanceRecord.schema";
import AttendanceRecordRevision from "../../schemas/Attendance/AttendanceRecordRevision.schema";
import AttendanceRegularizationRequest from "../../schemas/Attendance/AttendanceRegularizationRequest.schema";
import AttendancePolicyVersion from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import RemoteWorkRequest from "../../schemas/Request/RemoteWorkRequest.schema";
import User from "../../schemas/User/User";
import { calculateAttendance } from "./attendanceCalculator.utils";
import {
  buildFinalPunchSession,
  isPunchOutAllowedForAttendanceDay,
  previousAttendanceDate,
} from "./attendancePunch.utils";
import { resolveEmployeeDayContext } from "./employeeDayContext.service";
import { parseAttendanceDate } from "./employeeDayContext.utils";

const DEFAULT_TIMEZONE = "Asia/Kolkata";

function text(value: unknown) {
  return String(value || "").trim();
}

function actorDetails(req: any) {
  const source = req?.user || req?.bodyData || {};
  const employeeId = text(req?.userId || source?._id);
  const companyId = text(source?.company || source?.companyId);
  if (!mongoose.Types.ObjectId.isValid(employeeId)) {
    throw generateError("Authenticated user is invalid", 401);
  }
  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    throw generateError("Your account is not assigned to a company", 403);
  }
  return {
    employeeId: new mongoose.Types.ObjectId(employeeId),
    companyId: new mongoose.Types.ObjectId(companyId),
  };
}

function dateKeyInTimezone(value: Date, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value || "";
    const result = `${part("year")}-${part("month")}-${part("day")}`;
    parseAttendanceDate(result);
    return result;
  } catch {
    return value.toISOString().slice(0, 10);
  }
}

function validTimezone(value: unknown) {
  const timezone = text(value) || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

async function resolveCurrentContext(options: {
  companyId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  now: Date;
}) {
  const initialDate = dateKeyInTimezone(options.now, DEFAULT_TIMEZONE);
  let context = await resolveEmployeeDayContext({
    companyId: options.companyId,
    employeeId: options.employeeId,
    attendanceDate: initialDate,
  });
  const timezone = validTimezone(context.timezone);
  const localDate = dateKeyInTimezone(options.now, timezone);
  if (localDate !== initialDate) {
    context = await resolveEmployeeDayContext({
      companyId: options.companyId,
      employeeId: options.employeeId,
      attendanceDate: localDate,
    });
  }
  return { context, attendanceDate: localDate, timezone: validTimezone(context.timezone) };
}

function ensurePunchPolicies(context: any) {
  if (!context?.policies?.attendancePolicy?.version) {
    throw generateError("No attendance policy is effective for today", 422);
  }
  if (!context?.policies?.workSchedule?.version) {
    throw generateError("No work schedule is effective for today", 422);
  }
}

function optionalObjectId(value: unknown) {
  const normalized = text((value as any)?._id || value);
  return mongoose.Types.ObjectId.isValid(normalized)
    ? new mongoose.Types.ObjectId(normalized)
    : null;
}

function contextSnapshots(context: any) {
  const assignment = context.organizationAssignment || {};
  const attendanceReference = context.policyReferences?.attendancePolicy || {};
  const scheduleReference = context.policyReferences?.workSchedule || {};
  const holidayReference = context.policyReferences?.holidayCalendar || {};
  return {
    dayTypeSnapshot: context.dayType || "unconfigured",
    requiresAttendanceSnapshot:
      typeof context.requiresAttendance === "boolean" ? context.requiresAttendance : null,
    expectedWorkMinutesSnapshot:
      Number.isFinite(Number(context.expectedWorkMinutes))
        ? Number(context.expectedWorkMinutes)
        : null,
    scheduleStartTimeSnapshot: context.schedule?.startTime || "",
    scheduleEndTimeSnapshot: context.schedule?.endTime || "",
    employeeAssignmentHistory: optionalObjectId(assignment._id),
    department: optionalObjectId(assignment.department),
    departmentNameSnapshot: text(assignment.departmentNameSnapshot),
    teamId: optionalObjectId(assignment.teamId),
    teamNameSnapshot: text(assignment.teamNameSnapshot),
    officeLocation: optionalObjectId(assignment.officeLocation),
    officeLocationNameSnapshot: text(assignment.officeLocationNameSnapshot),
    designationSnapshot: text(assignment.designationSnapshot),
    reportingManager: optionalObjectId(assignment.reportingManager),
    reportingManagerNameSnapshot: text(assignment.reportingManagerNameSnapshot),
    roleSnapshot: text(assignment.roleSnapshot),
    isDepartmentHead: assignment.isDepartmentHead === true,
    attendancePolicyAssignment: optionalObjectId(attendanceReference.assignmentId),
    attendancePolicy: optionalObjectId(attendanceReference.resourceId),
    attendancePolicyVersion: optionalObjectId(attendanceReference.versionId),
    workScheduleAssignment: optionalObjectId(scheduleReference.assignmentId),
    workSchedule: optionalObjectId(scheduleReference.resourceId),
    workScheduleVersion: optionalObjectId(scheduleReference.versionId),
    holidayCalendarAssignment: optionalObjectId(holidayReference.assignmentId),
    holidayCalendar: optionalObjectId(holidayReference.resourceId),
    holidayCalendarVersion: optionalObjectId(holidayReference.versionId),
    policyResolvedAt: new Date(),
  };
}

async function approvedRemoteWorkAuthorization(options: {
  companyId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  attendanceDate: string;
}) {
  const request = await RemoteWorkRequest.findOne({
    company: options.companyId,
    employee: options.employeeId,
    status: "approved",
    "dates.attendanceDate": options.attendanceDate,
  })
    .select(
      "_id fromDate toDate dates remoteWorkPolicyAssignment remoteWorkPolicy remoteWorkPolicyVersion remoteWorkPolicyVersionNumber"
    )
    .lean();
  if (!request) return null;
  const day = request.dates.find((item: any) => item.attendanceDate === options.attendanceDate);
  if (!day) return null;
  return {
    requestId: request._id,
    portion: day.portion,
    workMode: day.portion === "full" ? "remote" : "hybrid",
    remoteWorkPolicyAssignment: request.remoteWorkPolicyAssignment,
    remoteWorkPolicy: request.remoteWorkPolicy,
    remoteWorkPolicyVersion: request.remoteWorkPolicyVersion,
    remoteWorkPolicyVersionNumber: request.remoteWorkPolicyVersionNumber,
  };
}

function remoteWorkRecordFields(authorization: any) {
  if (!authorization) {
    return {
      workMode: "office",
      workModeSource: "default",
    };
  }
  return {
    workMode: authorization.workMode,
    workModeSource: "remote_work_request",
    remoteWorkRequest: authorization.requestId,
    remoteWorkPortion: authorization.portion,
    remoteWorkPolicyAssignment: authorization.remoteWorkPolicyAssignment,
    remoteWorkPolicy: authorization.remoteWorkPolicy,
    remoteWorkPolicyVersion: authorization.remoteWorkPolicyVersion,
  };
}

function punchLocation(body: any) {
  const latitude = body?.latitude === undefined || body?.latitude === null || body?.latitude === ""
    ? null
    : Number(body.latitude);
  const longitude = body?.longitude === undefined || body?.longitude === null || body?.longitude === ""
    ? null
    : Number(body.longitude);
  if (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) {
    throw generateError("Latitude must be between -90 and 90", 422);
  }
  if (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
    throw generateError("Longitude must be between -180 and 180", 422);
  }
  if ((latitude === null) !== (longitude === null)) {
    throw generateError("Latitude and longitude must be provided together", 422);
  }
  return { latitude, longitude };
}

function sessionPayload(req: any, now: Date) {
  const location = punchLocation(req.body || {});
  return {
    punchIn: now,
    punchOut: null,
    source: "web" as const,
    ...location,
    deviceInfo: text(req.body?.deviceInfo || req.headers?.["user-agent"]).slice(0, 500),
  };
}

async function calculationRules(record: any, context: any) {
  const versionId = optionalObjectId(record.attendancePolicyVersion);
  const storedVersion = versionId
    ? await AttendancePolicyVersion.findOne({
        _id: versionId,
        company: record.company,
      })
        .select("rules")
        .lean()
    : null;
  return storedVersion?.rules || context.policies?.attendancePolicy?.version?.rules || {};
}

async function calculateAndPersist(record: any, context: any) {
  const attendanceRules = await calculationRules(record, context);
  const calculation = calculateAttendance({
    attendanceDate: record.attendanceDate,
    timezone: validTimezone(record.timezone),
    punchSessions: record.punchSessions || [],
    attendanceRules,
    schedule: {
      startTime: record.scheduleStartTimeSnapshot || context.schedule?.startTime,
      endTime: record.scheduleEndTimeSnapshot || context.schedule?.endTime,
    },
    requiresAttendance:
      typeof record.requiresAttendanceSnapshot === "boolean"
        ? record.requiresAttendanceSnapshot
        : context.requiresAttendance,
    expectedWorkMinutes:
      Number.isFinite(Number(record.expectedWorkMinutesSnapshot))
        ? Number(record.expectedWorkMinutesSnapshot)
        : context.expectedWorkMinutes,
    defaultAttendanceStatus: context.defaultAttendanceStatus,
  });
  const updated = await AttendanceRecord.findOneAndUpdate(
    { _id: record._id, company: record.company, revisionNumber: record.revisionNumber },
    {
      $set: {
        state: calculation.state,
        status: calculation.status,
        workedMinutes: calculation.workedMinutes,
        breakMinutes: calculation.breakMinutes,
        lateMinutes: calculation.lateMinutes,
        earlyExitMinutes: calculation.earlyExitMinutes,
        overtimeMinutes: calculation.overtimeMinutes,
        isLate: calculation.isLate,
        isEarlyExit: calculation.isEarlyExit,
        hasMissingPunch: calculation.hasMissingPunch,
        calculatedAt: new Date(),
        calculationReason: "punch_update",
      },
      $inc: { calculationVersion: 1 },
    },
    { new: true, runValidators: true }
  );
  return updated || AttendanceRecord.findById(record._id);
}

async function appendPunchRevision(options: {
  record: any;
  actorId: mongoose.Types.ObjectId;
  operation: "punch_in" | "punch_out";
  occurredAt: Date;
  previousPunchOut?: Date | null;
}) {
  try {
    await AttendanceRecordRevision.updateOne(
      {
        company: options.record.company,
        attendanceRecord: options.record._id,
        revisionNumber: options.record.revisionNumber,
      },
      {
        $setOnInsert: {
          employee: options.record.employee,
          action: "punch_recorded",
          reason:
            options.operation === "punch_in"
              ? "Employee punched in"
              : options.previousPunchOut
                ? "Employee updated final punch-out"
                : "Employee punched out",
          changes: {
            operation: options.operation,
            occurredAt: options.occurredAt,
            ...(options.previousPunchOut
              ? { previousPunchOut: options.previousPunchOut }
              : {}),
          },
          snapshot: options.record.toObject ? options.record.toObject() : options.record,
          actor: options.actorId,
          source: "punch",
        },
      },
      { upsert: true }
    );
  } catch (error) {
    console.error("Could not persist attendance revision", error);
  }
}

function pagination(query: any) {
  const page = query?.page === undefined || query?.page === "" ? 1 : Number(query.page);
  const limit = query?.limit === undefined || query?.limit === "" ? 20 : Number(query.limit);
  if (!Number.isSafeInteger(page) || page < 1) throw generateError("Invalid attendance page", 400);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw generateError("Attendance limit must be between 1 and 100", 400);
  }
  return { page, limit, skip: (page - 1) * limit };
}

function parseOptionalDate(value: unknown, label: string) {
  if (!text(value)) return null;
  return parseAttendanceDate(text(value)).dateKey;
}

function canPunchOutForAttendanceDate(record: any, currentAttendanceDate: string) {
  return Boolean(
    record &&
      isPunchOutAllowedForAttendanceDay({
        attendanceDate: record.attendanceDate,
        currentAttendanceDate,
        scheduleStartTime: record.scheduleStartTimeSnapshot,
        scheduleEndTime: record.scheduleEndTimeSnapshot,
      })
  );
}

export async function getTodayAttendanceService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = actorDetails(req);
    const now = new Date();
    const { context, attendanceDate, timezone } = await resolveCurrentContext({ ...actor, now });
    const recentAttendanceDates = [attendanceDate, previousAttendanceDate(attendanceDate)].filter(Boolean);
    const [record, activeRecordCandidate, remoteWorkAuthorization] = await Promise.all([
      AttendanceRecord.findOne({
        company: actor.companyId,
        employee: actor.employeeId,
        attendanceDate,
      }).lean(),
      AttendanceRecord.findOne({
        company: actor.companyId,
        employee: actor.employeeId,
        attendanceDate: { $in: recentAttendanceDates },
        state: { $ne: "finalized" },
        punchSessions: { $elemMatch: { punchIn: { $ne: null }, punchOut: null } },
      })
        .sort({ attendanceDate: -1 })
        .lean(),
      approvedRemoteWorkAuthorization({ ...actor, attendanceDate }),
    ]);
    const activeRecord = canPunchOutForAttendanceDate(activeRecordCandidate, attendanceDate)
      ? activeRecordCandidate
      : null;
    const effectiveRecord = activeRecord || record;
    const effectivePunchIn = effectiveRecord?.punchSessions?.find(
      (session: any) => Boolean(session?.punchIn)
    );
    const todayHasPunchIn = record?.punchSessions?.some(
      (session: any) => Boolean(session?.punchIn)
    );
    return res.status(200).json({
      success: true,
      data: {
        attendanceDate,
        timezone,
        record: effectiveRecord,
        context: {
          dayType: context.dayType,
          requiresAttendance: context.requiresAttendance,
          expectedWorkMinutes: context.expectedWorkMinutes,
          defaultAttendanceStatus: context.defaultAttendanceStatus,
          schedule: context.schedule,
          holiday: context.holiday,
          missingPolicies: context.missingPolicies.filter((item: string) =>
            ["attendance_policy", "work_schedule", "holiday_calendar"].includes(item)
          ),
          warnings: context.warnings,
        },
        remoteWorkAuthorization,
        actions: {
          canPunchIn: Boolean(
            !activeRecord &&
              !todayHasPunchIn &&
              record?.state !== "finalized" &&
              !record?.leaveRequest &&
              context.policies?.attendancePolicy?.version &&
              context.policies?.workSchedule?.version
          ),
          canPunchOut: Boolean(
            effectivePunchIn &&
              effectiveRecord?.state !== "finalized" &&
              !effectiveRecord?.leaveRequest
          ),
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function punchInService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = actorDetails(req);
    const now = new Date();
    const { context, attendanceDate, timezone } = await resolveCurrentContext({ ...actor, now });
    ensurePunchPolicies(context);
    const recentAttendanceDates = [attendanceDate, previousAttendanceDate(attendanceDate)].filter(Boolean);
    const activeRecordCandidate = await AttendanceRecord.findOne({
      company: actor.companyId,
      employee: actor.employeeId,
      attendanceDate: { $in: recentAttendanceDates },
      state: { $ne: "finalized" },
      punchSessions: { $elemMatch: { punchIn: { $ne: null }, punchOut: null } },
    })
      .sort({ attendanceDate: -1 })
      .lean();
    const activeRecord = canPunchOutForAttendanceDate(activeRecordCandidate, attendanceDate)
      ? activeRecordCandidate
      : null;
    if (activeRecord) {
      throw generateError(
        `You are already punched in for ${activeRecord.attendanceDate}`,
        409
      );
    }

    const remoteWorkAuthorization = await approvedRemoteWorkAuthorization({
      ...actor,
      attendanceDate,
    });
    const existing = await AttendanceRecord.findOne({
      company: actor.companyId,
      employee: actor.employeeId,
      attendanceDate,
    });
    if (existing?.state === "finalized") {
      throw generateError("Today's attendance is finalized and cannot accept punches", 409);
    }
    if (existing?.leaveRequest) {
      throw generateError("Approved leave exists for today. Cancel the leave before punching in", 409);
    }
    if (existing?.punchSessions?.length) {
      throw generateError(
        "You have already punched in today. Use punch out to update your final punch-out time",
        409
      );
    }

    const session = sessionPayload(req, now);
    let mutated: any;
    if (existing) {
      mutated = await AttendanceRecord.findOneAndUpdate(
        {
          _id: existing._id,
          company: actor.companyId,
          employee: actor.employeeId,
          revisionNumber: existing.revisionNumber,
          state: { $ne: "finalized" },
          punchSessions: { $size: 0 },
        },
        {
          $set: {
            punchSessions: [session],
            state: "open",
            status: "pending",
            source: "punch",
            updatedBy: actor.employeeId,
            ...(existing.workModeSource === "manual"
              ? {}
              : remoteWorkRecordFields(remoteWorkAuthorization)),
          },
          $inc: { revisionNumber: 1 },
        },
        { new: true, runValidators: true }
      );
      if (!mutated) throw generateError("Attendance changed while punching in. Refresh and try again", 409);
    } else {
      try {
        mutated = await AttendanceRecord.create({
          company: actor.companyId,
          employee: actor.employeeId,
          attendanceDate,
          timezone,
          state: "open",
          status: "pending",
          ...remoteWorkRecordFields(remoteWorkAuthorization),
          punchSessions: [session],
          revisionNumber: 1,
          calculationVersion: 0,
          source: "punch",
          createdBy: actor.employeeId,
          updatedBy: actor.employeeId,
          ...contextSnapshots(context),
        });
      } catch (error: any) {
        if (error?.code === 11000) {
          throw generateError("Attendance changed while punching in. Refresh and try again", 409);
        }
        throw error;
      }
    }
    const calculated = await calculateAndPersist(mutated, context);
    await appendPunchRevision({ record: calculated, actorId: actor.employeeId, operation: "punch_in", occurredAt: now });
    return res.status(201).json({ success: true, data: calculated, message: "Punched in" });
  } catch (error) {
    next(error);
  }
}

export async function punchOutService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = actorDetails(req);
    const now = new Date();
    const { attendanceDate } = await resolveCurrentContext({ ...actor, now });
    const recentAttendanceDates = [attendanceDate, previousAttendanceDate(attendanceDate)].filter(Boolean);
    const openRecordCandidate = await AttendanceRecord.findOne({
      company: actor.companyId,
      employee: actor.employeeId,
      attendanceDate: { $in: recentAttendanceDates },
      state: { $ne: "finalized" },
      punchSessions: { $elemMatch: { punchIn: { $ne: null }, punchOut: null } },
    }).sort({ attendanceDate: -1 });
    const openRecord = canPunchOutForAttendanceDate(openRecordCandidate, attendanceDate)
      ? openRecordCandidate
      : null;
    const record =
      openRecord ||
      (await AttendanceRecord.findOne({
        company: actor.companyId,
        employee: actor.employeeId,
        attendanceDate,
        state: { $ne: "finalized" },
        punchSessions: { $elemMatch: { punchIn: { $ne: null } } },
      }));
    if (!record) {
      throw generateError("Punch-out is available only for the current attendance day", 409);
    }

    const punchUpdate = buildFinalPunchSession(record.punchSessions || [], now);
    if (!punchUpdate) throw generateError("Punch in before recording punch-out", 409);
    if (now.getTime() < punchUpdate.session.punchIn.getTime()) {
      throw generateError("Punch-out cannot be earlier than punch-in", 409);
    }

    const context = await resolveEmployeeDayContext({
      companyId: actor.companyId,
      employeeId: actor.employeeId,
      attendanceDate: record.attendanceDate,
    });
    const mutated = await AttendanceRecord.findOneAndUpdate(
      {
        _id: record._id,
        company: actor.companyId,
        employee: actor.employeeId,
        revisionNumber: record.revisionNumber,
        state: { $ne: "finalized" },
      },
      {
        $set: {
          punchSessions: [punchUpdate.session],
          source: "punch",
          updatedBy: actor.employeeId,
        },
        $inc: { revisionNumber: 1 },
      },
      {
        new: true,
        runValidators: true,
      }
    );
    if (!mutated) throw generateError("Attendance changed while punching out. Refresh and try again", 409);
    const calculated = await calculateAndPersist(mutated, context);
    await appendPunchRevision({
      record: calculated,
      actorId: actor.employeeId,
      operation: "punch_out",
      occurredAt: now,
      previousPunchOut: punchUpdate.previousPunchOut,
    });
    return res.status(200).json({
      success: true,
      data: calculated,
      message: punchUpdate.previousPunchOut ? "Final punch-out updated" : "Punched out",
    });
  } catch (error) {
    next(error);
  }
}

export async function listMyAttendanceService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = actorDetails(req);
    const { page, limit, skip } = pagination(req.query);
    const from = parseOptionalDate(req.query?.from, "from date");
    const to = parseOptionalDate(req.query?.to, "to date");
    if (from && to && from > to) throw generateError("from date cannot be after to date", 400);
    const match: any = { company: actor.companyId, employee: actor.employeeId };
    if (from || to) {
      match.attendanceDate = {};
      if (from) match.attendanceDate.$gte = from;
      if (to) match.attendanceDate.$lte = to;
    }
    const status = text(req.query?.status || "all").toLowerCase();
    if (status !== "all") {
      if (!(ATTENDANCE_RECORD_STATUSES as readonly string[]).includes(status)) {
        throw generateError("Invalid attendance status filter", 400);
      }
      match.status = status;
    }
    const [items, total, summaryRows] = await Promise.all([
      AttendanceRecord.find(match).sort({ attendanceDate: -1 }).skip(skip).limit(limit).lean(),
      AttendanceRecord.countDocuments(match),
      AttendanceRecord.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            recordedDays: { $sum: 1 },
            presentDays: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
            halfDayDays: { $sum: { $cond: [{ $eq: ["$status", "half_day"] }, 1, 0] } },
            absentDays: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
            incompleteDays: { $sum: { $cond: [{ $eq: ["$status", "incomplete"] }, 1, 0] } },
            leaveDays: { $sum: { $cond: [{ $eq: ["$status", "leave"] }, 1, 0] } },
            holidayDays: { $sum: { $cond: [{ $eq: ["$status", "holiday"] }, 1, 0] } },
            weeklyOffDays: { $sum: { $cond: [{ $eq: ["$status", "weekly_off"] }, 1, 0] } },
            workedMinutes: { $sum: "$workedMinutes" },
            lateDays: { $sum: { $cond: ["$isLate", 1, 0] } },
          },
        },
      ]),
    ]);
    const regularizations = items.length
      ? await AttendanceRegularizationRequest.find({
          company: actor.companyId,
          employee: actor.employeeId,
          attendanceDate: { $in: items.map((item) => item.attendanceDate) },
        })
          .sort({ submittedAt: -1 })
          .select("attendanceDate correctionType status submittedAt appliedRevisionNumber")
          .lean()
      : [];
    const regularizationByDate = new Map<string, any>();
    regularizations.forEach((request: any) => {
      if (!regularizationByDate.has(request.attendanceDate)) {
        regularizationByDate.set(request.attendanceDate, request);
      }
    });
    const data = items.map((item: any) => ({
      ...item,
      regularization: regularizationByDate.get(item.attendanceDate) || null,
    }));
    const summary = summaryRows[0] || {
      recordedDays: 0,
      presentDays: 0,
      halfDayDays: 0,
      absentDays: 0,
      incompleteDays: 0,
      leaveDays: 0,
      holidayDays: 0,
      weeklyOffDays: 0,
      workedMinutes: 0,
      lateDays: 0,
    };
    delete summary._id;
    return res.status(200).json({
      success: true,
      data,
      summary,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}

function monthlyRange(value: unknown) {
  const month = text(value);
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw generateError("Attendance statement month must use YYYY-MM format", 400);
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (year < 2000 || year > 2200 || monthNumber < 1 || monthNumber > 12) {
    throw generateError("Invalid attendance statement month", 400);
  }
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    month,
    from: `${month}-01`,
    to: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

export function attendanceCsvCell(value: unknown) {
  const normalized = String(value ?? "");
  return /[",\r\n]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
}

function attendanceCsvTime(value: unknown) {
  if (!value) return "";
  const parsed = new Date(value as any);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

export function buildAttendanceStatementCsv(records: any[]) {
  const headers = [
    "Date",
    "Day",
    "Status",
    "Day type",
    "Work mode",
    "First punch in",
    "Final punch out",
    "Worked minutes",
    "Late minutes",
    "Early exit minutes",
    "Overtime minutes",
    "Location",
    "Record state",
  ];
  const rows = records.map((record) => {
    const sessions = Array.isArray(record.punchSessions) ? record.punchSessions : [];
    const firstPunch = sessions.find((session: any) => session?.punchIn)?.punchIn;
    const finalPunch = [...sessions].reverse().find((session: any) => session?.punchOut)?.punchOut;
    const date = String(record.attendanceDate || "");
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
          new Date(`${date}T00:00:00Z`)
        )
      : "";
    return [
      date,
      day,
      record.status,
      record.dayTypeSnapshot,
      record.workMode,
      attendanceCsvTime(firstPunch),
      attendanceCsvTime(finalPunch),
      Number(record.workedMinutes || 0),
      Number(record.lateMinutes || 0),
      Number(record.earlyExitMinutes || 0),
      Number(record.overtimeMinutes || 0),
      record.officeLocationNameSnapshot || "",
      record.state,
    ];
  });
  return [headers, ...rows].map((row) => row.map(attendanceCsvCell).join(",")).join("\r\n");
}

export async function downloadMyAttendanceStatementService(
  req: any,
  res: Response,
  next: NextFunction
) {
  try {
    const actor = actorDetails(req);
    const range = monthlyRange(req.query?.month);
    const [employee, records] = await Promise.all([
      User.findOne({ _id: actor.employeeId, company: actor.companyId })
        .select("name code")
        .lean(),
      AttendanceRecord.find({
        company: actor.companyId,
        employee: actor.employeeId,
        attendanceDate: { $gte: range.from, $lte: range.to },
      })
        .sort({ attendanceDate: 1 })
        .lean(),
    ]);
    if (!employee) throw generateError("Employee account was not found", 404);
    const csv = buildAttendanceStatementCsv(records);
    const employeeCode = text((employee as any).code || "employee").replace(/[^a-zA-Z0-9_-]/g, "-");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="attendance-${employeeCode}-${range.month}.csv"`
    );
    return res.status(200).send(`\uFEFF${csv}`);
  } catch (error) {
    next(error);
  }
}
