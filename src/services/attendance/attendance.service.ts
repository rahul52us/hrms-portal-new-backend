import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";
import AttendanceRecordRevision from "../../schemas/Attendance/AttendanceRecordRevision.schema";
import AttendancePolicyVersion from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import RemoteWorkRequest from "../../schemas/Request/RemoteWorkRequest.schema";
import { calculateAttendance } from "./attendanceCalculator.utils";
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
          reason: options.operation === "punch_in" ? "Employee punched in" : "Employee punched out",
          changes: { operation: options.operation, occurredAt: options.occurredAt },
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
  const page = Math.max(1, Number(query?.page || 1));
  const limit = Math.max(1, Math.min(100, Number(query?.limit || 20)));
  return { page, limit, skip: (page - 1) * limit };
}

function parseOptionalDate(value: unknown, label: string) {
  if (!text(value)) return null;
  return parseAttendanceDate(text(value)).dateKey;
}

export async function getTodayAttendanceService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = actorDetails(req);
    const now = new Date();
    const { context, attendanceDate, timezone } = await resolveCurrentContext({ ...actor, now });
    const [record, activeRecord, remoteWorkAuthorization] = await Promise.all([
      AttendanceRecord.findOne({
        company: actor.companyId,
        employee: actor.employeeId,
        attendanceDate,
      }).lean(),
      AttendanceRecord.findOne({
        company: actor.companyId,
        employee: actor.employeeId,
        state: { $ne: "finalized" },
        punchSessions: { $elemMatch: { punchIn: { $ne: null }, punchOut: null } },
      })
        .sort({ attendanceDate: -1 })
        .lean(),
      approvedRemoteWorkAuthorization({ ...actor, attendanceDate }),
    ]);
    const effectiveRecord = activeRecord || record;
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
          missingPolicies: context.missingPolicies,
          warnings: context.warnings,
        },
        remoteWorkAuthorization,
        actions: {
          canPunchIn: Boolean(
            !activeRecord &&
              record?.state !== "finalized" &&
              !record?.leaveRequest &&
              context.policies?.attendancePolicy?.version &&
              context.policies?.workSchedule?.version
          ),
          canPunchOut: Boolean(activeRecord),
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
    const activeRecord = await AttendanceRecord.findOne({
      company: actor.companyId,
      employee: actor.employeeId,
      state: { $ne: "finalized" },
      punchSessions: { $elemMatch: { punchIn: { $ne: null }, punchOut: null } },
    }).lean();
    if (activeRecord) {
      throw generateError(
        `You are already punched in for ${activeRecord.attendanceDate}`,
        409
      );
    }

    const rules = context.policies.attendancePolicy?.version?.rules || {};
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
    if (existing?.punchSessions?.length && rules.allowMultiplePunches !== true) {
      throw generateError("Multiple punch sessions are disabled by your attendance policy", 409);
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
          punchSessions: { $not: { $elemMatch: { punchIn: { $ne: null }, punchOut: null } } },
        },
        {
          $push: { punchSessions: session },
          $set: {
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
    const record = await AttendanceRecord.findOne({
      company: actor.companyId,
      employee: actor.employeeId,
      state: { $ne: "finalized" },
      punchSessions: { $elemMatch: { punchIn: { $ne: null }, punchOut: null } },
    }).sort({ attendanceDate: -1 });
    if (!record) throw generateError("No open punch session was found", 409);

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
        punchSessions: { $elemMatch: { punchIn: { $ne: null }, punchOut: null } },
      },
      {
        $set: {
          "punchSessions.$[openSession].punchOut": now,
          source: "punch",
          updatedBy: actor.employeeId,
        },
        $inc: { revisionNumber: 1 },
      },
      {
        new: true,
        runValidators: true,
        arrayFilters: [{ "openSession.punchIn": { $ne: null }, "openSession.punchOut": null }],
      }
    );
    if (!mutated) throw generateError("Attendance changed while punching out. Refresh and try again", 409);
    const calculated = await calculateAndPersist(mutated, context);
    await appendPunchRevision({ record: calculated, actorId: actor.employeeId, operation: "punch_out", occurredAt: now });
    return res.status(200).json({ success: true, data: calculated, message: "Punched out" });
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
    const [items, total] = await Promise.all([
      AttendanceRecord.find(match).sort({ attendanceDate: -1 }).skip(skip).limit(limit).lean(),
      AttendanceRecord.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: items,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}
