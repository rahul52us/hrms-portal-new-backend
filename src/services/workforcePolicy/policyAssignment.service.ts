import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import Department from "../../schemas/Department/Department.schema";
import EmployeeAssignmentHistory from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import OfficeLocation from "../../schemas/OfficeLocation/OfficeLocation.schema";
import User from "../../schemas/User/User";
import { ensureCurrentEmployeeAssignment } from "../employeeAssignment/employeeAssignment.service";
import AttendancePolicy from "../../schemas/WorkforcePolicy/AttendancePolicy.schema";
import AttendancePolicyVersion from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import HolidayCalendar from "../../schemas/WorkforcePolicy/HolidayCalendar.schema";
import HolidayCalendarVersion from "../../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
import WorkSchedule from "../../schemas/WorkforcePolicy/WorkSchedule.schema";
import WorkScheduleVersion from "../../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
import LeavePolicy from "../../schemas/WorkforcePolicy/LeavePolicy.schema";
import LeavePolicyVersion from "../../schemas/WorkforcePolicy/LeavePolicyVersion.schema";
import WorkforcePolicyAssignment, {
  POLICY_RESOURCE_TYPES,
  POLICY_SCOPE_TYPES,
} from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import WorkforcePolicyAuditLog from "../../schemas/WorkforcePolicy/WorkforcePolicyAuditLog.schema";
import { ensurePermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import {
  ensurePolicyManager,
  ensurePolicyViewer,
  escapeRegex,
  getPolicyActor,
  getPolicyActorId,
  isDateRangeOverlapping,
  normalizeRole,
  normalizeText,
  parseEffectiveDate,
  POLICY_SCOPE_PRIORITY,
  resolvePolicyCompany,
  validateObjectId,
  writePolicyAudit,
} from "./workforcePolicy.utils";

const WORKFORCE_ROLE_PATTERN = /^(user|manager|departmenthead|department head|department-head|l\d+[-\s]?manager)$/i;

function normalizeObjectIdList(value: any) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return source
    .map((item) => normalizeText(item?._id || item))
    .filter((item, index, array) => mongoose.Types.ObjectId.isValid(item) && array.indexOf(item) === index);
}

async function findResource(options: {
  company: mongoose.Types.ObjectId;
  resourceType: string;
  resourceId: string;
}) {
  if (options.resourceType === "attendance_policy") {
    const resource = await AttendancePolicy.findOne({
      _id: new mongoose.Types.ObjectId(options.resourceId),
      company: options.company,
    }).lean();
    if (!resource) throw generateError("Attendance policy not found", 404);
    return { resource, resourceModel: "AttendancePolicy" as const };
  }

  if (options.resourceType === "work_schedule") {
    const resource = await WorkSchedule.findOne({
      _id: new mongoose.Types.ObjectId(options.resourceId),
      company: options.company,
    }).lean();
    if (!resource) throw generateError("Work schedule not found", 404);
    return { resource, resourceModel: "WorkSchedule" as const };
  }

  if (options.resourceType === "leave_policy") {
    const resource = await LeavePolicy.findOne({
      _id: new mongoose.Types.ObjectId(options.resourceId),
      company: options.company,
    }).lean();
    if (!resource) throw generateError("Leave policy not found", 404);
    return { resource, resourceModel: "LeavePolicy" as const };
  }

  const resource = await HolidayCalendar.findOne({
    _id: new mongoose.Types.ObjectId(options.resourceId),
    company: options.company,
  }).lean();
  if (!resource) throw generateError("Holiday calendar not found", 404);
  return { resource, resourceModel: "HolidayCalendar" as const };
}

