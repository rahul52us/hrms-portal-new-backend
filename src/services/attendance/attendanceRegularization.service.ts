import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";
import AttendanceRecordRevision from "../../schemas/Attendance/AttendanceRecordRevision.schema";
import AttendanceRegularizationRequest from "../../schemas/Attendance/AttendanceRegularizationRequest.schema";
import LeaveAttachment from "../../schemas/Leave/LeaveAttachment.schema";
import AttendancePolicyVersion, {
  ATTENDANCE_REGULARIZATION_TYPES,
} from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import {
  approveApprovalInstance,
  cancelApprovalInstance,
  createApprovalInstance,
  rejectApprovalInstance,
} from "../approval/approvalEngine.service";
import {
  buildLeaveRequestScope,
  getLeaveActor,
  isEmployeeInActorScope,
  resolveEmployeeRequestCompanyId,
} from "../leave/leaveAccess.utils";
import { createRequestNotifications } from "../notification/notification.service";
import { PERMISSION_KEYS } from "../permissions/permission.utils";
import { calculateAttendance } from "./attendanceCalculator.utils";
import { resolveEmployeeDayContext } from "./employeeDayContext.service";
import { parseAttendanceDate } from "./employeeDayContext.utils";

function text(value: unknown) {
  return String(value || "").trim();
}

function objectId(value: unknown, label: string) {
  const normalized = text((value as any)?._id || value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function optionalObjectId(value: unknown) {
  const normalized = text((value as any)?._id || value);
  return mongoose.Types.ObjectId.isValid(normalized)
    ? new mongoose.Types.ObjectId(normalized)
    : null;
}

function pagination(query: any) {
  const page = Math.max(1, Number(query?.page || 1));
  const limit = Math.max(1, Math.min(50, Number(query?.limit || 20)));
  return { page, limit, skip: (page - 1) * limit };
}

function dateKeyInTimezone(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addDays(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string) {
  return Math.floor(
    (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) /
      86_400_000
  );
}

function timezoneParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value || 0);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

export function localAttendanceTimeToUtc(dateKey: string, time: unknown, timezone: string, nextDay = false) {
  const match = /^(\d{2}):(\d{2})$/.exec(text(time));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw generateError("Enter a valid time", 422);
  }
  const targetDate = addDays(dateKey, nextDay ? 1 : 0);
  const [year, month, day] = targetDate.split("-").map(Number);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = new Date(desired);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = timezoneParts(candidate, timezone);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    candidate = new Date(candidate.getTime() + desired - represented);
  }
  const final = timezoneParts(candidate, timezone);
  if (
    final.year !== year || final.month !== month || final.day !== day ||
    final.hour !== hour || final.minute !== minute
  ) {
    throw generateError("The selected local time does not exist in the attendance timezone", 422);
  }
  return candidate;
}

async function resolveAttachments(value: unknown, company: mongoose.Types.ObjectId, actorId: mongoose.Types.ObjectId) {
  if (!Array.isArray(value)) return [];
  if (value.length > 5) throw generateError("Attach at most 5 supporting documents", 422);
  const ids = value.map((item: any) => objectId(item?._id || item?.attachment || item, "attachment id"));
  if (new Set(ids.map(String)).size !== ids.length) throw generateError("Each attachment can be used once", 422);
  const records = await LeaveAttachment.find({
    _id: { $in: ids },
    company,
    uploadedBy: actorId,
    linkedRequest: null,
  }).lean();
  if (records.length !== ids.length) throw generateError("One or more attachments are unavailable", 422);
  const byId = new Map(records.map((item) => [String(item._id), item]));
  return ids.map((attachment) => {
    const item = byId.get(String(attachment))!;
    return { attachment, name: item.name, url: item.url, type: item.type, size: item.size };
  });
}

