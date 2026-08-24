import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import EmployeeDayRequestLock from "../../schemas/Request/EmployeeDayRequestLock.schema";
import RemoteWorkRequest from "../../schemas/Request/RemoteWorkRequest.schema";
import User from "../../schemas/User/User";
import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";
import { resolveEmployeeDayContext } from "../attendance/employeeDayContext.service";
import {
  buildEmployeeRequestScope,
  ensureEmployeeInActorScope,
  getEmployeeRequestActor,
  isEmployeeInActorScope,
  resolveEmployeeRequestCompanyId,
} from "../leave/leaveAccess.utils";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import {
  applyApprovedRemoteWorkToAttendance,
  removeCancelledRemoteWorkFromAttendance,
} from "./remoteWorkAttendance.service";

const ACTIVE_STATUSES = ["submitted", "manager_approved", "approved"];
const DAY_MS = 86400000;

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

function currentDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function buildRemoteWorkDateRange(fromInput: unknown, toInput: unknown) {
  const from = parseAttendanceDate(text(fromInput));
  const to = parseAttendanceDate(text(toInput || fromInput));
  if (from.date > to.date) throw generateError("fromDate cannot be after toDate", 422);
  const days = Math.floor((to.date.getTime() - from.date.getTime()) / DAY_MS) + 1;
  if (days > 31) throw generateError("A WFH request can span at most 31 calendar days", 422);
  return Array.from({ length: days }, (_, index) =>
    new Date(from.date.getTime() + index * DAY_MS).toISOString().slice(0, 10)
  );
}

function pagination(query: any) {
  const page = Math.max(1, Number(query?.page || 1));
  const limit = Math.max(1, Math.min(50, Number(query?.limit || 20)));
  return { page, limit, skip: (page - 1) * limit };
}

async function loadEmployee(company: mongoose.Types.ObjectId, employeeId: unknown) {
  const employee = await User.findOne({
    _id: objectId(employeeId, "employee id"),
    company,
    deletedAt: { $exists: false },
    is_enabled: { $ne: false },
  })
    .select("_id company name username code role department team officeLocation reportingManager joiningDate confirmationDate")
    .lean();
  if (!employee) throw generateError("Employee not found in this company", 404);
  return employee;
}

function event(actor: any, action: string, comment?: unknown) {
  return {
    action,
    actor: actor._id,
    actorNameSnapshot: text(actor.name || actor.username),
    actorRoleSnapshot: text(actor.role),
    comment: text(comment) || undefined,
    createdAt: new Date(),
  };
}

function requestScopeEmployee(request: any) {
  return {
    _id: request.employee?._id || request.employee,
    department: request.departmentNameSnapshot,
    team: request.teamNameSnapshot,
    officeLocation: request.officeLocation,
    reportingManager: request.reportingManager || request.approver,
  };
}

function ensureCanView(actor: any, request: any) {
  if (!isEmployeeInActorScope(actor, requestScopeEmployee(request), PERMISSION_KEYS.VIEW_REMOTE_WORK_REQUESTS)) {
    throw generateError("You cannot view this WFH request", 403);
  }
}

function ensureCanReview(actor: any, request: any) {
  if (String(request.employee?._id || request.employee) === String(actor._id)) {
    throw generateError("You cannot review your own WFH request", 403);
  }
  if (String(request.approver?._id || request.approver || "") === String(actor._id)) return;
  if (
    !hasPermission(actor, PERMISSION_KEYS.APPROVE_REMOTE_WORK_REQUESTS) ||
    !isEmployeeInActorScope(actor, requestScopeEmployee(request), PERMISSION_KEYS.APPROVE_REMOTE_WORK_REQUESTS)
  ) {
    throw generateError("You cannot review WFH for this employee", 403);
  }
}

function populateRequest(query: any) {
  return query
    .populate("employee", "name username code role department team officeLocation")
    .populate("approver", "name username code role")
    .populate("reportingManager", "name username code role")
    .populate("remoteWorkPolicy", "name code")
    .populate("history.actor", "name username role");
}

function sameReference(left: any, right: any) {
  return (
    String(left?.assignmentId || "") === String(right?.assignmentId || "") &&
    String(left?.resourceId || "") === String(right?.resourceId || "") &&
    String(left?.versionId || "") === String(right?.versionId || "")
  );
}

