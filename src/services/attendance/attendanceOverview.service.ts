import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";
import AttendanceRecordRevision from "../../schemas/Attendance/AttendanceRecordRevision.schema";
import Department from "../../schemas/Department/Department.schema";
import EmployeeAssignmentHistory from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import OfficeLocation from "../../schemas/OfficeLocation/OfficeLocation.schema";
import RemoteWorkRequest from "../../schemas/Request/RemoteWorkRequest.schema";
import User from "../../schemas/User/User";
import AttendancePolicy from "../../schemas/WorkforcePolicy/AttendancePolicy.schema";
import AttendancePolicyVersion from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import HolidayCalendar from "../../schemas/WorkforcePolicy/HolidayCalendar.schema";
import HolidayCalendarVersion from "../../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
import WorkSchedule from "../../schemas/WorkforcePolicy/WorkSchedule.schema";
import WorkScheduleVersion from "../../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
import { calendarData, fallbackOrganization } from "../calendar/calendar.service";
import {
  calendarEmployeeActive,
  calendarId,
  calendarOrganizationAccess,
  calendarVisible,
  effectiveOn,
} from "../calendar/calendar.utils";
import {
  getEmployeeRequestActor,
  resolveEmployeeRequestCompanyId,
} from "../leave/leaveAccess.utils";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { resolveEmployeeDayContext } from "./employeeDayContext.service";
import { parseAttendanceDate } from "./employeeDayContext.utils";
import {
  ATTENDANCE_OVERVIEW_STATUSES,
  ATTENDANCE_OVERVIEW_WORK_MODES,
  addAttendanceSummaryRow,
  approvedRequestDay,
  attendanceRowMatches,
  createAttendanceSummary,
  deriveAttendanceStatus,
  deriveAttendanceWorkMode,
  finalPunchOut,
  firstPunchIn,
  hasOpenPunch,
  idString,
} from "./attendanceOverview.utils";

const EMPLOYEE_FIELDS =
  "_id name username code pic designation company role department team officeLocation reportingManager joiningDate createdAt employmentEndDate deletedAt";

