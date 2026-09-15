import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import User from "../../schemas/User/User";
import Department from "../../schemas/Department/Department.schema";
import OfficeLocation from "../../schemas/OfficeLocation/OfficeLocation.schema";
import EmployeeAssignmentHistory from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import WorkforcePolicyAssignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import WorkScheduleVersion from "../../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
import HolidayCalendarVersion from "../../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import RemoteWorkRequest from "../../schemas/Request/RemoteWorkRequest.schema";
import { getEmployeeRequestActor, resolveEmployeeRequestCompanyId } from "../leave/leaveAccess.utils";
import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";
import {
  CalendarCategory, CalendarScope, calendarDates, calendarId, calendarOrganizationAccess,
  calendarEmployeeActive, calendarVisible, calendarRequestEvent, calendarDayClassification,
  calendarRowMatches, canUseOrganizationCalendar, effectiveOn, selectCalendarPolicy,
} from "./calendar.utils";

const EMPLOYEE_FIELDS = "_id name code company department team officeLocation reportingManager joiningDate createdAt employmentEndDate deletedAt";
const REQUEST_FIELDS = "_id employee employeeNameSnapshot leaveTypeNameSnapshot leaveTypeCodeSnapshot leaveUnit fromDate toDate dayBreakdown dates reason status currentApprovers approver approvalInstance cancellationStatus";

function validId(value: any, label: string) {
  const id = String(value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) throw generateError(`Invalid ${label}`, 400);
  return id;
}

async function context(req: any, singleDate = false) {
  const actor = getEmployeeRequestActor(req);
  if (actor.role === "superadmin") throw generateError("The workforce calendar is available to company accounts only", 403);
  const company = resolveEmployeeRequestCompanyId(actor, req.query.companyId, "calendar");
  const scope = String(req.query.scope || "mine") as CalendarScope;
  if (!["mine", "reportees", "organization"].includes(scope)) throw generateError("scope must be mine, reportees, or organization", 400);
  if (scope === "organization" && !canUseOrganizationCalendar(actor)) throw generateError("You cannot view the organization calendar", 403);
  const dates = singleDate ? [parseAttendanceDate(String(req.query.date || "")).dateKey] : calendarDates(String(req.query.fromDate || ""), String(req.query.toDate || ""));
  const filters: any = {};
  for (const key of ["departmentId", "teamId", "officeLocationId", "employeeId"]) {
    if (req.query[key]) filters[key] = validId(req.query[key], key);
  }
  const search = String(req.query.search || "").trim();
  if (search.length > 100) throw generateError("Calendar search is too long", 400);
  filters.search = search;
  const category = String(req.query.category || "all") as CalendarCategory;
  if (!["all", "leave", "wfh", "holiday", "weekly_off"].includes(category)) throw generateError("Invalid calendar category", 400);
  if (req.query.includePending !== undefined && !["true", "false"].includes(String(req.query.includePending))) throw generateError("includePending must be true or false", 400);
  return { actor, company, scope, dates, filters, category, includePending: req.query.includePending === "true" };
}