export function getRemoteWorkWeekKey(dateKey: string) {
  const date = parseAttendanceDate(dateKey).date;
  const day = date.getUTCDay();
  return new Date(date.getTime() - ((day + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

export function getMaximumConsecutiveRemoteWorkDays(dateKeys: string[]) {
  const unique = Array.from(new Set(dateKeys)).sort();
  let longest = 0;
  let current = 0;
  let previous = 0;
  for (const key of unique) {
    const time = parseAttendanceDate(key).date.getTime();
    current = previous && time - previous === DAY_MS ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = time;
  }
  return longest;
}

async function calculateRequest(options: {
  company: mongoose.Types.ObjectId;
  employee: any;
  fromDate: unknown;
  toDate: unknown;
  portion: unknown;
  reason: unknown;
}) {
  const allDates = buildRemoteWorkDateRange(options.fromDate, options.toDate);
  const current = currentDateKey();
  if (allDates[0] < current) throw generateError("WFH cannot be requested for a past date", 422);
  const versionCache = new Map<string, Promise<any>>();
  const contexts = await Promise.all(
    allDates.map((attendanceDate) =>
      resolveEmployeeDayContext({
        companyId: options.company,
        employeeId: options.employee._id,
        attendanceDate,
        versionCache,
      })
    )
  );
  const eligible = contexts.filter((context) => context.requiresAttendance === true);
  if (!eligible.length) throw generateError("The selected range has no scheduled working days", 422);
  const firstPolicy = eligible[0].policies?.remoteWorkPolicy;
  const firstReference = eligible[0].policyReferences?.remoteWorkPolicy;
  if (!firstPolicy?.version || !firstReference?.assignmentId || !firstReference.resourceId || !firstReference.versionId) {
    throw generateError("No remote-work policy is effective for the selected date", 422);
  }
  for (const context of eligible) {
    if (!sameReference(firstReference, context.policyReferences?.remoteWorkPolicy)) {
      throw generateError("The selected dates cross different WFH policy assignments or versions. Submit separate requests", 422);
    }
  }
  const rules: any = firstPolicy.version.rules || {};
  const disallowed = eligible.find(
    (context) => !Array.isArray(rules.allowedWeekdays) || !rules.allowedWeekdays.includes(context.dayOfWeek)
  );
  if (disallowed) throw generateError(`WFH is not allowed on ${disallowed.dayOfWeek}s`, 422);
  const noticeDays = Math.floor(
    (parseAttendanceDate(eligible[0].attendanceDate).date.getTime() - parseAttendanceDate(current).date.getTime()) / DAY_MS
  );
  if (noticeDays < Number(rules.minimumNoticeDays || 0)) {
    throw generateError(`This WFH policy requires ${rules.minimumNoticeDays} calendar days notice`, 422);
  }
  if (Number(rules.maximumAdvanceDays || 0) > 0 && noticeDays > Number(rules.maximumAdvanceDays)) {
    throw generateError(`WFH can be requested at most ${rules.maximumAdvanceDays} calendar days in advance`, 422);
  }
  if (rules.probationEligibility === "not_allowed") {
    throw generateError("WFH is disabled by the configured probation rule", 422);
  }
  if (rules.probationEligibility === "after_confirmation") {
    const confirmation = options.employee.confirmationDate
      ? new Date(options.employee.confirmationDate).toISOString().slice(0, 10)
      : "";
    if (!confirmation || eligible[0].attendanceDate < confirmation) {
      throw generateError("WFH is available only after employee confirmation", 422);
    }
  }
  const reason = text(options.reason);
  const minimumReasonLength = Number(rules.minimumReasonLength || 0);
  if (rules.requireReason && !reason) throw generateError("Reason is required", 422);
  if (reason && reason.length < minimumReasonLength) {
    throw generateError(`Reason must contain at least ${minimumReasonLength} characters`, 422);
  }
  const requestedPortion = text(options.portion || "full").toLowerCase();
  if (!["full", "first_half", "second_half"].includes(requestedPortion)) {
    throw generateError("portion must be full, first_half, or second_half", 422);
  }
  if (requestedPortion !== "full" && eligible.length !== 1) {
    throw generateError("Half-day WFH can be requested for one working day at a time", 422);
  }
  if (requestedPortion !== "full" && rules.allowHalfDay !== true) {
    throw generateError("Half-day WFH is disabled by this policy", 422);
  }
  const requestedDates = eligible.map((context) => context.attendanceDate);
  const conflictingLeave = await LeaveRequest.exists({
    company: options.company,
    employee: options.employee._id,
    status: { $in: ["submitted", "approved"] },
    "dayBreakdown.attendanceDate": { $in: requestedDates },
  });
  if (conflictingLeave) throw generateError("An active leave request overlaps the selected dates", 409);
  const existingRequests = await RemoteWorkRequest.find({
    company: options.company,
    employee: options.employee._id,
    status: { $in: ACTIVE_STATUSES },
    "dates.attendanceDate": {
      $gte: `${eligible[0].attendanceDate.slice(0, 7)}-01`,
      $lte: `${eligible[eligible.length - 1].attendanceDate.slice(0, 7)}-31`,
    },
  })
    .select("dates")
    .lean();
  const existingUnits = new Map<string, number>();
  for (const request of existingRequests) {
    for (const day of request.dates || []) existingUnits.set(day.attendanceDate, Number(day.units || 0));
  }
  if (requestedDates.some((date) => existingUnits.has(date))) {
    throw generateError("An active WFH request already covers one or more selected dates", 409);
  }
  const requestedUnits = requestedPortion === "full" ? 1 : 0.5;
  const combined = new Map(existingUnits);
  requestedDates.forEach((date) => combined.set(date, requestedUnits));
  if (Number(rules.maxDaysPerWeek || 0) > 0) {
    const totals = new Map<string, number>();
    combined.forEach((units, date) => totals.set(getRemoteWorkWeekKey(date), (totals.get(getRemoteWorkWeekKey(date)) || 0) + units));
    if (Array.from(totals.values()).some((total) => total > Number(rules.maxDaysPerWeek))) {
      throw generateError(`Weekly WFH limit is ${rules.maxDaysPerWeek} days`, 422);
    }
  }
  if (Number(rules.maxDaysPerMonth || 0) > 0) {
    const totals = new Map<string, number>();
    combined.forEach((units, date) => totals.set(date.slice(0, 7), (totals.get(date.slice(0, 7)) || 0) + units));
    if (Array.from(totals.values()).some((total) => total > Number(rules.maxDaysPerMonth))) {
      throw generateError(`Monthly WFH limit is ${rules.maxDaysPerMonth} days`, 422);
    }
  }
  if (
    Number(rules.maxConsecutiveDays || 0) > 0 &&
    getMaximumConsecutiveRemoteWorkDays(Array.from(combined.keys())) > Number(rules.maxConsecutiveDays)
  ) {
    throw generateError(`Consecutive WFH limit is ${rules.maxConsecutiveDays} days`, 422);
  }
  const managerId = optionalObjectId(
    eligible[0].organizationAssignment?.reportingManager || options.employee.reportingManager
  );
  if (["reporting_manager", "manager_then_hr"].includes(rules.approvalMode) && !managerId) {
    throw generateError("Assign a reporting manager before requesting WFH under this policy", 422);
  }
  const manager = managerId
    ? await User.findOne({ _id: managerId, company: options.company, is_enabled: { $ne: false } }).select("_id name").lean()
    : null;
  if (managerId && !manager) throw generateError("The assigned reporting manager is not active", 422);
  const first = eligible[0];
  const organization = first.organizationAssignment || {};
  const assignment = firstPolicy.assignment || {};
  const dates = eligible.map((context) => ({
    attendanceDate: context.attendanceDate,
    portion: requestedPortion,
    units: requestedUnits,
    dayTypeSnapshot: context.dayType,
    expectedWorkMinutesSnapshot: context.expectedWorkMinutes,
    employeeAssignmentHistory: optionalObjectId(context.organizationAssignment?._id),
    department: optionalObjectId(context.organizationAssignment?.department),
    departmentNameSnapshot: text(context.organizationAssignment?.departmentNameSnapshot || options.employee.department),
    teamId: optionalObjectId(context.organizationAssignment?.teamId),
    teamNameSnapshot: text(context.organizationAssignment?.teamNameSnapshot || options.employee.team),
    officeLocation: optionalObjectId(context.organizationAssignment?.officeLocation || options.employee.officeLocation),
    officeLocationNameSnapshot: text(context.organizationAssignment?.officeLocationNameSnapshot),
  }));
  return {
    rules,
    reason,
    dates,
    requestedUnits: Number(dates.reduce((total, day) => total + day.units, 0).toFixed(2)),
    fromDate: dates[0].attendanceDate,
    toDate: dates[dates.length - 1].attendanceDate,
    manager,
    organization,
    policy: {
      assignmentId: objectId(firstReference.assignmentId, "remote-work policy assignment"),
      resourceId: objectId(firstReference.resourceId, "remote-work policy"),
      versionId: objectId(firstReference.versionId, "remote-work policy version"),
      versionNumber: Number(firstReference.versionNumber),
      scopeType: text(firstReference.scopeType),
      scopeName: text(assignment.scopeNameSnapshot),
      name: text(assignment.resource?.name),
      code: text(assignment.resource?.code),
    },
  };
}

async function resolveEmployeeForRequest(actor: any, company: mongoose.Types.ObjectId, employeeId?: unknown) {
  const targetId = employeeId || actor._id;
  const employee = await loadEmployee(company, targetId);
  if (String(employee._id) !== String(actor._id)) {
    ensureEmployeeInActorScope(
      actor,
      employee,
      PERMISSION_KEYS.MANAGE_REMOTE_WORK_REQUESTS,
      "You cannot submit WFH for this employee"
    );
  }
  return employee;
}

export async function getRemoteWorkEligibilityService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getEmployeeRequestActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.query?.companyId, "remote-work");
    const employee = await resolveEmployeeForRequest(actor, company, req.query?.employeeId);
    const attendanceDate = parseAttendanceDate(text(req.query?.date || currentDateKey())).dateKey;
    const context = await resolveEmployeeDayContext({ companyId: company, employeeId: employee._id, attendanceDate });
    const resolved = context.policies?.remoteWorkPolicy;
    return res.status(200).json({
      success: true,
      data: {
        employee: { _id: employee._id, name: employee.name, code: employee.code },
        attendanceDate,
        eligible: Boolean(resolved?.version && context.requiresAttendance === true),
        dayType: context.dayType,
        requiresAttendance: context.requiresAttendance,
        policy: resolved
          ? {
              assignment: resolved.assignment,
              version: resolved.version,
              reference: context.policyReferences?.remoteWorkPolicy,
            }
          : null,
        warnings: context.warnings,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function previewRemoteWorkRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getEmployeeRequestActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId, "remote-work");
    const employee = await resolveEmployeeForRequest(actor, company, req.body?.employeeId);
    const result = await calculateRequest({ company, employee, ...req.body });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function createRemoteWorkRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getEmployeeRequestActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId, "remote-work");
    const employee = await resolveEmployeeForRequest(actor, company, req.body?.employeeId);
    const result = await calculateRequest({ company, employee, ...req.body });
    const autoApproved = result.rules.approvalMode === "auto_approve";
    const request = new RemoteWorkRequest({
      company,
      employee: employee._id,
      employeeNameSnapshot: employee.name || employee.username,
      employeeCodeSnapshot: employee.code,
      department: optionalObjectId(result.organization.department),
      departmentNameSnapshot: text(result.organization.departmentNameSnapshot || employee.department),
      teamId: optionalObjectId(result.organization.teamId),
      teamNameSnapshot: text(result.organization.teamNameSnapshot || employee.team),
      officeLocation: optionalObjectId(result.organization.officeLocation || employee.officeLocation),
      officeLocationNameSnapshot: text(result.organization.officeLocationNameSnapshot),
      fromDate: result.fromDate,
      toDate: result.toDate,
      requestedUnits: result.requestedUnits,
      dates: result.dates,
      reason: result.reason,
      status: autoApproved ? "approved" : "submitted",
      approvalModeSnapshot: result.rules.approvalMode,
      approver: ["reporting_manager", "manager_then_hr"].includes(result.rules.approvalMode)
        ? result.manager?._id || null
        : null,
      approverNameSnapshot: result.manager?.name || "",
      reportingManager: result.manager?._id || null,
      reportingManagerNameSnapshot: result.manager?.name || "",
      remoteWorkPolicyAssignment: result.policy.assignmentId,
      remoteWorkPolicy: result.policy.resourceId,
      remoteWorkPolicyVersion: result.policy.versionId,
      remoteWorkPolicyVersionNumber: result.policy.versionNumber,
      policyScopeTypeSnapshot: result.policy.scopeType,
      policyScopeNameSnapshot: result.policy.scopeName,
      history: [event(actor, "submitted"), ...(autoApproved ? [event(actor, "auto_approved")] : [])],
      submittedAt: new Date(),
      decidedAt: autoApproved ? new Date() : null,
      decidedBy: autoApproved ? actor._id : null,
      createdBy: actor._id,
    });
    await mongoose.connection.transaction(async (session) => {
      await EmployeeDayRequestLock.create(
        result.dates.map((day) => ({
          company,
          employee: employee._id,
          attendanceDate: day.attendanceDate,
          requestType: "remote_work",
          requestModel: "RemoteWorkRequest",
          request: request._id,
        })),
        { session }
      );
      await request.save({ session });
      if (autoApproved) await applyApprovedRemoteWorkToAttendance({ request, actor: actor._id, session });
    });
    const populated = await populateRequest(RemoteWorkRequest.findById(request._id));
    return res.status(201).json({ success: true, data: populated, message: autoApproved ? "WFH request approved automatically" : "WFH request submitted" });
  } catch (error: any) {
    if (error?.code === 11000) {
      return next(generateError("An active leave or WFH request already covers one or more selected dates", 409));
    }
    next(error);
  }
}

export async function listRemoteWorkRequestsService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getEmployeeRequestActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.query?.companyId, "remote-work");
    const { page, limit, skip } = pagination(req.query);
    const scope = text(req.query?.scope || "mine").toLowerCase();
    const match: any = { company };
    if (scope === "mine") {
      match.employee = actor._id;
    } else if (scope === "approvals") {
      Object.assign(match, buildEmployeeRequestScope(actor, PERMISSION_KEYS.APPROVE_REMOTE_WORK_REQUESTS, false));
      match.status = { $in: ["submitted", "manager_approved"] };
    } else if (scope === "company") {
      if (!hasPermission(actor, PERMISSION_KEYS.VIEW_REMOTE_WORK_REQUESTS)) {
        throw generateError("You do not have permission to view company WFH requests", 403);
      }
      Object.assign(match, buildEmployeeRequestScope(actor, PERMISSION_KEYS.VIEW_REMOTE_WORK_REQUESTS, false));
    } else {
      throw generateError("scope must be mine, approvals, or company", 400);
    }
    const statuses = text(req.query?.status).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (statuses.length) match.status = { $in: statuses };
    if (req.query?.employeeId) {
      const employee = await loadEmployee(company, req.query.employeeId);
      ensureEmployeeInActorScope(actor, employee, PERMISSION_KEYS.VIEW_REMOTE_WORK_REQUESTS, "You cannot view WFH for this employee");
      match.employee = employee._id;
    }
    if (req.query?.fromDate) match.toDate = { $gte: parseAttendanceDate(text(req.query.fromDate)).dateKey };
    if (req.query?.toDate) match.fromDate = { $lte: parseAttendanceDate(text(req.query.toDate)).dateKey };
    const [items, total] = await Promise.all([
      populateRequest(RemoteWorkRequest.find(match).sort({ submittedAt: -1, _id: -1 }).skip(skip).limit(limit)),
      RemoteWorkRequest.countDocuments(match),
    ]);
    return res.status(200).json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    next(error);
  }
}