async function ensureResourceHasPublishedVersion(options: {
  company: mongoose.Types.ObjectId;
  resourceType: string;
  resourceId: string;
  effectiveFrom: Date;
}) {
  const query = {
    company: options.company,
    status: "published",
    effectiveFrom: { $lte: options.effectiveFrom },
  };
  let version: any = null;
  if (options.resourceType === "attendance_policy") {
    version = await AttendancePolicyVersion.findOne({
      ...query,
      policy: new mongoose.Types.ObjectId(options.resourceId),
    })
      .sort({ effectiveFrom: -1, versionNumber: -1 })
      .lean();
  } else if (options.resourceType === "work_schedule") {
    version = await WorkScheduleVersion.findOne({
      ...query,
      schedule: new mongoose.Types.ObjectId(options.resourceId),
    })
      .sort({ effectiveFrom: -1, versionNumber: -1 })
      .lean();
  } else if (options.resourceType === "holiday_calendar") {
    version = await HolidayCalendarVersion.findOne({
      ...query,
      calendar: new mongoose.Types.ObjectId(options.resourceId),
    })
      .sort({ effectiveFrom: -1, versionNumber: -1 })
      .lean();
  } else {
    version = await LeavePolicyVersion.findOne({
      ...query,
      policy: new mongoose.Types.ObjectId(options.resourceId),
    })
      .sort({ effectiveFrom: -1, versionNumber: -1 })
      .lean();
  }

  if (!version) {
    throw generateError("Publish a version effective on or before the assignment start date", 409);
  }
}

async function resolveScope(options: {
  company: mongoose.Types.ObjectId;
  companyName: string;
  scopeType: string;
  scopeIdInput: unknown;
}) {
  if (options.scopeType === "company") {
    return { scopeId: null, scopeNameSnapshot: options.companyName || "Company default" };
  }

  const scopeId = validateObjectId(options.scopeIdInput, `${options.scopeType} scope id`);
  const scopeObjectId = new mongoose.Types.ObjectId(scopeId);
  if (options.scopeType === "location") {
    const location = await OfficeLocation.findOne({
      _id: scopeObjectId,
      company: options.company,
      deletedAt: null,
    })
      .select("name code")
      .lean();
    if (!location) throw generateError("Office location not found", 404);
    return {
      scopeId: scopeObjectId,
      scopeNameSnapshot: `${location.name}${location.code ? ` (${location.code})` : ""}`,
    };
  }

  if (options.scopeType === "department") {
    const department = await Department.findOne({
      _id: scopeObjectId,
      company: options.company,
      deletedAt: { $exists: false },
    })
      .select("departmentName code")
      .lean();
    if (!department) throw generateError("Department not found", 404);
    return {
      scopeId: scopeObjectId,
      scopeNameSnapshot: `${department.departmentName}${department.code ? ` (${department.code})` : ""}`,
    };
  }

  if (options.scopeType === "team") {
    const department = await Department.findOne({
      company: options.company,
      deletedAt: { $exists: false },
      "teams._id": scopeObjectId,
    })
      .select("departmentName teams")
      .lean();
    const team = department?.teams?.find((item: any) => String(item?._id) === scopeId);
    if (!department || !team || team.isActive === false) throw generateError("Active team not found", 404);
    return {
      scopeId: scopeObjectId,
      scopeNameSnapshot: `${department.departmentName} / ${team.name}`,
    };
  }

  const employee = await User.findOne({
    _id: scopeObjectId,
    company: options.company,
    deletedAt: { $exists: false },
  })
    .select("name username role")
    .lean();
  if (!employee || !WORKFORCE_ROLE_PATTERN.test(normalizeText(employee.role))) {
    throw generateError("Workforce employee not found", 404);
  }
  return {
    scopeId: scopeObjectId,
    scopeNameSnapshot: `${employee.name || employee.username || "Employee"}`,
  };
}

function getAssignmentState(assignment: any, at = new Date()) {
  const start = new Date(assignment.effectiveFrom).getTime();
  const end = assignment.effectiveTo ? new Date(assignment.effectiveTo).getTime() : Number.POSITIVE_INFINITY;
  const time = at.getTime();
  if (time < start) return "scheduled";
  if (time >= end) return "ended";
  return "active";
}