export function contextSnapshotFields(context: any) {
  const assignment = context.organizationAssignment || {};
  const attendance = context.policyReferences?.attendancePolicy || {};
  const schedule = context.policyReferences?.workSchedule || {};
  const holiday = context.policyReferences?.holidayCalendar || {};
  return {
    dayTypeSnapshot: context.dayType || "unconfigured",
    requiresAttendanceSnapshot: typeof context.requiresAttendance === "boolean" ? context.requiresAttendance : null,
    expectedWorkMinutesSnapshot: Number.isFinite(Number(context.expectedWorkMinutes)) ? Number(context.expectedWorkMinutes) : null,
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
    attendancePolicyAssignment: optionalObjectId(attendance.assignmentId),
    attendancePolicy: optionalObjectId(attendance.resourceId),
    attendancePolicyVersion: optionalObjectId(attendance.versionId),
    workScheduleAssignment: optionalObjectId(schedule.assignmentId),
    workSchedule: optionalObjectId(schedule.resourceId),
    workScheduleVersion: optionalObjectId(schedule.versionId),
    holidayCalendarAssignment: optionalObjectId(holiday.assignmentId),
    holidayCalendar: optionalObjectId(holiday.resourceId),
    holidayCalendarVersion: optionalObjectId(holiday.versionId),
    policyResolvedAt: new Date(),
  };
}

function event(actor: any, action: string, comment?: string) {
  return {
    action,
    actor: actor._id,
    actorRole: actor.role,
    comment: text(comment) || undefined,
    at: new Date(),
  };
}

function syncApproval(request: any, approval: any) {
  request.approvalInstance = approval.instance._id;
  request.currentApprovers = approval.currentApprovers;
  request.approver = approval.currentApprovers[0] || null;
  const step = approval.instance.steps?.find((item: any) => item.order === approval.instance.currentStepOrder);
  request.approverNameSnapshot = step?.approvers?.find((item: any) => item.status === "pending")?.nameSnapshot || "";
}

function populateRequest(query: any) {
  return query
    .populate("employee", "name username code role designation")
    .populate("approver", "name username code role designation")
    .populate("currentApprovers", "name username code role designation")
    .populate({
      path: "approvalInstance",
      populate: [
        { path: "steps.approvers.user", select: "name username code role designation" },
        { path: "history.actor", select: "name username code role" },
      ],
    });
}