export async function getRemoteWorkRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getEmployeeRequestActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.query?.companyId, "remote-work");
    const request = await populateRequest(RemoteWorkRequest.findOne({ _id: objectId(req.params.requestId, "WFH request id"), company }));
    if (!request) throw generateError("WFH request not found", 404);
    ensureCanView(actor, request);
    return res.status(200).json({ success: true, data: request });
  } catch (error) {
    next(error);
  }
}

async function releaseLocks(request: any, session: mongoose.ClientSession) {
  await EmployeeDayRequestLock.deleteMany({
    company: request.company,
    employee: request.employee,
    requestType: "remote_work",
    request: request._id,
  }).session(session);
}

export async function approveRemoteWorkRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getEmployeeRequestActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId || req.query?.companyId, "remote-work");
    const requestId = objectId(req.params.requestId, "WFH request id");
    const candidate = await RemoteWorkRequest.findOne({ _id: requestId, company }).lean();
    if (!candidate) throw generateError("WFH request not found", 404);
    ensureCanReview(actor, candidate);
    await mongoose.connection.transaction(async (session) => {
      const request = await RemoteWorkRequest.findOne({ _id: requestId, company, status: { $in: ["submitted", "manager_approved"] } }).session(session);
      if (!request) throw generateError("Only a pending WFH request can be approved", 409);
      const managerStage = request.approvalModeSnapshot === "manager_then_hr" && request.status === "submitted";
      if (managerStage) {
        request.status = "manager_approved";
        request.approver = null;
        request.approverNameSnapshot = "HR approval queue";
        request.history.push(event(actor, "manager_approved", req.body?.comment) as any);
      } else {
        if (request.approvalModeSnapshot === "hr" || request.status === "manager_approved") {
          if (!hasPermission(actor, PERMISSION_KEYS.APPROVE_REMOTE_WORK_REQUESTS)) {
            throw generateError("HR approval permission is required for this stage", 403);
          }
        }
        await applyApprovedRemoteWorkToAttendance({ request, actor: actor._id, session });
        request.status = "approved";
        request.decidedAt = new Date();
        request.decidedBy = actor._id;
        request.decisionComment = text(req.body?.comment);
        request.history.push(event(actor, "approved", req.body?.comment) as any);
      }
      await request.save({ session });
    });
    const updated = await populateRequest(RemoteWorkRequest.findById(requestId));
    return res.status(200).json({ success: true, data: updated, message: updated.status === "manager_approved" ? "Manager approved; awaiting HR" : "WFH request approved" });
  } catch (error) {
    next(error);
  }
}