export async function listPolicyAssignmentsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.query.companyId);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
    const resourceType = normalizeText(req.query.resourceType);
    const scopeType = normalizeText(req.query.scopeType);
    const state = normalizeText(req.query.state);
    const match: any = { company: companyObjectId };
    if (POLICY_RESOURCE_TYPES.includes(resourceType as any)) match.resourceType = resourceType;
    if (POLICY_SCOPE_TYPES.includes(scopeType as any)) match.scopeType = scopeType;
    const now = new Date();
    if (state === "active") {
      match.effectiveFrom = { $lte: now };
      match.$or = [{ effectiveTo: null }, { effectiveTo: { $gt: now } }];
    } else if (state === "scheduled") {
      match.effectiveFrom = { $gt: now };
    } else if (state === "ended") {
      match.effectiveTo = { $lte: now };
    }

    const [assignments, total] = await Promise.all([
      WorkforcePolicyAssignment.find(match)
        .populate("resource", "name code status")
        .populate("createdBy", "name username")
        .populate("endedBy", "name username")
        .sort({ effectiveFrom: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WorkforcePolicyAssignment.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      data: assignments.map((assignment) => ({
        ...assignment,
        state: getAssignmentState(assignment),
      })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}

export async function createPolicyAssignmentService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { company, companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.body.company,
      true
    );
    const actorId = getPolicyActorId(req);
    const resourceType = normalizeText(req.body.resourceType);
    const scopeType = normalizeText(req.body.scopeType);
    if (!POLICY_RESOURCE_TYPES.includes(resourceType as any)) {
      throw generateError("Invalid policy resource type", 400);
    }
    if (!POLICY_SCOPE_TYPES.includes(scopeType as any)) {
      throw generateError("Invalid policy assignment scope", 400);
    }
    const resourceId = validateObjectId(req.body.resourceId || req.body.resource, "policy resource id");
    const effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date") as Date;
    const effectiveTo = parseEffectiveDate(req.body.effectiveTo, "effective to date", false);
    if (effectiveTo && effectiveTo.getTime() <= effectiveFrom.getTime()) {
      throw generateError("Effective to date must be after effective from date", 400);
    }
    const changeReason = normalizeText(req.body.changeReason);
    if (changeReason.length < 3) throw generateError("Assignment reason must be at least 3 characters", 422);
    const { resource, resourceModel } = await findResource({
      company: companyObjectId,
      resourceType,
      resourceId,
    });
    if (resource.status !== "active") throw generateError("Archived resources cannot be assigned", 409);
    await ensureResourceHasPublishedVersion({
      company: companyObjectId,
      resourceType,
      resourceId,
      effectiveFrom,
    });
    const scope = await resolveScope({
      company: companyObjectId,
      companyName: normalizeText((company as any).company_name),
      scopeType,
      scopeIdInput: req.body.scopeId,
    });
    const existingAssignments = await WorkforcePolicyAssignment.find({
      company: companyObjectId,
      resourceType,
      scopeType,
      scopeId: scope.scopeId,
    })
      .select("effectiveFrom effectiveTo resource")
      .lean();
    const overlap = existingAssignments.find((assignment) =>
      isDateRangeOverlapping({
        existingStart: new Date(assignment.effectiveFrom),
        existingEnd: assignment.effectiveTo ? new Date(assignment.effectiveTo) : null,
        requestedStart: effectiveFrom,
        requestedEnd: effectiveTo,
      })
    );
    if (overlap) {
      throw generateError(
        "This scope already has an overlapping assignment for the same policy category. End it or choose a non-overlapping date range.",
        409
      );
    }

    const assignment = await WorkforcePolicyAssignment.create({
      company: companyObjectId,
      resourceType,
      resourceModel,
      resource: new mongoose.Types.ObjectId(resourceId),
      scopeType,
      scopeId: scope.scopeId,
      scopeNameSnapshot: scope.scopeNameSnapshot,
      priority: POLICY_SCOPE_PRIORITY[scopeType],
      effectiveFrom,
      effectiveTo,
      changeReason,
      createdBy: actorId,
    });
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "assignment",
      entityId: assignment._id as mongoose.Types.ObjectId,
      action: "created",
      actor: actorId,
      details: {
        resourceType,
        resourceId,
        scopeType,
        scopeId: scope.scopeId,
        effectiveFrom,
        effectiveTo,
      },
    });
    await assignment.populate("resource", "name code status");
    return res.status(201).json({
      success: true,
      message: "Workforce policy assignment created",
      data: { ...assignment.toObject(), state: getAssignmentState(assignment) },
    });
  } catch (error) {
    next(error);
  }
}

