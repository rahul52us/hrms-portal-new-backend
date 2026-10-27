import mongoose from "mongoose";
import User from "../../schemas/User/User";
import History from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import WorkforceAssignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import ScheduleVersion from "../../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
import HolidayVersion from "../../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
import PolicyVersion from "../../schemas/WorkforcePolicy/TimesheetPolicyVersion.schema";
import Attendance from "../../schemas/Attendance/AttendanceRecord.schema";
import Leave from "../../schemas/Leave/LeaveRequest.schema";
import ProjectAssignment from "../../schemas/project/ProjectAssignment.schema";
import Timesheet from "../../schemas/Timesheet/Timesheet.schema";
import { generateError } from "../../config/Error/functions";
import { buildEmployeeDayContext, parseAttendanceDate } from "../attendance/employeeDayContext.utils";
import { resolveEmployeeDayContext } from "../attendance/employeeDayContext.service";
import { effectiveOn, selectCalendarPolicy } from "../calendar/calendar.utils";
import { buildTimesheetDay } from "./timesheetContext.service";
import { addDateDays, dateInZone } from "./timesheet.utils";
import { plannerDaySummary, plannerPeriods } from "./timesheetPlanner.utils";

export async function loadMyTimesheetPlanner(company: mongoose.Types.ObjectId, employeeId: mongoose.Types.ObjectId, from: string, to: string, now = new Date()) {
  if (from > to || to >= addDateDays(from, 42)) throw generateError("Planner range must contain 1 to 42 days", 400);
  const employee: any = await User.findOne({ _id: employeeId, company, deletedAt: null }).select("_id company name code joiningDate employmentEndDate is_enabled department team officeLocation").lean();
  if (!employee) throw generateError("Employee not found", 404);
  let current = await resolveEmployeeDayContext({ companyId: company, employeeId, attendanceDate: now.toISOString().slice(0, 10) });
  let timezone = current.timezone || "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now); } catch { timezone = "UTC"; }
  const localDate = dateInZone(now, timezone);
  if (localDate !== current.attendanceDate) {
    current = await resolveEmployeeDayContext({ companyId: company, employeeId, attendanceDate: localDate });
    timezone = current.timezone || timezone;
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now); } catch { timezone = "UTC"; }
  }
  const today = dateInZone(now, timezone), periods = plannerPeriods(today);
  const start = parseAttendanceDate(from).date, end = parseAttendanceDate(to).date;
  const histories: any[] = await History.find({ company, employee: employeeId, effectiveFrom: { $lte: end }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: start } }] }).sort({ effectiveFrom: -1 }).lean();
  const scopeMatches: any[] = [{ scopeType: "company", scopeId: null }, { scopeType: "employee", scopeId: employeeId }];
  for (const [scopeType, field] of [["department", "department"], ["team", "teamId"], ["location", "officeLocation"]]) {
    const values = [...new Set([...histories.map((h) => h[field]), ...(scopeType === "location" ? [employee.officeLocation] : [])].filter(Boolean).map(String))].filter(mongoose.Types.ObjectId.isValid);
    if (values.length) scopeMatches.push({ scopeType, scopeId: { $in: values.map((value) => new mongoose.Types.ObjectId(value)) } });
  }
  // Load configuration once for this employee's historical scopes, never the company roster.
  const assignments: any[] = await WorkforceAssignment.find({ company, resourceType: { $in: ["work_schedule", "holiday_calendar", "timesheet_policy"] }, effectiveFrom: { $lte: end }, $and: [{ $or: [{ effectiveTo: null }, { effectiveTo: { $gt: start } }] }, { $or: scopeMatches }] }).sort({ priority: -1, effectiveFrom: -1, createdAt: -1 }).lean();
  const resources = (type: string) => assignments.filter((a) => a.resourceType === type).map((a) => a.resource);
  const [schedules, calendars, policies, records, leaves, memberships, sheets] = await Promise.all([
    ScheduleVersion.find({ company, schedule: { $in: resources("work_schedule") }, status: "published", effectiveFrom: { $lte: end } }).lean(),
    HolidayVersion.find({ company, calendar: { $in: resources("holiday_calendar") }, status: "published", effectiveFrom: { $lte: end } }).lean(),
    PolicyVersion.find({ company, policy: { $in: resources("timesheet_policy") }, status: "published", effectiveFrom: { $lte: end } }).lean(),
    Attendance.find({ company, employee: employeeId, attendanceDate: { $gte: from, $lte: to } }).select("attendanceDate state status workMode revisionNumber punchSessions hasMissingPunch workedMinutes").lean(),
    Leave.find({ company, employee: employeeId, status: "approved", dayBreakdown: { $elemMatch: { attendanceDate: { $gte: from, $lte: to } } } }).select("unit dayBreakdown").lean(),
    ProjectAssignment.find({ company, employee: employeeId, status: "assigned", effectiveFrom: { $lte: to }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: from } }] }).select("effectiveFrom effectiveTo").lean(),
    Timesheet.find({ company, employee: employeeId, $or: [{ attendanceDate: { $gte: from, $lte: to } }, ...Object.values(periods).map((p) => ({ attendanceDate: { $gte: p.from, $lte: p.to } }))] }).select("attendanceDate status revision loggedMinutes requiredMinutes payrollLockedAt").limit(85).lean(),
  ]);
  const data = [];
  for (let date = from; date <= to; date = addDateDays(date, 1)) {
    const history = histories.find((item) => effectiveOn(item, date));
    const organization: any = history || { departmentNameSnapshot: employee.department || "", teamNameSnapshot: employee.team || "", officeLocation: employee.officeLocation || null, source: "current_user_fallback" };
    const scopes: any[] = [["company", ""], ["employee", String(employeeId)], ["department", String(history?.department || "")], ["team", String(history?.teamId || "")], ["location", String(organization.officeLocation || "")]];
    const resolve = (type: string, versions: any[]) => selectCalendarPolicy(assignments.filter((a) => a.resourceType === type && scopes.some(([scope, id]) => a.scopeType === scope && String(a.scopeId || "") === id)), versions, date);
    const context = buildEmployeeDayContext({ attendanceDate: date, policyResolution: { employee, at: parseAttendanceDate(date).date, organizationAssignment: organization,
      workSchedule: resolve("work_schedule", schedules), holidayCalendar: resolve("holiday_calendar", calendars), timesheetPolicy: resolve("timesheet_policy", policies) } });
    const day = buildTimesheetDay({ employee, context, record: records.find((r: any) => r.attendanceDate === date), leaves: leaves as any[], assigned: memberships.some((m: any) => m.effectiveFrom <= date && (!m.effectiveTo || m.effectiveTo >= date)), now });
    data.push(plannerDaySummary(day, sheets.find((s: any) => s.attendanceDate === date), today));
  }
  const total = (period: { from: string; to: string }) => sheets.filter((s: any) => s.attendanceDate >= period.from && s.attendanceDate <= period.to).reduce((sum, s: any) => sum + s.loggedMinutes, 0);
  return { data, today, timezone, range: { from, to }, periods,
    totals: { todayMinutes: total(periods.today), weekMinutes: total(periods.week), monthMinutes: total(periods.month) } };
}