function exactRegex(value: unknown) {
  const escaped = String(value || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}$`, "i");
}

function validId(value: unknown, label: string) {
  const normalized = String(value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(normalized)) {
    throw generateError(`Invalid ${label}`, 400);
  }
  return normalized;
}

function parsePositiveInteger(value: unknown, fallback: number, maximum: number) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw generateError("Invalid attendance pagination", 400);
  }
  return parsed;
}

function assertAttendanceAccess(actor: any) {
  if (actor.role === "superadmin") {
    throw generateError("Attendance operations are available to company accounts only", 403);
  }
  if (!hasPermission(actor, PERMISSION_KEYS.VIEW_ATTENDANCE)) {
    throw generateError("You do not have permission to view attendance", 403);
  }
}

function attendanceContext(req: any) {
  const actor = getEmployeeRequestActor(req);
  assertAttendanceAccess(actor);
  const company = resolveEmployeeRequestCompanyId(actor, req.query?.companyId, "attendance");
  const attendanceDate = parseAttendanceDate(String(req.query?.date || "")).dateKey;
  const page = parsePositiveInteger(req.query?.page, 1, 100000);
  const limit = parsePositiveInteger(req.query?.limit, 25, 100);
  const filters: Record<string, string> = {};
  for (const key of ["departmentId", "teamId", "officeLocationId", "managerId", "employeeId"]) {
    if (req.query?.[key]) filters[key] = validId(req.query[key], key);
  }
  const search = String(req.query?.search || "").trim();
  if (search.length > 100) throw generateError("Attendance search is too long", 400);
  filters.search = search;
  const status = String(req.query?.status || "all");
  if (!(ATTENDANCE_OVERVIEW_STATUSES as readonly string[]).includes(status)) {
    throw generateError("Invalid attendance status filter", 400);
  }
  const workMode = String(req.query?.workMode || "all");
  if (!(ATTENDANCE_OVERVIEW_WORK_MODES as readonly string[]).includes(workMode)) {
    throw generateError("Invalid attendance work mode filter", 400);
  }
  return {
    actor,
    company,
    attendanceDate,
    at: parseAttendanceDate(attendanceDate).date,
    page,
    limit,
    skip: (page - 1) * limit,
    filters,
    status,
    workMode,
  };
}

function organizationFromRecord(record: any) {
  if (!record) return null;
  if (
    !record.employeeAssignmentHistory &&
    !record.department &&
    !record.teamId &&
    !record.officeLocation &&
    !record.reportingManager &&
    !record.departmentNameSnapshot
  ) {
    return null;
  }
  return {
    _id: record.employeeAssignmentHistory || null,
    department: record.department || null,
    departmentNameSnapshot: record.departmentNameSnapshot || "",
    teamId: record.teamId || null,
    teamNameSnapshot: record.teamNameSnapshot || "",
    officeLocation: record.officeLocation || null,
    officeLocationNameSnapshot: record.officeLocationNameSnapshot || "",
    designationSnapshot: record.designationSnapshot || "",
    reportingManager: record.reportingManager || null,
    reportingManagerNameSnapshot: record.reportingManagerNameSnapshot || "",
    source: "attendance_snapshot",
  };
}

function classificationWithRecordSnapshot(classification: any, record: any) {
  if (!record) return classification;
  return {
    ...classification,
    dayType: record.dayTypeSnapshot || classification.dayType,
    requiresAttendance:
      typeof record.requiresAttendanceSnapshot === "boolean"
        ? record.requiresAttendanceSnapshot
        : classification.requiresAttendance,
    expectedWorkMinutes:
      Number.isFinite(Number(record.expectedWorkMinutesSnapshot))
        ? Number(record.expectedWorkMinutesSnapshot)
        : classification.expectedWorkMinutes,
    timezone: record.timezone || classification.timezone,
    schedule: {
      ...classification.schedule,
      startTime: record.scheduleStartTimeSnapshot || classification.schedule?.startTime || null,
      endTime: record.scheduleEndTimeSnapshot || classification.schedule?.endTime || null,
    },
  };
}

function requestMap(requests: any[], attendanceDate: string, kind: "leave" | "wfh") {
  const result = new Map<string, { request: any; day: any }>();
  for (const request of requests) {
    const day = approvedRequestDay(request, attendanceDate, kind);
    if (day) result.set(idString(request.employee), { request, day });
  }
  return result;
}

function organizationFilters(ctx: ReturnType<typeof attendanceContext>) {
  return {
    employeeId: ctx.filters.employeeId,
    departmentId: ctx.filters.departmentId,
    teamId: ctx.filters.teamId,
    officeLocationId: ctx.filters.officeLocationId,
    managerId: ctx.filters.managerId,
  };
}

export async function getAttendanceOverviewService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = attendanceContext(req);
    const data = await calendarData(ctx.company, [ctx.attendanceDate]);
    const summary = createAttendanceSummary();
    const items: any[] = [];
    const diagnostics = {
      currentAssignmentFallbackEmployees: 0,
      attendanceSnapshotEmployees: 0,
      missingHistoryEmployees: 0,
    };
    let total = 0;
    let after: mongoose.Types.ObjectId | null = null;

    for (;;) {
      const match: any = { company: ctx.company, role: { $ne: "superadmin" } };
      if (ctx.filters.employeeId) match._id = new mongoose.Types.ObjectId(ctx.filters.employeeId);
      if (after) match._id = { $gt: after };
      if (ctx.filters.search) {
        const regex = new RegExp(
          ctx.filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i"
        );
        match.$or = [{ name: regex }, { code: regex }, { username: regex }];
      }

      const employees: any[] = await User.find(match)
        .select(EMPLOYEE_FIELDS)
        .sort({ _id: 1 })
        .limit(250)
        .lean();
      if (!employees.length) break;

      const employeeIds = employees.map((employee) => employee._id);
      const [histories, historyEmployeeIds, records, leaveRequests, remoteWorkRequests] =
        await Promise.all([
          EmployeeAssignmentHistory.find({
            company: ctx.company,
            employee: { $in: employeeIds },
            effectiveFrom: { $lte: ctx.at },
            $or: [{ effectiveTo: null }, { effectiveTo: { $gt: ctx.at } }],
          })
            .sort({ effectiveFrom: -1 })
            .lean(),
          EmployeeAssignmentHistory.distinct("employee", {
            company: ctx.company,
            employee: { $in: employeeIds },
          }),
          AttendanceRecord.find({
            company: ctx.company,
            employee: { $in: employeeIds },
            attendanceDate: ctx.attendanceDate,
          }).lean(),
          LeaveRequest.find({
            company: ctx.company,
            employee: { $in: employeeIds },
            status: "approved",
            "dayBreakdown.attendanceDate": ctx.attendanceDate,
          })
            .select(
              "_id employee status leaveTypeNameSnapshot leaveTypeCodeSnapshot leaveUnit fromDate toDate dayBreakdown reason"
            )
            .lean(),
          RemoteWorkRequest.find({
            company: ctx.company,
            employee: { $in: employeeIds },
            status: "approved",
            "dates.attendanceDate": ctx.attendanceDate,
          })
            .select("_id employee status fromDate toDate dates reason")
            .lean(),
        ]);

      const historyByEmployee = new Map<string, any>();
      for (const history of histories) {
        const key = idString(history.employee);
        if (!historyByEmployee.has(key) && effectiveOn(history, ctx.attendanceDate)) {
          historyByEmployee.set(key, history);
        }
      }
      const hasHistory = new Set(historyEmployeeIds.map(idString));
      const recordByEmployee = new Map(records.map((record: any) => [idString(record.employee), record]));
      const leaveByEmployee = requestMap(leaveRequests, ctx.attendanceDate, "leave");
      const remoteByEmployee = requestMap(remoteWorkRequests, ctx.attendanceDate, "wfh");
      const managerIds = new Set<string>();
      for (const employee of employees) {
        const key = idString(employee);
        const record: any = recordByEmployee.get(key);
        const organization =
          historyByEmployee.get(key) ||
          organizationFromRecord(record) ||
          (!hasHistory.has(key) && !employee.deletedAt
            ? fallbackOrganization(employee, data.departments)
            : null);
        if (organization?.reportingManager) managerIds.add(idString(organization.reportingManager));
      }
      const managers = managerIds.size
        ? await User.find({ company: ctx.company, _id: { $in: Array.from(managerIds) } })
            .select("name code")
            .lean()
        : [];
      const managerById = new Map(managers.map((manager: any) => [idString(manager), manager]));

      for (const employee of employees) {
        if (!calendarEmployeeActive(employee, ctx.attendanceDate)) continue;
        const employeeId = idString(employee);
        const record: any = recordByEmployee.get(employeeId) || null;
        const history = historyByEmployee.get(employeeId) || null;
        const recordOrganization = organizationFromRecord(record);
        const organization =
          history ||
          recordOrganization ||
          (!hasHistory.has(employeeId) && !employee.deletedAt
            ? fallbackOrganization(employee, data.departments)
            : null);
        if (
          !calendarVisible(
            ctx.actor,
            "organization",
            employee,
            organization,
            organizationFilters(ctx)
          )
        ) {
          continue;
        }

        if (!history && recordOrganization) diagnostics.attendanceSnapshotEmployees += 1;
        else if (!history && organization) diagnostics.currentAssignmentFallbackEmployees += 1;
        else if (!organization) diagnostics.missingHistoryEmployees += 1;

        const baseClassification = organization
          ? data.classify(employee, organization, ctx.attendanceDate)
          : {
              dayType: "unconfigured",
              requiresAttendance: null,
              expectedWorkMinutes: null,
              defaultAttendanceStatus: "pending",
              timezone: record?.timezone || null,
              schedule: { configured: false, startTime: null, endTime: null },
              holiday: null,
            };
        const classification = classificationWithRecordSnapshot(baseClassification, record);
        const leave = leaveByEmployee.get(employeeId) || null;
        const remoteWork = remoteByEmployee.get(employeeId) || null;
        const firstIn = firstPunchIn(record);
        const lastOut = finalPunchOut(record);
        const manager = managerById.get(idString(organization?.reportingManager));
        const status = deriveAttendanceStatus({
          record,
          leaveDay: leave?.day,
          classification,
        });
        const workMode = deriveAttendanceWorkMode({
          record,
          remoteWorkDay: remoteWork?.day,
        });
        const row = {
          attendanceDate: ctx.attendanceDate,
          recordId: record ? idString(record) : null,
          employee: {
            id: employeeId,
            name: employee.name || "Employee",
            code: employee.code || "",
            designation: organization?.designationSnapshot || employee.designation || "",
            picture: employee.pic?.url || null,
          },
          organization: {
            departmentId: idString(organization?.department) || null,
            department: organization?.departmentNameSnapshot || employee.department || "",
            teamId: idString(organization?.teamId) || null,
            team: organization?.teamNameSnapshot || employee.team || "",
            officeLocationId: idString(organization?.officeLocation) || null,
            officeLocation: organization?.officeLocationNameSnapshot || "",
            managerId: idString(organization?.reportingManager) || null,
            manager: organization?.reportingManagerNameSnapshot || manager?.name || "",
          },
          assignmentSource: history
            ? "history"
            : recordOrganization
              ? "attendance_snapshot"
              : organization
                ? "current_assignment_fallback"
                : "missing_history",
          status,
          state: record?.state || "not_created",
          workMode,
          dayType: classification.dayType,
          requiresAttendance: classification.requiresAttendance,
          expectedWorkMinutes: classification.expectedWorkMinutes,
          timezone: classification.timezone || record?.timezone || "Asia/Kolkata",
          schedule: {
            configured: classification.schedule?.configured !== false,
            startTime: classification.schedule?.startTime || null,
            endTime: classification.schedule?.endTime || null,
          },
          holiday: classification.holiday || null,
          firstIn,
          lastOut,
          punchCount: (record?.punchSessions || []).filter((session: any) => session?.punchIn).length,
          hasOpenPunch: hasOpenPunch(record),
          workedMinutes: Number(record?.workedMinutes || 0),
          breakMinutes: Number(record?.breakMinutes || 0),
          lateMinutes: Number(record?.lateMinutes || 0),
          earlyExitMinutes: Number(record?.earlyExitMinutes || 0),
          overtimeMinutes: Number(record?.overtimeMinutes || 0),
          isLate: record?.isLate === true,
          isEarlyExit: record?.isEarlyExit === true,
          hasMissingPunch: record?.hasMissingPunch === true,
          leave: leave
            ? {
                id: idString(leave.request),
                name: leave.request.leaveTypeNameSnapshot || "Leave",
                code: leave.request.leaveTypeCodeSnapshot || "",
                portion: leave.day.portion || "full",
                units: Number(leave.day.chargedUnits || 0),
                unit: leave.request.leaveUnit || "days",
              }
            : null,
          remoteWork: remoteWork
            ? {
                id: idString(remoteWork.request),
                portion: remoteWork.day.portion || "full",
                units: Number(remoteWork.day.units || 0),
              }
            : null,
        };

        addAttendanceSummaryRow(summary, row);
        if (!attendanceRowMatches(row, ctx.status, ctx.workMode)) continue;
        if (total >= ctx.skip && items.length < ctx.limit) items.push(row);
        total += 1;
      }

      if (ctx.filters.employeeId || employees.length < 250) break;
      after = employees[employees.length - 1]._id;
    }

    return res.status(200).json({
      success: true,
      data: {
        attendanceDate: ctx.attendanceDate,
        summary,
        items,
        diagnostics,
      },
      pagination: {
        page: ctx.page,
        limit: ctx.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / ctx.limit)),
      },
    });
  } catch (error) {
    next(error);
  }
}

function scopedHistoryMatch(ctx: ReturnType<typeof attendanceContext>) {
  const match: any = {
    company: ctx.company,
    effectiveFrom: { $lte: ctx.at },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: ctx.at } }],
  };
  if (ctx.actor.role === "departmenthead") {
    match.departmentNameSnapshot = exactRegex(ctx.actor.department);
  } else if (ctx.actor.role === "hr") {
    const departments = (ctx.actor.hrScope?.departments || []).filter(Boolean);
    const teams = (ctx.actor.hrScope?.teams || []).filter(Boolean);
    const locations = (ctx.actor.hrScope?.officeLocations || [])
      .map(idString)
      .filter(mongoose.Types.ObjectId.isValid)
      .map((id: string) => new mongoose.Types.ObjectId(id));
    if (!departments.length) return { ...match, _id: { $exists: false } };
    match.departmentNameSnapshot = { $in: departments.map(exactRegex) };
    if (teams.length) match.teamNameSnapshot = { $in: teams.map(exactRegex) };
    if (locations.length) match.officeLocation = { $in: locations };
  }
  return match;
}

export async function getAttendanceOverviewOptionsService(
  req: any,
  res: Response,
  next: NextFunction
) {
  try {
    const ctx = attendanceContext(req);
    const allDepartments: any[] = await Department.find({ company: ctx.company })
      .select("departmentName teams")
      .sort({ departmentName: 1 })
      .lean();
    const departmentNames =
      ctx.actor.role === "hr"
        ? (ctx.actor.hrScope?.departments || []).map((value: any) => String(value).toLowerCase())
        : ctx.actor.role === "departmenthead"
          ? [String(ctx.actor.department || "").toLowerCase()]
          : null;
    const teamNames =
      ctx.actor.role === "hr" && (ctx.actor.hrScope?.teams || []).length
        ? (ctx.actor.hrScope.teams || []).map((value: any) => String(value).toLowerCase())
        : null;
    const departments = allDepartments
      .filter(
        (department) =>
          !departmentNames ||
          departmentNames.includes(String(department.departmentName || "").toLowerCase())
      )
      .map((department) => ({
        id: idString(department),
        name: department.departmentName,
        teams: (department.teams || [])
          .filter(
            (team: any) =>
              !teamNames || teamNames.includes(String(team.name || "").toLowerCase())
          )
          .map((team: any) => ({ id: idString(team), name: team.name })),
      }));

    const historyMatch = scopedHistoryMatch(ctx);
    const [locationIds, managerIds] = await Promise.all([
      EmployeeAssignmentHistory.distinct("officeLocation", historyMatch),
      EmployeeAssignmentHistory.distinct("reportingManager", historyMatch),
    ]);
    const locationMatch: any = { company: ctx.company };
    if (!["admin", "hradmin"].includes(ctx.actor.role)) {
      locationMatch._id = { $in: locationIds.filter(Boolean) };
    }
    const [locations, managers] = await Promise.all([
      OfficeLocation.find(locationMatch).select("name code").sort({ name: 1 }).lean(),
      User.find({
        company: ctx.company,
        _id: { $in: managerIds.filter(Boolean) },
        deletedAt: null,
      })
        .select("name code")
        .sort({ name: 1 })
        .limit(500)
        .lean(),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        departments,
        locations: locations.map((location: any) => ({
          id: idString(location),
          name: location.name,
          code: location.code || "",
        })),
        managers: managers.map((manager: any) => ({
          id: idString(manager),
          name: manager.name || manager.code || "Manager",
          code: manager.code || "",
        })),
        managersTruncated: managers.length === 500,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function policyDetails(record: any, context: any) {
  const references = context.policyReferences || {};
  const attendancePolicyId = record?.attendancePolicy || references.attendancePolicy?.resourceId;
  const attendanceVersionId =
    record?.attendancePolicyVersion || references.attendancePolicy?.versionId;
  const workScheduleId = record?.workSchedule || references.workSchedule?.resourceId;
  const workScheduleVersionId =
    record?.workScheduleVersion || references.workSchedule?.versionId;
  const holidayCalendarId = record?.holidayCalendar || references.holidayCalendar?.resourceId;
  const holidayVersionId =
    record?.holidayCalendarVersion || references.holidayCalendar?.versionId;
  const [attendancePolicy, attendanceVersion, workSchedule, workScheduleVersion, holidayCalendar, holidayVersion] =
    await Promise.all([
      attendancePolicyId
        ? AttendancePolicy.findById(attendancePolicyId).select("name code").lean()
        : null,
      attendanceVersionId
        ? AttendancePolicyVersion.findById(attendanceVersionId)
            .select("versionNumber effectiveFrom rules")
            .lean()
        : null,
      workScheduleId
        ? WorkSchedule.findById(workScheduleId).select("name code").lean()
        : null,
      workScheduleVersionId
        ? WorkScheduleVersion.findById(workScheduleVersionId)
            .select("versionNumber effectiveFrom rules")
            .lean()
        : null,
      holidayCalendarId
        ? HolidayCalendar.findById(holidayCalendarId).select("name code").lean()
        : null,
      holidayVersionId
        ? HolidayCalendarVersion.findById(holidayVersionId)
            .select("versionNumber effectiveFrom timezone holidays")
            .lean()
        : null,
    ]);
  return {
    attendancePolicy: attendancePolicy
      ? {
          id: idString(attendancePolicy),
          name: attendancePolicy.name,
          code: attendancePolicy.code,
          versionId: idString(attendanceVersion),
          versionNumber: attendanceVersion?.versionNumber || null,
          effectiveFrom: attendanceVersion?.effectiveFrom || null,
          rules: attendanceVersion?.rules || null,
          scopeType: references.attendancePolicy?.scopeType || null,
        }
      : null,
    workSchedule: workSchedule
      ? {
          id: idString(workSchedule),
          name: workSchedule.name,
          code: workSchedule.code,
          versionId: idString(workScheduleVersion),
          versionNumber: workScheduleVersion?.versionNumber || null,
          effectiveFrom: workScheduleVersion?.effectiveFrom || null,
          rules: workScheduleVersion?.rules || null,
          scopeType: references.workSchedule?.scopeType || null,
        }
      : null,
    holidayCalendar: holidayCalendar
      ? {
          id: idString(holidayCalendar),
          name: holidayCalendar.name,
          code: holidayCalendar.code,
          versionId: idString(holidayVersion),
          versionNumber: holidayVersion?.versionNumber || null,
          effectiveFrom: holidayVersion?.effectiveFrom || null,
          scopeType: references.holidayCalendar?.scopeType || null,
        }
      : null,
  };
}

function attendanceExplanation(record: any, context: any, policies: any) {
  if (!record) {
    if (context.dayType === "weekly_off") return "No attendance was required because this was a weekly off.";
    if (String(context.dayType || "").includes("holiday")) {
      return context.holiday?.name
        ? `No attendance was required because ${context.holiday.name} was a holiday.`
        : "No attendance was required because this was a holiday.";
    }
    return "No attendance record exists for this day.";
  }

  const worked = Number(record.workedMinutes || 0);
  const fullDay = Number(policies.attendancePolicy?.rules?.minimumFullDayMinutes || 0);
  const halfDay = Number(policies.attendancePolicy?.rules?.minimumHalfDayMinutes || 0);
  const effectiveFullDay =
    Number(context.expectedWorkMinutes) > 0 && fullDay > 0
      ? Math.min(fullDay, Number(context.expectedWorkMinutes))
      : fullDay;

  if (record.status === "present") {
    return context.requiresAttendance === false
      ? `Worked ${worked} minutes on a non-working day.`
      : `Worked ${worked} minutes${effectiveFullDay ? `, meeting the ${effectiveFullDay}-minute full-day requirement` : ""}.`;
  }
  if (record.status === "half_day") {
    return `Worked ${worked} minutes${halfDay ? `, meeting the ${halfDay}-minute half-day requirement` : ""}${effectiveFullDay ? ` but below the ${effectiveFullDay}-minute full-day requirement` : ""}.`;
  }
  if (record.status === "absent") {
    return `Worked ${worked} minutes${halfDay ? `, below the ${halfDay}-minute minimum for a half day` : ""}.`;
  }
  if (record.status === "incomplete") return "Attendance is incomplete because a required punch is missing.";
  if (record.status === "pending") return "Attendance is still open and will be recalculated after the final punch-out.";
  if (record.status === "leave") return "Approved leave applies to this attendance day.";
  if (record.status === "holiday") return "This day was classified as a holiday.";
  if (record.status === "weekly_off") return "This day was classified as a weekly off.";
  return "Attendance was calculated from the recorded punches and effective policy.";
}

export async function loadAttendanceEmployeeDay(options: {
  company: mongoose.Types.ObjectId;
  employeeId: string | mongoose.Types.ObjectId;
  attendanceDate: string;
}) {
  const employeeId = String(options.employeeId);
  const employee: any = await User.findOne({ _id: employeeId, company: options.company })
    .select(EMPLOYEE_FIELDS)
    .lean();
  if (!employee || !calendarEmployeeActive(employee, options.attendanceDate)) {
    throw generateError("Employee was not active in this company on that date", 404);
  }

  const [context, record] = await Promise.all([
    resolveEmployeeDayContext({
      companyId: options.company,
      employeeId,
      attendanceDate: options.attendanceDate,
    }),
    AttendanceRecord.findOne({
      company: options.company,
      employee: employeeId,
      attendanceDate: options.attendanceDate,
    }).lean(),
  ]);
  const organization = organizationFromRecord(record) || context.organizationAssignment;
  const [revisions, leaveRequest, remoteWorkRequest, policies] = await Promise.all([
    record
      ? AttendanceRecordRevision.find({ company: options.company, attendanceRecord: record._id })
          .sort({ revisionNumber: -1, createdAt: -1 })
          .populate("actor", "name code role")
          .lean()
      : [],
    record?.leaveRequest
      ? LeaveRequest.findOne({ company: options.company, _id: record.leaveRequest })
          .select("_id status leaveTypeNameSnapshot leaveTypeCodeSnapshot leaveUnit fromDate toDate dayBreakdown reason")
          .lean()
      : LeaveRequest.findOne({
          company: options.company,
          employee: employeeId,
          status: "approved",
          "dayBreakdown.attendanceDate": options.attendanceDate,
        })
          .select("_id status leaveTypeNameSnapshot leaveTypeCodeSnapshot leaveUnit fromDate toDate dayBreakdown reason")
          .lean(),
    record?.remoteWorkRequest
      ? RemoteWorkRequest.findOne({ company: options.company, _id: record.remoteWorkRequest })
          .select("_id status fromDate toDate dates reason")
          .lean()
      : RemoteWorkRequest.findOne({
          company: options.company,
          employee: employeeId,
          status: "approved",
          "dates.attendanceDate": options.attendanceDate,
        })
          .select("_id status fromDate toDate dates reason")
          .lean(),
    policyDetails(record, context),
  ]);

  return {
    organization,
    data: {
      attendanceDate: options.attendanceDate,
      employee: {
        id: idString(employee),
        name: employee.name || "Employee",
        code: employee.code || "",
        designation: organization?.designationSnapshot || employee.designation || "",
        picture: employee.pic?.url || null,
      },
      organization: {
        departmentId: idString(organization?.department) || null,
        department: organization?.departmentNameSnapshot || employee.department || "",
        teamId: idString(organization?.teamId) || null,
        team: organization?.teamNameSnapshot || employee.team || "",
        officeLocationId: idString(organization?.officeLocation) || null,
        officeLocation: organization?.officeLocationNameSnapshot || "",
        managerId: idString(organization?.reportingManager) || null,
        manager: organization?.reportingManagerNameSnapshot || "",
      },
      context: {
        dayType: context.dayType,
        requiresAttendance: context.requiresAttendance,
        expectedWorkMinutes: context.expectedWorkMinutes,
        defaultAttendanceStatus: context.defaultAttendanceStatus,
        timezone: context.timezone,
        schedule: context.schedule,
        holiday: context.holiday,
        missingPolicies: context.missingPolicies.filter((item: string) =>
          ["attendance_policy", "work_schedule", "holiday_calendar"].includes(item)
        ),
        warnings: context.warnings,
      },
      policies,
      record,
      explanation: attendanceExplanation(record, context, policies),
      leaveRequest,
      remoteWorkRequest,
      revisions,
    },
  };
}

export async function getAttendanceEmployeeDayService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = attendanceContext(req);
    const employeeId = validId(req.params.employeeId, "employee id");
    const details = await loadAttendanceEmployeeDay({
      company: ctx.company,
      employeeId,
      attendanceDate: ctx.attendanceDate,
    });
    if (!calendarOrganizationAccess(ctx.actor, details.organization)) {
      throw generateError("You cannot view this employee's attendance", 403);
    }
    return res.status(200).json({ success: true, data: details.data });
  } catch (error) {
    next(error);
  }
}

export async function getMyAttendanceDayService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getEmployeeRequestActor(req);
    if (actor.role === "superadmin") {
      throw generateError("Attendance is available to company accounts only", 403);
    }
    const company = resolveEmployeeRequestCompanyId(actor, undefined, "attendance");
    const attendanceDate = parseAttendanceDate(String(req.params.attendanceDate || "")).dateKey;
    const details = await loadAttendanceEmployeeDay({
      company,
      employeeId: actor._id,
      attendanceDate,
    });
    return res.status(200).json({ success: true, data: details.data });
  } catch (error) {
    next(error);
  }
}