export async function endPolicyAssignmentService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const assignmentId = validateObjectId(req.params.assignmentId, "policy assignment id");
    const assignment = await WorkforcePolicyAssignment.findOne({
      _id: new mongoose.Types.ObjectId(assignmentId),
      company: companyObjectId,
    });
    if (!assignment) throw generateError("Workforce policy assignment not found", 404);
    const effectiveTo = parseEffectiveDate(
      req.body.effectiveTo || new Date().toISOString(),
      "effective to date"
    ) as Date;
    if (effectiveTo.getTime() <= new Date(assignment.effectiveFrom).getTime()) {
      throw generateError("Effective to date must be after assignment start date", 400);
    }
    const reason = normalizeText(req.body.reason || req.body.endReason);
    if (reason.length < 3) throw generateError("End reason must be at least 3 characters", 422);
    if (assignment.effectiveTo && new Date(assignment.effectiveTo).getTime() <= Date.now()) {
      throw generateError("This assignment has already ended", 409);
    }
    assignment.effectiveTo = effectiveTo;
    assignment.endedAt = new Date();
    assignment.endedBy = actorId;
    assignment.endReason = reason;
    await assignment.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "assignment",
      entityId: assignment._id as mongoose.Types.ObjectId,
      action: "ended",
      actor: actorId,
      details: { effectiveTo, reason },
    });
    return res.status(200).json({
      success: true,
      message: "Workforce policy assignment ended",
      data: { ...assignment.toObject(), state: getAssignmentState(assignment) },
    });
  } catch (error) {
    next(error);
  }
}

function assertHistoricalEmployeeAccess(actor: any, employee: any, assignmentHistory: any) {
  const role = normalizeRole(actor?.role);
  const actorId = normalizeText(actor?._id);
  if (actorId && actorId === String(employee._id)) return;
  if (["superadmin", "admin", "hradmin"].includes(role)) {
    ensurePermission(
      actor,
      PERMISSION_KEYS.VIEW_WORKFORCE_POLICIES,
      "You do not have permission to resolve workforce policies"
    );
    return;
  }
  if (role === "departmenthead") {
    ensurePermission(actor, PERMISSION_KEYS.VIEW_WORKFORCE_POLICIES);
    const actorDepartment = normalizeText(actor?.department).toLowerCase();
    const employeeDepartment = normalizeText(
      assignmentHistory?.departmentNameSnapshot || employee?.department
    ).toLowerCase();
    if (!actorDepartment || actorDepartment !== employeeDepartment) {
      throw generateError("This employee is outside your department", 403);
    }
    return;
  }
  if (role === "hr") {
    ensurePermission(actor, PERMISSION_KEYS.VIEW_WORKFORCE_POLICIES);
    const scope = actor?.hrScope || {};
    const departmentNames = (Array.isArray(scope.departments) ? scope.departments : [])
      .map((item: unknown) => normalizeText(item).toLowerCase())
      .filter(Boolean);
    const employeeDepartment = normalizeText(
      assignmentHistory?.departmentNameSnapshot || employee?.department
    ).toLowerCase();
    if (!employeeDepartment || !departmentNames.includes(employeeDepartment)) {
      throw generateError("This employee is outside your HR department scope", 403);
    }
    const teamNames = (Array.isArray(scope.teams) ? scope.teams : [])
      .map((item: unknown) => normalizeText(item).toLowerCase())
      .filter(Boolean);
    const employeeTeam = normalizeText(assignmentHistory?.teamNameSnapshot || employee?.team).toLowerCase();
    if (teamNames.length && !teamNames.includes(employeeTeam)) {
      throw generateError("This employee is outside your HR team scope", 403);
    }
    const locationIds = normalizeObjectIdList(
      scope.officeLocations || scope.officeLocationIds || scope.locations || scope.locationIds
    );
    const employeeLocation = normalizeText(
      assignmentHistory?.officeLocation || employee?.officeLocation
    );
    if (locationIds.length && !locationIds.includes(employeeLocation)) {
      throw generateError("This employee is outside your HR location scope", 403);
    }
    return;
  }

  throw generateError("You can only resolve your own workforce policy", 403);
}