function correctionLabel(type: string) {
  return type.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function notifyRequest(options: {
  request: any;
  recipients: any[];
  actorId: any;
  event: "submitted" | "awaiting_approval" | "approved" | "rejected" | "withdrawn";
  employeeName?: string;
  stepOrder?: number | null;
  session: mongoose.ClientSession;
}) {
  const titles = {
    submitted: "Attendance correction submitted",
    awaiting_approval: "Attendance correction needs approval",
    approved: "Attendance correction approved",
    rejected: "Attendance correction rejected",
    withdrawn: "Attendance correction withdrawn",
  };
  const subject = options.employeeName || "Your";
  const messages = {
    submitted: `Your attendance correction for ${options.request.attendanceDate} was submitted for approval.`,
    awaiting_approval: `${subject} ${correctionLabel(options.request.correctionType).toLowerCase()} request for ${options.request.attendanceDate} needs your decision.`,
    approved: `Your attendance correction for ${options.request.attendanceDate} was approved and applied.`,
    rejected: `Your attendance correction for ${options.request.attendanceDate} was rejected.`,
    withdrawn: `${subject} attendance correction for ${options.request.attendanceDate} was withdrawn.`,
  };
  await createRequestNotifications(
    {
      company: options.request.company,
      recipients: options.recipients,
      actor: options.actorId,
      eventType: `attendance_regularization.${options.event}`,
      entityType: "attendance_regularization_request",
      entityId: options.request._id,
      title: titles[options.event],
      message: messages[options.event],
      actionUrl: options.event === "awaiting_approval" ? "/dashboard" : "/dashboard/requests",
      category: options.event === "awaiting_approval" ? "approval" : "attendance",
      metadata: {
        requestType: "attendance_regularization_request",
        attendanceDate: options.request.attendanceDate,
        correctionType: options.request.correctionType,
      },
      dedupeEventKey: options.event === "awaiting_approval"
        ? `attendance_regularization.awaiting_approval:step:${options.stepOrder}`
        : undefined,
    },
    options.session
  );
}

async function regularizationContext(company: mongoose.Types.ObjectId, employee: mongoose.Types.ObjectId, attendanceDate: string) {
  parseAttendanceDate(attendanceDate);
  const context = await resolveEmployeeDayContext({ companyId: company, employeeId: employee, attendanceDate });
  const policy = context.policies?.attendancePolicy;
  const reference = context.policyReferences?.attendancePolicy;
  const rules: any = policy?.version?.rules?.regularization;
  if (!policy?.version || !reference?.assignmentId || !reference.resourceId || !reference.versionId) {
    throw generateError("No attendance policy is effective for this date", 422);
  }
  if (!rules?.enabled) throw generateError("Attendance regularization is not enabled for this date", 422);
  return { context, policy, reference, rules };
}

async function eligibility(company: mongoose.Types.ObjectId, employee: mongoose.Types.ObjectId, attendanceDate: string) {
  const result = await regularizationContext(company, employee, attendanceDate);
  const timezone = text(result.context.timezone) || "Asia/Kolkata";
  const today = dateKeyInTimezone(new Date(), timezone);
  const ageDays = daysBetween(attendanceDate, today);
  if (ageDays < 0) throw generateError("Future attendance cannot be regularized", 422);
  if (ageDays < Number(result.rules.requestStartDays || 0)) {
    throw generateError(`This attendance can be regularized after ${result.rules.requestStartDays} day(s)`, 422);
  }
  if (ageDays > Number(result.rules.maxBackdateDays || 30)) {
    throw generateError(`Attendance older than ${result.rules.maxBackdateDays} days cannot be regularized`, 422);
  }
  const monthStart = `${attendanceDate.slice(0, 7)}-01`;
  const monthEnd = addDays(`${attendanceDate.slice(0, 7)}-01`, 32).slice(0, 7) + "-01";
  const usedThisMonth = await AttendanceRegularizationRequest.countDocuments({
    company,
    employee,
    attendanceDate: { $gte: monthStart, $lt: monthEnd },
    status: { $in: ["submitted", "approved"] },
  });
  const monthlyLimit = Number(result.rules.monthlyRequestLimit || 0);
  if (monthlyLimit > 0 && usedThisMonth >= monthlyLimit) {
    throw generateError(`Monthly attendance regularization limit of ${monthlyLimit} has been reached`, 422);
  }
  const record = await AttendanceRecord.findOne({ company, employee, attendanceDate }).lean();
  return { ...result, timezone, ageDays, usedThisMonth, monthlyLimit, record };
}

function availableCorrectionTypes(policyTypes: string[], record: any) {
  return policyTypes.filter((type) => {
    if (type === "full_day_correction") return true;
    if (!record) return false;
    if (type === "missing_punch_in") {
      return (record.punchSessions || []).some((item: any) => item.punchOut && !item.punchIn);
    }
    if (type === "missing_punch_out") {
      return (record.punchSessions || []).some((item: any) => item.punchIn && !item.punchOut);
    }
    return true;
  });
}

function requestedChanges(body: any, type: string, attendanceDate: string, timezone: string, record: any) {
  const changes: any = {};
  const needsIn = ["missing_punch_in", "time_correction", "full_day_correction"].includes(type);
  const needsOut = ["missing_punch_out", "time_correction", "full_day_correction"].includes(type);
  if (needsIn) changes.punchIn = localAttendanceTimeToUtc(attendanceDate, body.punchInTime, timezone, false);
  if (needsOut) changes.punchOut = localAttendanceTimeToUtc(
    attendanceDate,
    body.punchOutTime,
    timezone,
    Boolean(body.punchOutNextDay)
  );
  if (changes.punchIn && changes.punchOut && changes.punchOut <= changes.punchIn) {
    throw generateError("Punch-out must be after punch-in", 422);
  }
  if (type === "missing_punch_in") {
    const target = (record?.punchSessions || []).find((item: any) => item.punchOut && !item.punchIn);
    if (!target) throw generateError("This attendance record does not have a missing punch-in", 422);
    if (changes.punchIn >= new Date(target.punchOut)) {
      throw generateError("Punch-in must be earlier than the recorded punch-out", 422);
    }
  }
  if (type === "missing_punch_out") {
    const target = [...(record?.punchSessions || [])].reverse().find((item: any) => item.punchIn && !item.punchOut);
    if (!target) throw generateError("This attendance record does not have a missing punch-out", 422);
    if (changes.punchOut <= new Date(target.punchIn)) {
      throw generateError("Punch-out must be later than the recorded punch-in", 422);
    }
  }
  if (["time_correction", "work_mode_correction"].includes(type) && !record) {
    throw generateError("No attendance record exists for this correction type", 422);
  }
  if (type === "work_mode_correction" || body.workMode) {
    const workMode = text(body.workMode).toLowerCase();
    if (!['office', 'remote', 'hybrid', 'field'].includes(workMode)) {
      throw generateError("Select a valid work mode", 422);
    }
    changes.workMode = workMode;
  }
  return changes;
}

async function applyApprovedRequest(request: any, actorId: mongoose.Types.ObjectId, session: mongoose.ClientSession) {
  const context = await resolveEmployeeDayContext({
    companyId: request.company,
    employeeId: request.employee,
    attendanceDate: request.attendanceDate,
  });
  let record = await AttendanceRecord.findOne({
    company: request.company,
    employee: request.employee,
    attendanceDate: request.attendanceDate,
  }).session(session);
  if (request.originalAttendanceRecord) {
    if (!record || String(record._id) !== String(request.originalAttendanceRecord) || record.revisionNumber !== request.originalRevisionNumber) {
      throw generateError("Attendance changed after this request was submitted. Withdraw it and submit a new correction", 409);
    }
  } else if (record) {
    throw generateError("An attendance record was created after this request was submitted. Withdraw it and submit a new correction", 409);
  }

  const changes: any = request.requestedChanges || {};
  const previousState = record?.state;
  if (!record) {
    record = new AttendanceRecord({
      company: request.company,
      employee: request.employee,
      attendanceDate: request.attendanceDate,
      timezone: context.timezone || "Asia/Kolkata",
      state: "open",
      status: "pending",
      workMode: changes.workMode || "office",
      workModeSource: changes.workMode ? "manual" : "default",
      punchSessions: [],
      revisionNumber: 0,
      calculationVersion: 0,
      source: "manual",
      createdBy: actorId,
      ...contextSnapshotFields(context),
    });
  }

  const sessions = (record.punchSessions || []).map((item: any) => ({
    punchIn: item.punchIn || null,
    punchOut: item.punchOut || null,
    source: item.source || "admin",
    latitude: item.latitude ?? null,
    longitude: item.longitude ?? null,
    deviceInfo: item.deviceInfo || "",
  }));
  if (request.correctionType === "missing_punch_in") {
    const target = sessions.find((item: any) => item.punchOut && !item.punchIn);
    if (!target) throw generateError("The missing punch-in no longer exists", 409);
    target.punchIn = changes.punchIn;
    target.source = "admin";
  } else if (request.correctionType === "missing_punch_out") {
    const target = [...sessions].reverse().find((item: any) => item.punchIn && !item.punchOut);
    if (!target) throw generateError("The missing punch-out no longer exists", 409);
    target.punchOut = changes.punchOut;
    target.source = "admin";
  } else if (["time_correction", "full_day_correction"].includes(request.correctionType)) {
    sessions.splice(0, sessions.length, {
      punchIn: changes.punchIn,
      punchOut: changes.punchOut,
      source: "admin",
      latitude: null,
      longitude: null,
      deviceInfo: "Approved attendance regularization",
    });
  }
  record.punchSessions = sessions as any;
  if (changes.workMode) {
    record.workMode = changes.workMode;
    record.workModeSource = "manual";
  }

  const policyVersion = await AttendancePolicyVersion.findOne({
    _id: request.attendancePolicyVersion,
    company: request.company,
  }).session(session).lean();
  if (!policyVersion) throw generateError("The attendance policy snapshot is unavailable", 409);
  const calculation = calculateAttendance({
    attendanceDate: request.attendanceDate,
    timezone: record.timezone || context.timezone || "Asia/Kolkata",
    punchSessions: record.punchSessions || [],
    attendanceRules: policyVersion.rules,
    schedule: {
      startTime: record.scheduleStartTimeSnapshot || context.schedule?.startTime,
      endTime: record.scheduleEndTimeSnapshot || context.schedule?.endTime,
    },
    requiresAttendance: typeof record.requiresAttendanceSnapshot === "boolean"
      ? record.requiresAttendanceSnapshot
      : context.requiresAttendance,
    expectedWorkMinutes: Number.isFinite(Number(record.expectedWorkMinutesSnapshot))
      ? Number(record.expectedWorkMinutesSnapshot)
      : context.expectedWorkMinutes,
    defaultAttendanceStatus: context.defaultAttendanceStatus,
  });
  record.state = previousState === "finalized" ? "finalized" : calculation.state;
  record.status = calculation.status;
  record.workedMinutes = calculation.workedMinutes;
  record.breakMinutes = calculation.breakMinutes;
  record.lateMinutes = calculation.lateMinutes;
  record.earlyExitMinutes = calculation.earlyExitMinutes;
  record.overtimeMinutes = calculation.overtimeMinutes;
  record.isLate = calculation.isLate;
  record.isEarlyExit = calculation.isEarlyExit;
  record.hasMissingPunch = calculation.hasMissingPunch;
  record.revisionNumber = Number(record.revisionNumber || 0) + 1;
  record.calculationVersion = Number(record.calculationVersion || 0) + 1;
  record.calculatedAt = new Date();
  record.calculatedBy = actorId;
  record.calculationReason = "approved_attendance_regularization";
  record.source = "manual";
  record.updatedBy = actorId;
  await record.save({ session });

  await AttendanceRecordRevision.create([{
    company: request.company,
    attendanceRecord: record._id,
    employee: request.employee,
    revisionNumber: record.revisionNumber,
    action: "manual_adjustment",
    reason: `Approved ${correctionLabel(request.correctionType).toLowerCase()}`,
    changes: {
      regularizationRequest: request._id,
      correctionType: request.correctionType,
      original: request.originalSnapshot,
      requested: request.requestedChanges,
    },
    snapshot: record.toObject(),
    actor: actorId,
    source: "manual",
  }], { session });
  request.appliedAttendanceRecord = record._id;
  request.appliedRevisionNumber = record.revisionNumber;
}

export async function getAttendanceRegularizationEligibilityService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.query?.companyId, "attendance regularization");
    const attendanceDate = parseAttendanceDate(text(req.query?.attendanceDate)).dateKey;
    const result = await eligibility(company, actor._id, attendanceDate);
    return res.status(200).json({
      success: true,
      data: {
        attendanceDate,
        timezone: result.timezone,
        record: result.record,
        rules: result.rules,
        allowedTypes: availableCorrectionTypes(result.rules.allowedTypes || [], result.record),
        usedThisMonth: result.usedThisMonth,
        remainingThisMonth: result.monthlyLimit > 0
          ? Math.max(0, result.monthlyLimit - result.usedThisMonth)
          : null,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function createAttendanceRegularizationRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId, "attendance regularization");
    const attendanceDate = parseAttendanceDate(text(req.body?.attendanceDate)).dateKey;
    const correctionType = text(req.body?.correctionType).toLowerCase();
    if (!ATTENDANCE_REGULARIZATION_TYPES.includes(correctionType as any)) {
      throw generateError("Select a valid attendance correction type", 422);
    }
    const result = await eligibility(company, actor._id, attendanceDate);
    if (!(result.rules.allowedTypes || []).includes(correctionType)) {
      throw generateError("This correction type is not allowed by the attendance policy", 422);
    }
    const reason = text(req.body?.reason);
    if (reason.length < Number(result.rules.minimumReasonLength || 10)) {
      throw generateError(`Reason must contain at least ${result.rules.minimumReasonLength || 10} characters`, 422);
    }
    const attachments = await resolveAttachments(req.body?.attachments, company, actor._id);
    if (result.rules.documentMode === "required" && !attachments.length) {
      throw generateError("A supporting document is required", 422);
    }
    const changes = requestedChanges(req.body || {}, correctionType, attendanceDate, result.timezone, result.record);
    const assignment = result.context.organizationAssignment || {};
    const reference = result.reference;
    const request = new AttendanceRegularizationRequest({
      company,
      employee: actor._id,
      attendanceDate,
      correctionType,
      reason,
      status: "submitted",
      originalAttendanceRecord: result.record?._id || null,
      originalRevisionNumber: Number(result.record?.revisionNumber || 0),
      originalSnapshot: result.record || {},
      requestedChanges: changes,
      attachments,
      attendancePolicyAssignment: objectId(reference.assignmentId, "attendance policy assignment id"),
      attendancePolicy: objectId(reference.resourceId, "attendance policy id"),
      attendancePolicyVersion: objectId(reference.versionId, "attendance policy version id"),
      attendancePolicyVersionNumber: Number(reference.versionNumber || 1),
      departmentNameSnapshot: text(assignment.departmentNameSnapshot || result.context.employee?.department),
      teamNameSnapshot: text(assignment.teamNameSnapshot || result.context.employee?.team),
      officeLocation: optionalObjectId(assignment.officeLocation || result.context.employee?.officeLocation),
      officeLocationNameSnapshot: text(assignment.officeLocationNameSnapshot),
      reportingManager: optionalObjectId(assignment.reportingManager || result.context.employee?.reportingManager),
      history: [event(actor, "submitted")],
      submittedAt: new Date(),
      createdBy: actor._id,
    });
    let autoApproved = false;
    await mongoose.connection.transaction(async (session) => {
      const approval = await createApprovalInstance({
        company,
        requestType: "attendance_regularization_request",
        requestModel: "AttendanceRegularizationRequest",
        requestId: request._id as mongoose.Types.ObjectId,
        employee: {
          ...result.context.employee,
          departmentId: assignment.department,
          departmentNameSnapshot: request.departmentNameSnapshot,
          teamNameSnapshot: request.teamNameSnapshot,
          officeLocation: request.officeLocation,
          reportingManager: request.reportingManager,
        },
        workflowId: result.rules.approvalWorkflow,
        workflowVersionId: result.rules.approvalWorkflowVersion,
        actorId: actor._id,
        session,
      });
      if (attachments.length) {
        const linked = await LeaveAttachment.updateMany(
          { _id: { $in: attachments.map((item) => item.attachment) }, linkedRequest: null },
          { $set: { linkedRequest: request._id } },
          { session }
        );
        if (linked.modifiedCount !== attachments.length) {
          throw generateError("One or more attachments were already used", 409);
        }
      }
      syncApproval(request, approval);
      autoApproved = approval.finalApproved;
      if (autoApproved) {
        await applyApprovedRequest(request, actor._id, session);
        request.status = "approved";
        request.currentApprovers = [];
        request.approver = null;
        request.approverNameSnapshot = "";
        request.decidedAt = new Date();
        request.decidedBy = actor._id;
        request.decisionComment = "Auto-approved by approval workflow";
        request.history.push(event(actor, "approved", request.decisionComment) as any);
      }
      await request.save({ session });
      if (autoApproved) {
        await notifyRequest({
          request,
          recipients: [request.employee],
          actorId: actor._id,
          event: "approved",
          session,
        });
      } else {
        await notifyRequest({
          request,
          recipients: [request.employee],
          actorId: actor._id,
          event: "submitted",
          session,
        });
        await notifyRequest({
          request,
          recipients: approval.currentApprovers,
          actorId: actor._id,
          event: "awaiting_approval",
          employeeName: text(result.context.employee?.name || result.context.employee?.username) || "An employee's",
          stepOrder: approval.instance.currentStepOrder,
          session,
        });
      }
    });
    const populated = await populateRequest(AttendanceRegularizationRequest.findById(request._id));
    return res.status(201).json({
      success: true,
      data: populated,
      message: autoApproved ? "Attendance correction approved and applied" : "Attendance correction submitted",
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      return next(generateError("An open attendance correction already exists for this date", 409));
    }
    next(error);
  }
}

export async function listAttendanceRegularizationRequestsService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.query?.companyId, "attendance regularization");
    const { page, limit, skip } = pagination(req.query);
    const scope = text(req.query?.scope || "mine");
    const match: any = { company };
    if (scope === "mine") match.employee = actor._id;
    else if (scope === "approvals") match.currentApprovers = actor._id;
    else Object.assign(match, buildLeaveRequestScope(actor, PERMISSION_KEYS.VIEW_ATTENDANCE));
    const status = text(req.query?.status);
    if (["submitted", "approved", "rejected", "withdrawn"].includes(status)) match.status = status;
    const [items, total] = await Promise.all([
      populateRequest(AttendanceRegularizationRequest.find(match).sort({ submittedAt: -1 }).skip(skip).limit(limit)),
      AttendanceRegularizationRequest.countDocuments(match),
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

export async function getAttendanceRegularizationRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.query?.companyId, "attendance regularization");
    const request = await populateRequest(AttendanceRegularizationRequest.findOne({
      _id: objectId(req.params.requestId, "attendance regularization request id"),
      company,
    }));
    if (!request) throw generateError("Attendance correction request not found", 404);
    const employee = {
      _id: request.employee?._id || request.employee,
      department: request.departmentNameSnapshot,
      team: request.teamNameSnapshot,
      officeLocation: request.officeLocation,
      reportingManager: request.reportingManager,
    };
    const participant = request.approvalInstance?.steps?.some((step: any) =>
      (step.approvers || []).some((item: any) => String(item.user?._id || item.user) === String(actor._id))
    );
    if (!participant && !isEmployeeInActorScope(actor, employee, PERMISSION_KEYS.VIEW_ATTENDANCE)) {
      throw generateError("You cannot view this attendance correction", 403);
    }
    return res.status(200).json({ success: true, data: request });
  } catch (error) {
    next(error);
  }
}

export async function approveAttendanceRegularizationRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId, "attendance regularization");
    const requestId = objectId(req.params.requestId, "attendance regularization request id");
    let finalApproved = false;
    let currentStepName: string | null = null;
    await mongoose.connection.transaction(async (session) => {
      const request = await AttendanceRegularizationRequest.findOne({ _id: requestId, company, status: "submitted" }).session(session);
      if (!request) throw generateError("Only a submitted attendance correction can be approved", 409);
      const previousApprovers = new Set((request.currentApprovers || []).map(String));
      const approval = await approveApprovalInstance({
        company,
        requestModel: "AttendanceRegularizationRequest",
        requestId,
        actor,
        comment: req.body?.comment,
        session,
      });
      syncApproval(request, approval);
      finalApproved = approval.finalApproved;
      currentStepName = approval.currentStepName;
      if (finalApproved) {
        await applyApprovedRequest(request, actor._id, session);
        request.status = "approved";
        request.currentApprovers = [];
        request.approver = null;
        request.approverNameSnapshot = "";
        request.decidedAt = new Date();
        request.decidedBy = actor._id;
        request.decisionComment = text(req.body?.comment);
        request.history.push(event(actor, "approved", req.body?.comment) as any);
        await notifyRequest({ request, recipients: [request.employee], actorId: actor._id, event: "approved", session });
      } else {
        const nextApprovers = approval.currentApprovers.filter((item: any) => !previousApprovers.has(String(item)));
        if (nextApprovers.length) {
          await notifyRequest({
            request,
            recipients: nextApprovers,
            actorId: actor._id,
            event: "awaiting_approval",
            stepOrder: approval.instance.currentStepOrder,
            session,
          });
        }
      }
      await request.save({ session });
    });
    const updated = await populateRequest(AttendanceRegularizationRequest.findById(requestId));
    return res.status(200).json({
      success: true,
      data: updated,
      message: finalApproved
        ? "Attendance correction approved and applied"
        : `Approval recorded${currentStepName ? `; awaiting ${currentStepName}` : ""}`,
    });
  } catch (error) {
    next(error);
  }
}

export async function rejectAttendanceRegularizationRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId, "attendance regularization");
    const requestId = objectId(req.params.requestId, "attendance regularization request id");
    const comment = text(req.body?.comment);
    if (comment.length < 3) throw generateError("A rejection reason is required", 422);
    await mongoose.connection.transaction(async (session) => {
      const request = await AttendanceRegularizationRequest.findOne({ _id: requestId, company, status: "submitted" }).session(session);
      if (!request) throw generateError("Only a submitted attendance correction can be rejected", 409);
      await rejectApprovalInstance({
        company,
        requestModel: "AttendanceRegularizationRequest",
        requestId,
        actor,
        comment,
        session,
      });
      request.status = "rejected";
      request.currentApprovers = [];
      request.approver = null;
      request.approverNameSnapshot = "";
      request.decidedAt = new Date();
      request.decidedBy = actor._id;
      request.decisionComment = comment;
      request.history.push(event(actor, "rejected", comment) as any);
      await request.save({ session });
      await notifyRequest({ request, recipients: [request.employee], actorId: actor._id, event: "rejected", session });
    });
    const updated = await populateRequest(AttendanceRegularizationRequest.findById(requestId));
    return res.status(200).json({ success: true, data: updated, message: "Attendance correction rejected" });
  } catch (error) {
    next(error);
  }
}

export async function withdrawAttendanceRegularizationRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId, "attendance regularization");
    const requestId = objectId(req.params.requestId, "attendance regularization request id");
    await mongoose.connection.transaction(async (session) => {
      const request = await AttendanceRegularizationRequest.findOne({
        _id: requestId,
        company,
        employee: actor._id,
        status: "submitted",
      }).session(session);
      if (!request) throw generateError("Only your submitted attendance correction can be withdrawn", 409);
      const approvers = [...(request.currentApprovers || [])];
      await cancelApprovalInstance({
        company,
        requestModel: "AttendanceRegularizationRequest",
        requestId,
        actor,
        comment: req.body?.comment,
        session,
      });
      request.status = "withdrawn";
      request.currentApprovers = [];
      request.approver = null;
      request.approverNameSnapshot = "";
      request.history.push(event(actor, "withdrawn", req.body?.comment) as any);
      await request.save({ session });
      if (approvers.length) {
        await notifyRequest({
          request,
          recipients: approvers,
          actorId: actor._id,
          event: "withdrawn",
          employeeName: text(actor.name || actor.username) || "The employee's",
          session,
        });
      }
    });
    const updated = await populateRequest(AttendanceRegularizationRequest.findById(requestId));
    return res.status(200).json({ success: true, data: updated, message: "Attendance correction withdrawn" });
  } catch (error) {
    next(error);
  }
}