async function calendarData(company: mongoose.Types.ObjectId, dates: string[]) {
  const from = parseAttendanceDate(dates[0]).date;
  const to = parseAttendanceDate(dates[dates.length - 1]).date;
  const departments: any[] = await Department.find({ company }).select("departmentName teams").lean();
  const assignments: any[] = await WorkforcePolicyAssignment.find({
    company, resourceType: { $in: ["work_schedule", "holiday_calendar"] }, effectiveFrom: { $lte: to },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: from } }],
  }).lean();
  const resources = (type: string) => assignments.filter((item) => item.resourceType === type).map((item) => item.resource);
  const schedules: any[] = await WorkScheduleVersion.find({ company, schedule: { $in: resources("work_schedule") }, status: "published", effectiveFrom: { $lte: to } }).select("schedule status effectiveFrom versionNumber rules").lean();
  const holidays: any[] = await HolidayCalendarVersion.find({ company, calendar: { $in: resources("holiday_calendar") }, status: "published", effectiveFrom: { $lte: to } }).select("calendar status effectiveFrom versionNumber timezone holidays").lean();
  const assignmentIndex = new Map<string, any[]>();
  for (const item of assignments) {
    const key = `${item.resourceType}:${item.scopeType}:${calendarId(item.scopeId)}`;
    assignmentIndex.set(key, [...(assignmentIndex.get(key) || []), item]);
  }
  const versionIndex = new Map<string, any[]>();
  for (const [type, values] of [["work_schedule", schedules], ["holiday_calendar", holidays]] as const) {
    for (const item of values) {
      const key = `${type}:${calendarId(item.schedule || item.calendar)}`;
      versionIndex.set(key, [...(versionIndex.get(key) || []), item]);
    }
  }
  const classificationCache = new Map<string, any>();
  const resolutionCache = new Map<string, any>();
  const classify = (employee: any, organization: any, date: string) => {
    const hasEmployeeOverride = ["work_schedule", "holiday_calendar"].some((type) => assignmentIndex.has(`${type}:employee:${calendarId(employee)}`));
    const resolutionKey = `${date}:${calendarId(organization?.department)}:${calendarId(organization?.teamId)}:${calendarId(organization?.officeLocation)}:${hasEmployeeOverride ? calendarId(employee) : ""}`;
    if (resolutionCache.has(resolutionKey)) return resolutionCache.get(resolutionKey);
    const scopes = [["company", ""], ["employee", calendarId(employee)], ["department", calendarId(organization?.department)], ["team", calendarId(organization?.teamId)], ["location", calendarId(organization?.officeLocation)]];
    const resolve = (type: string) => {
      const candidates = scopes.flatMap(([scope, id]) => scope !== "company" && !id ? [] : assignmentIndex.get(`${type}:${scope}:${id}`) || []);
      const versions = candidates.flatMap((item) => versionIndex.get(`${type}:${calendarId(item.resource)}`) || []);
      return selectCalendarPolicy(candidates, versions, date);
    };
    const schedule = resolve("work_schedule");
    const holiday = resolve("holiday_calendar");
    const key = `${date}:${calendarId(schedule?.version)}:${calendarId(holiday?.version)}`;
    if (!classificationCache.has(key)) classificationCache.set(key, calendarDayClassification(date, schedule, holiday));
    const result = classificationCache.get(key);
    resolutionCache.set(resolutionKey, result);
    return result;
  };
  return { departments, classify, from, to };
}

function fallbackOrganization(employee: any, departments: any[]) {
  const department = departments.find((item) => String(item.departmentName).toLowerCase() === String(employee.department || "").toLowerCase());
  const team = department?.teams?.find((item: any) => String(item.name).toLowerCase() === String(employee.team || "").toLowerCase());
  return {
    department: department?._id || null, departmentNameSnapshot: employee.department || "",
    teamId: team?._id || null, teamNameSnapshot: employee.team || "",
    officeLocation: employee.officeLocation || null, officeLocationNameSnapshot: "",
    reportingManager: employee.reportingManager || null, source: "current_user_fallback",
  };
}