async function resolvePublishedVersion(options: {
  company: mongoose.Types.ObjectId;
  resourceType: string;
  resourceId: mongoose.Types.ObjectId;
  at: Date;
}) {
  if (options.resourceType === "attendance_policy") {
    const version = await AttendancePolicyVersion.findOne({
      company: options.company,
      policy: options.resourceId,
      status: "published",
      effectiveFrom: { $lte: options.at },
    })
      .sort({ effectiveFrom: -1, versionNumber: -1 })
      .lean();
    if (!version) return null;
    const nextVersion = await AttendancePolicyVersion.findOne({
      company: options.company,
      policy: options.resourceId,
      status: "published",
      effectiveFrom: { $gt: version.effectiveFrom },
    })
      .sort({ effectiveFrom: 1, versionNumber: 1 })
      .select("effectiveFrom")
      .lean();
    return { ...version, effectiveTo: nextVersion?.effectiveFrom || null };
  }

  if (options.resourceType === "work_schedule") {
    const version = await WorkScheduleVersion.findOne({
      company: options.company,
      schedule: options.resourceId,
      status: "published",
      effectiveFrom: { $lte: options.at },
    })
      .sort({ effectiveFrom: -1, versionNumber: -1 })
      .lean();
    if (!version) return null;
    const nextVersion = await WorkScheduleVersion.findOne({
      company: options.company,
      schedule: options.resourceId,
      status: "published",
      effectiveFrom: { $gt: version.effectiveFrom },
    })
      .sort({ effectiveFrom: 1, versionNumber: 1 })
      .select("effectiveFrom")
      .lean();
    return { ...version, effectiveTo: nextVersion?.effectiveFrom || null };
  }

  if (options.resourceType === "leave_policy") {
    const version = await LeavePolicyVersion.findOne({
      company: options.company,
      policy: options.resourceId,
      status: "published",
      effectiveFrom: { $lte: options.at },
    })
      .sort({ effectiveFrom: -1, versionNumber: -1 })
      .lean();
    if (!version) return null;
    const nextVersion = await LeavePolicyVersion.findOne({
      company: options.company,
      policy: options.resourceId,
      status: "published",
      effectiveFrom: { $gt: version.effectiveFrom },
    })
      .sort({ effectiveFrom: 1, versionNumber: 1 })
      .select("effectiveFrom")
      .lean();
    return { ...version, effectiveTo: nextVersion?.effectiveFrom || null };
  }

  const version = await HolidayCalendarVersion.findOne({
    company: options.company,
    calendar: options.resourceId,
    status: "published",
    effectiveFrom: { $lte: options.at },
  })
    .sort({ effectiveFrom: -1, versionNumber: -1 })
    .lean();
  if (!version) return null;
  const nextVersion = await HolidayCalendarVersion.findOne({
    company: options.company,
    calendar: options.resourceId,
    status: "published",
    effectiveFrom: { $gt: version.effectiveFrom },
  })
    .sort({ effectiveFrom: 1, versionNumber: 1 })
    .select("effectiveFrom")
    .lean();
  return { ...version, effectiveTo: nextVersion?.effectiveFrom || null };
}