export async function rejectRemoteWorkRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getEmployeeRequestActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId || req.query?.companyId, "remote-work");
    const requestId = objectId(req.params.requestId, "WFH request id");
    const candidate = await RemoteWorkRequest.findOne({ _id: requestId, company }).lean();
    if (!candidate) throw generateError("WFH request not found", 404);
    ensureCanReview(actor, candidate);
    const comment = text(req.body?.comment);
    if (!comment) throw generateError("A rejection reason is required", 422);
    await mongoose.connection.transaction(async (session) => {
      const request = await RemoteWorkRequest.findOne({ _id: requestId, company, status: { $in: ["submitted", "manager_approved"] } }).session(session);
      if (!request) throw generateError("Only a pending WFH request can be rejected", 409);
      request.status = "rejected";
      request.decidedAt = new Date();
      request.decidedBy = actor._id;
      request.decisionComment = comment;
      request.history.push(event(actor, "rejected", comment) as any);
      await releaseLocks(request, session);
      await request.save({ session });
    });
    const updated = await populateRequest(RemoteWorkRequest.findById(requestId));
    return res.status(200).json({ success: true, data: updated, message: "WFH request rejected" });
  } catch (error) {
    next(error);
  }
}

export async function withdrawRemoteWorkRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getEmployeeRequestActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId || req.query?.companyId, "remote-work");
    const requestId = objectId(req.params.requestId, "WFH request id");
    await mongoose.connection.transaction(async (session) => {
      const request = await RemoteWorkRequest.findOne({ _id: requestId, company, employee: actor._id, status: { $in: ["submitted", "manager_approved"] } }).session(session);
      if (!request) throw generateError("Only your pending WFH request can be withdrawn", 409);
      request.status = "withdrawn";
      request.history.push(event(actor, "withdrawn", req.body?.comment) as any);
      await releaseLocks(request, session);
      await request.save({ session });
    });
    const updated = await populateRequest(RemoteWorkRequest.findById(requestId));
    return res.status(200).json({ success: true, data: updated, message: "WFH request withdrawn" });
  } catch (error) {
    next(error);
  }
}