// Stream employees in batches; policy configuration is fetched once, not once per employee/day.
async function visitCalendarRows(ctx: Awaited<ReturnType<typeof context>>, visit: (row: any) => boolean | void) {
  const data = await calendarData(ctx.company, ctx.dates);
  let after: any = null;
  const diagnostics = { currentAssignmentFallbackEmployees: 0, missingHistoryEmployees: 0 };
  for (;;) {
    const match: any = { company: ctx.company, role: { $ne: "superadmin" } };
    if (ctx.scope === "mine") match._id = ctx.actor._id;
    else if (ctx.filters.employeeId) match._id = new mongoose.Types.ObjectId(ctx.filters.employeeId);
    if (after) match._id = { $gt: after };
    if (ctx.filters.search) {
      const regex = new RegExp(ctx.filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      match.$or = [{ name: regex }, { code: regex }];
    }
    const employees: any[] = await User.find(match).select(EMPLOYEE_FIELDS).sort({ _id: 1 }).limit(250).lean();
    if (!employees.length) break;
    const ids = employees.map((item) => item._id);
    const histories: any[] = await EmployeeAssignmentHistory.find({ company: ctx.company, employee: { $in: ids }, effectiveFrom: { $lte: data.to }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: data.from } }] }).sort({ effectiveFrom: -1 }).lean();
    const hasHistory = new Set((await EmployeeAssignmentHistory.distinct("employee", { company: ctx.company, employee: { $in: ids } })).map(calendarId));
    const historiesByEmployee = new Map<string, any[]>();
    for (const history of histories) {
      const key = calendarId(history.employee);
      historiesByEmployee.set(key, [...(historiesByEmployee.get(key) || []), history]);
    }
    const requestMatch = { company: ctx.company, employee: { $in: ids }, fromDate: { $lte: ctx.dates[ctx.dates.length - 1] }, toDate: { $gte: ctx.dates[0] }, status: { $in: ["submitted", "manager_approved", "approved"] } };
    const leave: any[] = await LeaveRequest.find(requestMatch).select(REQUEST_FIELDS).lean();
    const wfh: any[] = await RemoteWorkRequest.find(requestMatch).select(REQUEST_FIELDS).lean();
    const eventsByDay = new Map<string, Array<{ kind: "leave" | "wfh"; request: any; day: any }>>();
    for (const [kind, requests] of [["leave", leave], ["wfh", wfh]] as const) {
      for (const request of requests) for (const day of kind === "leave" ? request.dayBreakdown || [] : request.dates || []) {
        if (day.attendanceDate < ctx.dates[0] || day.attendanceDate > ctx.dates[ctx.dates.length - 1]) continue;
        const key = `${calendarId(request.employee)}:${day.attendanceDate}`;
        eventsByDay.set(key, [...(eventsByDay.get(key) || []), { kind, request, day }]);
      }
    }
    for (const employee of employees) {
      let usedFallback = false;
      let missingHistory = false;
      for (const date of ctx.dates) {
        if (!calendarEmployeeActive(employee, date)) continue;
        const history = (historiesByEmployee.get(calendarId(employee)) || []).find((item) => effectiveOn(item, date));
        const organization = history || (!hasHistory.has(calendarId(employee)) && !employee.deletedAt ? fallbackOrganization(employee, data.departments) : null);
        if (!calendarVisible(ctx.actor, ctx.scope, employee, organization, ctx.filters)) continue;
        if (!history && organization) usedFallback = true;
        if (!organization) missingHistory = true;
        const classification = organization ? data.classify(employee, organization, date) : calendarDayClassification(date, null, null);
        const events = (eventsByDay.get(`${calendarId(employee)}:${date}`) || []).map(({ kind, request, day }) =>
          calendarRequestEvent(ctx.actor, ctx.scope, employee, organization, kind, request, day)
        ).filter((event) => event && (ctx.includePending || event.status === "approved"));
        const stop = visit({ date, employee: { id: calendarId(employee), name: employee.name || "Employee", code: employee.code || "" },
          department: organization?.departmentNameSnapshot || "", team: organization?.teamNameSnapshot || "", officeLocation: organization?.officeLocationNameSnapshot || "",
          dayType: classification.dayType, holiday: classification.holiday, schedule: classification.schedule,
          events, assignmentSource: history ? "history" : organization ? "current_assignment_fallback" : "missing_history",
          timezone: classification.timezone,
        });
        if (stop) return diagnostics;
      }
      if (usedFallback) diagnostics.currentAssignmentFallbackEmployees += 1;
      if (missingHistory) diagnostics.missingHistoryEmployees += 1;
    }
    if (ctx.scope === "mine" || ctx.filters.employeeId || employees.length < 250) break;
    after = employees[employees.length - 1]._id;
  }
  return diagnostics;
}

export async function getCalendarSummaryService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = await context(req);
    const days = new Map(ctx.dates.map((date) => [date, { date, employees: 0, onLeave: 0, wfh: 0, pendingLeave: 0, pendingWfh: 0, weeklyOff: 0, holiday: 0, optionalHoliday: 0, unconfigured: 0, holidays: [] as any[], events: [] as any[] }]));
    const diagnostics = await visitCalendarRows(ctx, (row) => {
      const day = days.get(row.date)!;
      day.employees += 1;
      for (const [kind, field] of [["leave", "onLeave"], ["wfh", "wfh"]] as const) if (row.events.some((event: any) => event.kind === kind && event.status === "approved")) day[field] += 1;
      if (row.events.some((event: any) => event.kind === "leave" && event.status !== "approved")) day.pendingLeave += 1;
      if (row.events.some((event: any) => event.kind === "wfh" && event.status !== "approved")) day.pendingWfh += 1;
      if (row.dayType === "weekly_off") day.weeklyOff += 1;
      if (row.dayType === "unconfigured") day.unconfigured += 1;
      if (row.holiday) {
        if (row.holiday.type === "optional") day.optionalHoliday += 1; else day.holiday += 1;
        let item = day.holidays.find((item: any) => item.name === row.holiday.name && item.type === row.holiday.type && item.isHalfDay === row.holiday.isHalfDay);
        if (!item) { item = { name: row.holiday.name, type: row.holiday.type, isHalfDay: row.holiday.isHalfDay, employees: 0 }; day.holidays.push(item); }
        item.employees += 1;
      }
      if (ctx.scope === "mine") day.events.push(...row.events);
    });
    return res.json({ success: true, data: { scope: ctx.scope, fromDate: ctx.dates[0], toDate: ctx.dates[ctx.dates.length - 1], days: [...days.values()], diagnostics } });
  } catch (error) { next(error); }
}