async function resolveEmployeePolicyData(options: {
  actor: any;
  employee: any;
  at: Date;
  assertAccess?: boolean;
  versionCache?: Map<string, Promise<any>>;
}) {
  const { actor, employee, at } = options;
  let assignmentHistory = await EmployeeAssignmentHistory.findOne({
    company: employee.company,
    employee: employee._id,
    effectiveFrom: { $lte: at },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }],
  })
    .sort({ effectiveFrom: -1 })
    .lean();

  if (!assignmentHistory) {
    const anyAssignmentHistory = await EmployeeAssignmentHistory.exists({
      company: employee.company,
      employee: employee._id,
    });
    if (!anyAssignmentHistory && !employee.deletedAt) {
      await ensureCurrentEmployeeAssignment({
        user: employee,
        source: "workforce_policy_resolution_backfill",
      });
      assignmentHistory = await EmployeeAssignmentHistory.findOne({
        company: employee.company,
        employee: employee._id,
        effectiveFrom: { $lte: at },
        $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }],
      })
        .sort({ effectiveFrom: -1 })
        .lean();
    }
  }
  if (options.assertAccess !== false) {
    assertHistoricalEmployeeAccess(actor, employee, assignmentHistory);
  }

  const departmentId = normalizeText(assignmentHistory?.department);
  const teamId = normalizeText(assignmentHistory?.teamId);
  const locationId = normalizeText(assignmentHistory?.officeLocation || employee.officeLocation);
  const scopeMatches: any[] = [
    { scopeType: "company", scopeId: null },
    { scopeType: "employee", scopeId: employee._id },
  ];
  if (departmentId && mongoose.Types.ObjectId.isValid(departmentId)) {
    scopeMatches.push({ scopeType: "department", scopeId: new mongoose.Types.ObjectId(departmentId) });
  }
  if (teamId && mongoose.Types.ObjectId.isValid(teamId)) {
    scopeMatches.push({ scopeType: "team", scopeId: new mongoose.Types.ObjectId(teamId) });
  }
  if (locationId && mongoose.Types.ObjectId.isValid(locationId)) {
    scopeMatches.push({ scopeType: "location", scopeId: new mongoose.Types.ObjectId(locationId) });
  }
  const assignments = await WorkforcePolicyAssignment.find({
    company: employee.company,
    effectiveFrom: { $lte: at },
    $and: [{ $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }] }, { $or: scopeMatches }],
  })
    .populate("resource", "name code status")
    .sort({ priority: -1, effectiveFrom: -1, createdAt: -1 })
    .lean();
  const selectedAssignments = new Map<string, any>();
  assignments.forEach((assignment: any) => {
    if (!selectedAssignments.has(assignment.resourceType)) {
      selectedAssignments.set(assignment.resourceType, assignment);
    }
  });

  const resolved: Record<string, any> = {};
  for (const resourceType of POLICY_RESOURCE_TYPES) {
    const assignment = selectedAssignments.get(resourceType);
    if (!assignment) {
      resolved[resourceType] = null;
      continue;
    }
    const resourceId = assignment.resource?._id || assignment.resource;
    const versionCacheKey = `${resourceType}:${resourceId}:${at.toISOString()}`;
    let versionPromise = options.versionCache?.get(versionCacheKey);
    if (!versionPromise) {
      versionPromise = resolvePublishedVersion({
        company: employee.company as unknown as mongoose.Types.ObjectId,
        resourceType,
        resourceId: resourceId as mongoose.Types.ObjectId,
        at,
      });
      options.versionCache?.set(versionCacheKey, versionPromise);
    }
    const version = await versionPromise;
    resolved[resourceType] = version ? { assignment, version } : null;
  }

  const warnings = [];
  if (!resolved.attendance_policy) warnings.push("No attendance policy is effective for this employee and date");
  if (!resolved.work_schedule) warnings.push("No work schedule is effective for this employee and date");
  if (!resolved.holiday_calendar) warnings.push("No holiday calendar is effective for this employee and date");
  if (!resolved.leave_policy) warnings.push("No leave policy is effective for this employee and date");
  return {
    employee: {
      _id: employee._id,
      name: employee.name,
      username: employee.username,
      code: employee.code || "",
    },
    at,
    organizationAssignment: assignmentHistory || {
      departmentNameSnapshot: employee.department || "",
      teamNameSnapshot: employee.team || "",
      officeLocation: employee.officeLocation || null,
      officeLocationNameSnapshot: "",
      source: "current_user_fallback",
    },
    attendancePolicy: resolved.attendance_policy,
    workSchedule: resolved.work_schedule,
    holidayCalendar: resolved.holiday_calendar,
    leavePolicy: resolved.leave_policy,
    warnings,
  };
}