export async function cancelRemoteWorkRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getEmployeeRequestActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId || req.query?.companyId, "remote-work");
    if (!hasPermission(actor, PERMISSION_KEYS.MANAGE_REMOTE_WORK_REQUESTS)) {
      throw generateError("You do not have permission to cancel approved WFH", 403);
    }
    const requestId = objectId(req.params.requestId, "WFH request id");
    const reason = text(req.body?.comment);
    if (!reason) throw generateError("A cancellation reason is required", 422);
    const candidate = await RemoteWorkRequest.findOne({ _id: requestId, company }).lean();
    if (!candidate) throw generateError("WFH request not found", 404);
    ensureEmployeeInActorScope(actor, requestScopeEmployee(candidate), PERMISSION_KEYS.MANAGE_REMOTE_WORK_REQUESTS, "You cannot cancel WFH for this employee");
    await mongoose.connection.transaction(async (session) => {
      const request = await RemoteWorkRequest.findOne({ _id: requestId, company, status: "approved" }).session(session);
      if (!request) throw generateError("Only an approved WFH request can be cancelled", 409);
      await removeCancelledRemoteWorkFromAttendance({ request, actor: actor._id, session });
      request.status = "cancelled";
      request.cancelledAt = new Date();
      request.cancelledBy = actor._id;
      request.decisionComment = reason;
      request.history.push(event(actor, "cancelled", reason) as any);
      await releaseLocks(request, session);
      await request.save({ session });
    });
    const updated = await populateRequest(RemoteWorkRequest.findById(requestId));
    return res.status(200).json({ success: true, data: updated, message: "Approved WFH cancelled" });
  } catch (error) {
    next(error);
  }
}