export async function getCalendarDayService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = await context(req, true);
    const parseInteger = (value: any, fallback: number, max: number) => {
      const result = value === undefined ? fallback : Number(value);
      if (!Number.isSafeInteger(result) || result < 1 || result > max) throw generateError("Invalid calendar pagination", 400);
      return result;
    };
    const page = parseInteger(req.query.page, 1, 100000);
    const limit = parseInteger(req.query.limit, 20, 50);
    const skip = (page - 1) * limit;
    let total = 0;
    const items: any[] = [];
    await visitCalendarRows(ctx, (row) => {
      if (!(ctx.scope === "mine" && ctx.category === "all") && !calendarRowMatches(row, ctx.category, ctx.includePending)) return;
      row.events = row.events.filter((event: any) => ctx.category === "all" || !["leave", "wfh"].includes(ctx.category) || event.kind === ctx.category);
      if (total >= skip && items.length < limit) items.push(row);
      total += 1;
    });
    return res.json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
}

export async function listCalendarEmployeesService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = await context(req, true);
    const items: any[] = [];
    await visitCalendarRows(ctx, (row) => { items.push(row.employee); return items.length >= 30; });
    return res.json({ success: true, data: items });
  } catch (error) { next(error); }
}

export async function getCalendarOptionsService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = await context(req);
    const scopes: CalendarScope[] = ["mine"];
    const reportee = await User.exists({ company: ctx.company, reportingManager: ctx.actor._id, deletedAt: null, _id: { $ne: ctx.actor._id } });
    const historicalReportee = await EmployeeAssignmentHistory.exists({ company: ctx.company, reportingManager: ctx.actor._id, effectiveFrom: { $lte: parseAttendanceDate(ctx.dates[ctx.dates.length - 1]).date }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: parseAttendanceDate(ctx.dates[0]).date } }] });
    if (reportee || historicalReportee) scopes.push("reportees");
    if (canUseOrganizationCalendar(ctx.actor)) scopes.push("organization");
    const allDepartments: any[] = await Department.find({ company: ctx.company }).select("departmentName teams").sort({ departmentName: 1 }).lean();
    const reporteeAssignments: any[] = scopes.includes("reportees") && !scopes.includes("organization")
      ? await EmployeeAssignmentHistory.find({ company: ctx.company, reportingManager: ctx.actor._id, effectiveFrom: { $lte: parseAttendanceDate(ctx.dates[ctx.dates.length - 1]).date }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: parseAttendanceDate(ctx.dates[0]).date } }] }).select("department departmentNameSnapshot teamId officeLocation").lean() : [];
    const currentReportees: any[] = scopes.includes("reportees") && !scopes.includes("organization")
      ? await User.find({ company: ctx.company, reportingManager: ctx.actor._id, deletedAt: null }).select("department team officeLocation").lean() : [];
    const departmentAllowed = (department: any) => {
      if (!scopes.includes("organization")) return reporteeAssignments.some((item) => calendarId(item.department) === calendarId(department)) || currentReportees.some((item) => String(item.department).toLowerCase() === String(department.departmentName).toLowerCase());
      if (["admin", "hradmin"].includes(ctx.actor.role)) return true;
      const names = ctx.actor.role === "hr" ? ctx.actor.hrScope?.departments || [] : [ctx.actor.department];
      return names.some((name: string) => String(name || "").toLowerCase() === String(department.departmentName).toLowerCase());
    };
    const departments = scopes.length > 1 ? allDepartments.filter(departmentAllowed).map((department) => ({
      id: calendarId(department), name: department.departmentName,
      teams: (department.teams || []).filter((team: any) => ctx.actor.role !== "hr" || !(ctx.actor.hrScope?.teams || []).length || ctx.actor.hrScope.teams.some((name: string) => name.toLowerCase() === team.name.toLowerCase())).map((team: any) => ({ id: calendarId(team), name: team.name })),
    })) : [];
    const locationMatch: any = { company: ctx.company };
    if (ctx.actor.role === "hr" && (ctx.actor.hrScope?.officeLocations || []).length) locationMatch._id = { $in: ctx.actor.hrScope.officeLocations };
    if (!scopes.includes("organization")) locationMatch._id = { $in: [...reporteeAssignments, ...currentReportees].map((item) => item.officeLocation).filter(Boolean) };
    const locations = scopes.length > 1 ? (await OfficeLocation.find(locationMatch).select("name").sort({ name: 1 }).lean()).map((location) => ({ id: calendarId(location), name: location.name })) : [];
    return res.json({ success: true, data: { scopes, departments, locations } });
  } catch (error) { next(error); }
}