function applyCoverageActorScope(match: any, actor: any) {
  const role = normalizeRole(actor?.role);
  if (["superadmin", "admin", "hradmin"].includes(role)) return;

  if (role === "departmenthead") {
    const department = normalizeText(actor?.department);
    if (!department) throw generateError("Department scope is missing", 403);
    match.department = { $regex: new RegExp(`^${escapeRegex(department)}$`, "i") };
    return;
  }

  if (role === "hr") {
    const scope = actor?.hrScope || {};
    const departments = (Array.isArray(scope.departments) ? scope.departments : [])
      .map((item: unknown) => normalizeText(item))
      .filter(Boolean);
    if (!departments.length) throw generateError("HR department scope is missing", 403);
    match.$and = match.$and || [];
    match.$and.push({
      $or: departments.map((department: string) => ({
        department: { $regex: new RegExp(`^${escapeRegex(department)}$`, "i") },
      })),
    });

    const teams = (Array.isArray(scope.teams) ? scope.teams : [])
      .map((item: unknown) => normalizeText(item))
      .filter(Boolean);
    if (teams.length) {
      match.$and.push({
        $or: teams.map((team: string) => ({
          team: { $regex: new RegExp(`^${escapeRegex(team)}$`, "i") },
        })),
      });
    }

    const locationIds = normalizeObjectIdList(
      scope.officeLocations || scope.officeLocationIds || scope.locations || scope.locationIds
    );
    if (locationIds.length) {
      match.officeLocation = {
        $in: locationIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }
    return;
  }

  throw generateError("You cannot view company policy coverage", 403);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index]);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

export async function resolveEmployeePolicyService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getPolicyActor(req);
    const employeeId = validateObjectId(req.params.employeeId, "employee id");
    const at = parseEffectiveDate(req.query.at || req.query.date || new Date().toISOString(), "resolution date") as Date;
    const employee = await User.findOne({ _id: new mongoose.Types.ObjectId(employeeId) })
      .select(
        "_id company name username code role department team officeLocation designation reportingManager joiningDate createdAt deletedAt"
      )
      .lean();
    if (!employee || !employee.company) throw generateError("Employee not found", 404);
    const actorRole = normalizeRole(actor?.role);
    const actorCompanyId = normalizeText(actor?.company || actor?.companyId);
    if (actorRole !== "superadmin" && actorCompanyId !== String(employee.company)) {
      throw generateError("You can only resolve policies from your company", 403);
    }
    const data = await resolveEmployeePolicyData({ actor, employee, at });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

export async function getPolicyCoverageService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const actor = getPolicyActor(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.query.companyId);
    const at = parseEffectiveDate(
      req.query.at || req.query.date || new Date().toISOString(),
      "coverage date"
    ) as Date;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(25, Number(req.query.limit || 20)));
    const search = normalizeText(req.query.search);
    const requestedResourceType = normalizeText(req.query.resourceType);
    const coverageResourceTypes = POLICY_RESOURCE_TYPES.includes(requestedResourceType as any)
      ? [requestedResourceType]
      : [...POLICY_RESOURCE_TYPES];
    const match: any = {
      company: companyObjectId,
      deletedAt: null,
      role: { $regex: WORKFORCE_ROLE_PATTERN },
    };
    applyCoverageActorScope(match, actor);
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      match.$and = match.$and || [];
      match.$and.push({
        $or: [
          { name: regex },
          { username: regex },
          { code: regex },
          { department: regex },
          { team: regex },
        ],
      });
    }

    const [employees, total] = await Promise.all([
      User.find(match)
        .select(
          "_id company name username code role department team officeLocation designation reportingManager joiningDate createdAt deletedAt"
        )
        .sort({ name: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(match),
    ]);
    const versionCache = new Map<string, Promise<any>>();
    const items = await mapWithConcurrency(employees, 5, async (employee) => {
      const resolution = await resolveEmployeePolicyData({
        actor,
        employee,
        at,
        assertAccess: false,
        versionCache,
      });
      const resolutionByType: Record<string, any> = {
        attendance_policy: resolution.attendancePolicy,
        work_schedule: resolution.workSchedule,
        holiday_calendar: resolution.holidayCalendar,
        leave_policy: resolution.leavePolicy,
      };
      const missing = coverageResourceTypes.filter((resourceType) => !resolutionByType[resourceType]);
      const compactResource = (resolved: any) => {
        if (!resolved) return null;
        return {
          assignment: {
            _id: resolved.assignment._id,
            resourceType: resolved.assignment.resourceType,
            resource: resolved.assignment.resource,
            scopeType: resolved.assignment.scopeType,
            scopeId: resolved.assignment.scopeId,
            scopeNameSnapshot: resolved.assignment.scopeNameSnapshot,
            effectiveFrom: resolved.assignment.effectiveFrom,
            effectiveTo: resolved.assignment.effectiveTo,
            state: getAssignmentState(resolved.assignment, at),
          },
          version: {
            _id: resolved.version._id,
            versionNumber: resolved.version.versionNumber,
            status: resolved.version.status,
            effectiveFrom: resolved.version.effectiveFrom,
            effectiveTo: resolved.version.effectiveTo,
          },
        };
      };
      return {
        employee: resolution.employee,
        at: resolution.at,
        organizationAssignment: {
          departmentNameSnapshot: resolution.organizationAssignment?.departmentNameSnapshot || "",
          teamNameSnapshot: resolution.organizationAssignment?.teamNameSnapshot || "",
          officeLocationNameSnapshot: resolution.organizationAssignment?.officeLocationNameSnapshot || "",
        },
        attendancePolicy: compactResource(resolution.attendancePolicy),
        workSchedule: compactResource(resolution.workSchedule),
        holidayCalendar: compactResource(resolution.holidayCalendar),
        leavePolicy: compactResource(resolution.leavePolicy),
        warnings: resolution.warnings,
        complete: missing.length === 0,
        missing,
      };
    });
    const completeOnPage = items.filter((item) => item.complete).length;

    return res.status(200).json({
      success: true,
      data: items,
      summary: {
        employeesOnPage: items.length,
        completeOnPage,
        incompleteOnPage: items.length - completeOnPage,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      filters: { resourceType: requestedResourceType || null },
    });
  } catch (error) {
    next(error);
  }
}

export async function listPolicyAuditLogService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.query.companyId);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
    const entityType = normalizeText(req.query.entityType);
    const entityId = normalizeText(req.query.entityId);
    const match: any = { company: companyObjectId };
    if (entityType) match.entityType = entityType;
    if (entityId) match.entityId = new mongoose.Types.ObjectId(validateObjectId(entityId, "audit entity id"));
    const [logs, total] = await Promise.all([
      WorkforcePolicyAuditLog.find(match)
        .populate("actor", "name username role")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WorkforcePolicyAuditLog.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: logs,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}
