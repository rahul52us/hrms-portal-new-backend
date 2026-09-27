import ExcelJS from "exceljs";
import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceMonthlySummary from "../../schemas/Attendance/AttendanceMonthlySummary.schema";
import AttendanceOvertimeReview from "../../schemas/Attendance/AttendanceOvertimeReview.schema";
import AttendancePayrollAdjustment from "../../schemas/Attendance/AttendancePayrollAdjustment.schema";
import AttendancePayrollInput from "../../schemas/Attendance/AttendancePayrollInput.schema";
import AttendancePeriod from "../../schemas/Attendance/AttendancePeriod.schema";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";
import AttendanceRegularizationRequest from "../../schemas/Attendance/AttendanceRegularizationRequest.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import RemoteWorkRequest from "../../schemas/Request/RemoteWorkRequest.schema";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import { getEmployeeRequestActor, resolveEmployeeRequestCompanyId } from "../leave/leaveAccess.utils";
import { hasPermission, PermissionKey, PERMISSION_KEYS } from "../permissions/permission.utils";
import { finalPunchOut, firstPunchIn, idString } from "./attendanceOverview.utils";
import {
  parseAttendancePeriodKey,
  resolveAttendanceCycleRange,
} from "./attendancePeriod.service";
import {
  PAYROLL_SUMMARY_FIELDS,
  buildAttendanceEmployeeSummary,
} from "./attendanceSummary.service";

export const ATTENDANCE_EXCEPTION_REPORT_TYPES = [
  "all",
  "late_arrival",
  "early_exit",
  "absence",
  "missing_punch",
  "overtime",
  "wfh",
  "regularization",
] as const;

const REPORT_EXPORT_LIMIT = 50_000;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function escapeRegex(value: unknown) {
  return text(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePage(value: unknown, fallback: number, maximum: number) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw generateError("Invalid report pagination", 400);
  }
  return parsed;
}

function parseDate(value: unknown, label: string) {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    throw generateError(`${label} must use YYYY-MM-DD`, 422);
  }
  return date;
}

function parseDateRange(query: any) {
  const fromDate = parseDate(query?.fromDate, "From date");
  const toDate = parseDate(query?.toDate, "To date");
  if (fromDate > toDate) throw generateError("From date cannot be after to date", 422);
  const days = Math.floor((new Date(`${toDate}T00:00:00Z`).getTime() - new Date(`${fromDate}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  if (days > 366) throw generateError("Attendance reports support a maximum range of 366 days", 422);
  return { fromDate, toDate };
}

function validObjectId(value: unknown, label: string) {
  const normalized = text(value);
  if (!normalized) return "";
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function reportContext(
  req: any,
  permission: PermissionKey = PERMISSION_KEYS.VIEW_ATTENDANCE_REPORTS
) {
  const actor = getEmployeeRequestActor(req);
  if (actor.role === "superadmin") throw generateError("Attendance reports require a company account", 403);
  if (!hasPermission(actor, permission)) throw generateError("You do not have permission for this attendance report", 403);
  return {
    actor,
    company: resolveEmployeeRequestCompanyId(actor, undefined, "attendance report"),
  };
}

function actorScopeMatch(actor: any, prefix = "") {
  const field = (name: string) => `${prefix}${name}`;
  const role = text(actor.role).toLowerCase().replace(/[-\s]/g, "");
  if (["admin", "hradmin", "headhr"].includes(role)) return {};
  if (role === "hr") {
    const clauses: any[] = [];
    const departments = (actor.hrScope?.departments || []).map(text).filter(Boolean);
    const teams = (actor.hrScope?.teams || []).map(text).filter(Boolean);
    const locations = (actor.hrScope?.officeLocations || []).filter(Boolean);
    if (departments.length) clauses.push({ [field("departmentNameSnapshot")]: { $in: departments.map((value: string) => new RegExp(`^${escapeRegex(value)}$`, "i")) } });
    if (teams.length) clauses.push({ [field("teamNameSnapshot")]: { $in: teams.map((value: string) => new RegExp(`^${escapeRegex(value)}$`, "i")) } });
    if (locations.length) clauses.push({ [field("officeLocation")]: { $in: locations } });
    return clauses.length ? { $or: clauses } : { _id: { $exists: false } };
  }
  if (role === "departmenthead") {
    return { [field("departmentNameSnapshot")]: new RegExp(`^${escapeRegex(actor.department)}$`, "i") };
  }
  return { [field("reportingManager")]: actor._id };
}

function filterMatch(query: any, prefix = "") {
  const field = (name: string) => `${prefix}${name}`;
  const result: any = {};
  const department = validObjectId(query?.departmentId, "department");
  const team = validObjectId(query?.teamId, "team");
  const location = validObjectId(query?.officeLocationId, "office location");
  const manager = validObjectId(query?.managerId, "manager");
  const employee = validObjectId(query?.employeeId, "employee");
  if (department) result[field("department")] = department;
  if (team) result[field("teamId")] = team;
  if (location) result[field("officeLocation")] = location;
  if (manager) result[field("reportingManager")] = manager;
  if (employee) result[field("employee")] = employee;
  return result;
}

function employeeSearchMatch(search: unknown) {
  const normalized = text(search);
  if (!normalized) return {};
  if (normalized.length > 100) throw generateError("Report search is too long", 400);
  const regex = new RegExp(escapeRegex(normalized), "i");
  return { $or: [{ employeeNameSnapshot: regex }, { employeeCodeSnapshot: regex }] };
}

function mergeMatch(...parts: any[]) {
  const active = parts.filter((part) => part && Object.keys(part).length);
  if (!active.length) return {};
  if (active.length === 1) return active[0];
  return { $and: active };
}

function dailyItem(record: any) {
  return {
    id: idString(record),
    attendanceDate: record.attendanceDate,
    employee: {
      id: idString(record.employee),
      name: record.employee?.name || "Employee",
      code: record.employee?.code || "",
      designation: record.designationSnapshot || record.employee?.designation || "",
    },
    organization: {
      department: record.departmentNameSnapshot || "",
      team: record.teamNameSnapshot || "",
      location: record.officeLocationNameSnapshot || "",
      manager: record.reportingManagerNameSnapshot || "",
    },
    status: record.status,
    state: record.state,
    dayType: record.dayTypeSnapshot || "",
    workMode: record.workMode,
    firstIn: firstPunchIn(record),
    finalOut: finalPunchOut(record),
    workedMinutes: Number(record.workedMinutes || 0),
    lateMinutes: Number(record.lateMinutes || 0),
    earlyExitMinutes: Number(record.earlyExitMinutes || 0),
    overtimeMinutes: Number(record.overtimeMinutes || 0),
    approvedOvertimeMinutes: Number(record.approvedOvertimeMinutes || 0),
    hasMissingPunch: Boolean(record.hasMissingPunch),
    revisionNumber: Number(record.revisionNumber || 0),
  };
}

function recordExceptionMatch(type: string) {
  if (type === "late_arrival") return { $or: [{ isLate: true }, { lateMinutes: { $gt: 0 } }] };
  if (type === "early_exit") return { $or: [{ isEarlyExit: true }, { earlyExitMinutes: { $gt: 0 } }] };
  if (type === "absence") return { status: "absent" };
  if (type === "missing_punch") return { hasMissingPunch: true };
  if (type === "overtime") return { overtimeMinutes: { $gt: 0 } };
  if (type === "wfh") return { workMode: "remote" };
  if (type === "all") {
    return {
      $or: [
        { isLate: true },
        { isEarlyExit: true },
        { status: "absent" },
        { hasMissingPunch: true },
        { overtimeMinutes: { $gt: 0 } },
        { workMode: "remote" },
      ],
    };
  }
  return {};
}

async function regularizedPairs(company: mongoose.Types.ObjectId, fromDate: string, toDate: string) {
  return AttendanceRegularizationRequest.find({
    company,
    attendanceDate: { $gte: fromDate, $lte: toDate },
    status: "approved",
  }).select("employee attendanceDate").lean();
}

async function listRecordReport(options: {
  company: mongoose.Types.ObjectId;
  actor: any;
  query: any;
  fromDate: string;
  toDate: string;
  exception?: string;
  page: number;
  limit: number;
}) {
  const matchParts: any[] = [
    { company: options.company, attendanceDate: { $gte: options.fromDate, $lte: options.toDate } },
    actorScopeMatch(options.actor),
    filterMatch(options.query),
  ];
  if (options.query?.status && options.query.status !== "all") matchParts.push({ status: options.query.status });
  if (options.query?.workMode && options.query.workMode !== "all") matchParts.push({ workMode: options.query.workMode });
  if (options.exception) {
    if (options.exception === "regularization") {
      const pairs: any[] = await regularizedPairs(options.company, options.fromDate, options.toDate);
      matchParts.push(pairs.length
        ? { $or: pairs.map((item) => ({ employee: item.employee, attendanceDate: item.attendanceDate })) }
        : { _id: { $exists: false } });
    } else {
      matchParts.push(recordExceptionMatch(options.exception));
    }
  }
  const search = text(options.query?.search);
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    const employees = await User.find({ company: options.company, $or: [{ name: regex }, { code: regex }] }).select("_id").lean();
    matchParts.push({ employee: { $in: employees.map((employee) => employee._id) } });
  }
  const match = mergeMatch(...matchParts);
  const [records, total] = await Promise.all([
    AttendanceRecord.find(match)
      .sort({ attendanceDate: 1, employee: 1 })
      .skip((options.page - 1) * options.limit)
      .limit(options.limit)
      .populate("employee", "name code designation")
      .lean(),
    AttendanceRecord.countDocuments(match),
  ]);
  return {
    items: (records as any[]).map(dailyItem),
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / options.limit)),
    },
  };
}

async function liveMonthlySummaries(options: {
  company: mongoose.Types.ObjectId;
  actor: any;
  query: any;
  periodKey: string;
  page: number;
  limit: number;
}) {
  const range = parseAttendancePeriodKey(options.periodKey);
  const baseMatch = mergeMatch(
    { company: options.company, attendanceDate: { $gte: range.startDate, $lte: range.endDate } },
    actorScopeMatch(options.actor),
    filterMatch(options.query)
  );
  const employeeMatch: any = { company: options.company, role: { $ne: "superadmin" } };
  const search = text(options.query?.search);
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    employeeMatch.$or = [{ name: regex }, { code: regex }];
  }
  const eligibleEmployeeIds = search
    ? (await User.find(employeeMatch).select("_id").lean()).map((employee) => employee._id)
    : null;
  const scopedMatch = eligibleEmployeeIds ? mergeMatch(baseMatch, { employee: { $in: eligibleEmployeeIds } }) : baseMatch;
  const grouped: any[] = await AttendanceRecord.aggregate([
    { $match: scopedMatch },
    { $group: { _id: "$employee" } },
    { $sort: { _id: 1 } },
    { $facet: {
      page: [{ $skip: (options.page - 1) * options.limit }, { $limit: options.limit }],
      total: [{ $count: "count" }],
    } },
  ]);
  const employeeIds = (grouped[0]?.page || []).map((item: any) => item._id);
  const total = Number(grouped[0]?.total?.[0]?.count || 0);
  const records: any[] = employeeIds.length
    ? await AttendanceRecord.find({ ...scopedMatch, employee: { $in: employeeIds } }).sort({ employee: 1, attendanceDate: 1 }).lean()
    : [];
  const leaveIds = [...new Set(records.map((record) => idString(record.leaveRequest)).filter(Boolean))];
  const [employees, paidLeaveRequests, regularizations] = await Promise.all([
    User.find({ company: options.company, _id: { $in: employeeIds } }).select("name code employeeNumber designation department team officeLocation reportingManager").lean(),
    leaveIds.length ? LeaveRequest.find({ company: options.company, _id: { $in: leaveIds }, status: "approved", paid: true }).select("_id").lean() : Promise.resolve([]),
    regularizedPairs(options.company, range.startDate, range.endDate),
  ]);
  const recordsByEmployee = new Map<string, any[]>();
  records.forEach((record) => {
    const key = idString(record.employee);
    recordsByEmployee.set(key, [...(recordsByEmployee.get(key) || []), record]);
  });
  const paidLeaveIds = new Set((paidLeaveRequests as any[]).map(idString));
  const regularizedKeys = new Set((regularizations as any[]).map((item) => `${idString(item.employee)}:${item.attendanceDate}`));
  return {
    source: "live",
    attendancePeriodVersion: 0,
    items: (employees as any[]).map((employee) => buildAttendanceEmployeeSummary({
      records: recordsByEmployee.get(idString(employee)) || [],
      employee,
      paidLeaveRequestIds: paidLeaveIds,
      regularizedRecordKeys: regularizedKeys,
    })),
    pagination: { page: options.page, limit: options.limit, total, totalPages: Math.max(1, Math.ceil(total / options.limit)) },
  };
}

async function listMonthlyReport(options: {
  company: mongoose.Types.ObjectId;
  actor: any;
  query: any;
  periodKey: string;
  page: number;
  limit: number;
  attendancePeriodVersion?: number;
}) {
  const period: any = await AttendancePeriod.findOne({ company: options.company, periodKey: options.periodKey }).lean();
  const calendarRange = parseAttendancePeriodKey(options.periodKey);
  const lockedCalendarMonth = period?.status === "locked" &&
    period.startDate === calendarRange.startDate &&
    period.endDate === calendarRange.endDate;
  const version = options.attendancePeriodVersion || (lockedCalendarMonth ? Number(period.version || 0) : 0);
  if (!version) return liveMonthlySummaries(options);
  const match = mergeMatch(
    { company: options.company, periodKey: options.periodKey, attendancePeriodVersion: version },
    actorScopeMatch(options.actor),
    filterMatch(options.query),
    employeeSearchMatch(options.query?.search)
  );
  const [items, total] = await Promise.all([
    AttendanceMonthlySummary.find(match).sort({ employeeNameSnapshot: 1, employee: 1 }).skip((options.page - 1) * options.limit).limit(options.limit).lean(),
    AttendanceMonthlySummary.countDocuments(match),
  ]);
  return {
    source: "locked",
    attendancePeriodVersion: version,
    items,
    pagination: { page: options.page, limit: options.limit, total, totalPages: Math.max(1, Math.ceil(total / options.limit)) },
  };
}

export async function getDailyAttendanceReportService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = reportContext(req);
    const date = parseDate(req.query?.date, "Attendance date");
    const page = parsePage(req.query?.page, 1, 100_000);
    const limit = parsePage(req.query?.limit, 25, 100);
    const result = await listRecordReport({ ...ctx, query: req.query, fromDate: date, toDate: date, page, limit });
    return res.status(200).json({ success: true, data: { date, ...result } });
  } catch (error) { next(error); }
}

export async function getMonthlyAttendanceReportService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = reportContext(req);
    const periodKey = parseAttendancePeriodKey(req.query?.periodKey).periodKey;
    const page = parsePage(req.query?.page, 1, 100_000);
    const limit = parsePage(req.query?.limit, 25, 100);
    const result = await listMonthlyReport({ ...ctx, query: req.query, periodKey, page, limit });
    return res.status(200).json({ success: true, data: { periodKey, ...result } });
  } catch (error) { next(error); }
}

export async function getAttendanceExceptionsReportService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = reportContext(req);
    const range = parseDateRange(req.query);
    const type = text(req.query?.type || "all");
    if (!(ATTENDANCE_EXCEPTION_REPORT_TYPES as readonly string[]).includes(type)) throw generateError("Invalid attendance exception type", 422);
    const page = parsePage(req.query?.page, 1, 100_000);
    const limit = parsePage(req.query?.limit, 25, 100);
    const result = await listRecordReport({ ...ctx, query: req.query, ...range, exception: type, page, limit });
    return res.status(200).json({ success: true, data: { ...range, type, ...result } });
  } catch (error) { next(error); }
}

export async function getAttendanceReportsDashboardService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = reportContext(req);
    const periodKey = parseAttendancePeriodKey(req.query?.periodKey).periodKey;
    const range = parseAttendancePeriodKey(periodKey);
    const search = text(req.query?.search);
    if (search.length > 100) throw generateError("Report search is too long", 400);
    const searchMatch = search
      ? {
          employee: {
            $in: (await User.find({
              company: ctx.company,
              $or: [
                { name: new RegExp(escapeRegex(search), "i") },
                { code: new RegExp(escapeRegex(search), "i") },
              ],
            }).select("_id").lean()).map((employee) => employee._id),
          },
        }
      : {};
    const match = mergeMatch(
      { company: ctx.company, attendanceDate: { $gte: range.startDate, $lte: range.endDate } },
      actorScopeMatch(ctx.actor),
      filterMatch(req.query),
      searchMatch
    );
    const [trend, totals, pendingRegularizations, pendingOvertime, pendingLeave, pendingWfh] = await Promise.all([
      AttendanceRecord.aggregate([
        { $match: match },
        { $group: {
          _id: "$attendanceDate",
          employees: { $sum: 1 },
          present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
          leave: { $sum: { $cond: [{ $eq: ["$status", "leave"] }, 1, 0] } },
          wfh: { $sum: { $cond: [{ $eq: ["$workMode", "remote"] }, 1, 0] } },
          exceptions: { $sum: { $cond: [{ $or: ["$hasMissingPunch", "$isLate", "$isEarlyExit", { $eq: ["$status", "absent"] }] }, 1, 0] } },
        } },
        { $sort: { _id: 1 } },
      ]),
      AttendanceRecord.aggregate([
        { $match: match },
        { $group: {
          _id: null,
          records: { $sum: 1 },
          present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
          late: { $sum: { $cond: ["$isLate", 1, 0] } },
          missingPunch: { $sum: { $cond: ["$hasMissingPunch", 1, 0] } },
          wfh: { $sum: { $cond: [{ $eq: ["$workMode", "remote"] }, 1, 0] } },
          approvedOvertimeMinutes: { $sum: "$approvedOvertimeMinutes" },
        } },
      ]),
      AttendanceRegularizationRequest.countDocuments({ company: ctx.company, currentApprovers: ctx.actor._id, status: "submitted" }),
      AttendanceOvertimeReview.countDocuments({ company: ctx.company, currentApprovers: ctx.actor._id, status: "pending" }),
      LeaveRequest.countDocuments({ company: ctx.company, currentApprovers: ctx.actor._id, status: "submitted" }),
      RemoteWorkRequest.countDocuments({ company: ctx.company, currentApprovers: ctx.actor._id, status: { $in: ["submitted", "manager_approved"] } }),
    ]);
    return res.status(200).json({
      success: true,
      data: {
        periodKey,
        totals: totals[0] || { records: 0, present: 0, absent: 0, late: 0, missingPunch: 0, wfh: 0, approvedOvertimeMinutes: 0 },
        trend: trend.map((item: any) => ({ date: item._id, ...item, _id: undefined })),
        pendingApprovals: {
          regularizations: pendingRegularizations,
          overtime: pendingOvertime,
          leave: pendingLeave,
          wfh: pendingWfh,
          total: pendingRegularizations + pendingOvertime + pendingLeave + pendingWfh,
        },
      },
    });
  } catch (error) { next(error); }
}

function csvCell(value: unknown) {
  const rawValue = value === null || value === undefined ? "" : String(value);
  const stringValue = /^[=+\-@]/.test(rawValue) ? `'${rawValue}` : rawValue;
  return /[",\n\r]/.test(stringValue) ? `"${stringValue.replace(/"/g, '""')}"` : stringValue;
}

function reportMetadataRows(name: string, filters: Record<string, unknown>) {
  return [
    ["Report", name],
    ["Generated at", new Date().toISOString()],
    ["Applied filters", JSON.stringify(filters)],
  ];
}

async function sendReportExport(res: Response, options: {
  name: string;
  format: "csv" | "xlsx";
  filters: Record<string, unknown>;
  headers: string[];
  rows: Array<Array<string | number>>;
}) {
  const filename = `${options.name}-${new Date().toISOString().slice(0, 10)}`;
  if (options.format === "csv") {
    const rows = [...reportMetadataRows(options.name, options.filters), [], options.headers, ...options.rows];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
    return res.status(200).send(`\uFEFF${csv}`);
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "HRMS";
  workbook.created = new Date();
  const metadata = workbook.addWorksheet("Metadata");
  metadata.addRows(reportMetadataRows(options.name, options.filters));
  metadata.getColumn(1).width = 22;
  metadata.getColumn(2).width = 80;
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(options.headers);
  sheet.addRows(options.rows);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((column) => { column.width = 18; });
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
  return res.status(200).send(Buffer.from(buffer));
}

function recordExportRows(items: any[]) {
  return items.map((item) => [
    item.attendanceDate, item.employee.code, item.employee.name, item.employee.designation,
    item.organization.department, item.organization.team, item.organization.location,
    item.status, item.state, item.workMode, item.firstIn || "", item.finalOut || "",
    item.workedMinutes, item.lateMinutes, item.earlyExitMinutes, item.overtimeMinutes,
    item.approvedOvertimeMinutes, item.hasMissingPunch ? "Yes" : "No", item.revisionNumber,
  ]);
}

const RECORD_EXPORT_HEADERS = [
  "Date", "Employee code", "Employee", "Designation", "Department", "Team", "Location",
  "Status", "State", "Work mode", "First in", "Final out", "Worked minutes", "Late minutes",
  "Early exit minutes", "Overtime minutes", "Approved overtime minutes", "Missing punch", "Revision",
];

export async function exportAttendanceReportService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = reportContext(req, PERMISSION_KEYS.EXPORT_ATTENDANCE_REPORTS);
    const report = text(req.query?.report);
    const format = text(req.query?.format || "csv") as "csv" | "xlsx";
    if (!["csv", "xlsx"].includes(format)) throw generateError("Report export format must be csv or xlsx", 422);
    const filters = { ...req.query, report, format };

    if (report === "daily") {
      const date = parseDate(req.query?.date, "Attendance date");
      const result = await listRecordReport({ ...ctx, query: req.query, fromDate: date, toDate: date, page: 1, limit: REPORT_EXPORT_LIMIT });
      return sendReportExport(res, { name: `daily-attendance-${date}`, format, filters, headers: RECORD_EXPORT_HEADERS, rows: recordExportRows(result.items) });
    }
    if (report === "exceptions") {
      const range = parseDateRange(req.query);
      const type = text(req.query?.type || "all");
      if (!(ATTENDANCE_EXCEPTION_REPORT_TYPES as readonly string[]).includes(type)) throw generateError("Invalid attendance exception type", 422);
      const result = await listRecordReport({ ...ctx, query: req.query, ...range, exception: type, page: 1, limit: REPORT_EXPORT_LIMIT });
      return sendReportExport(res, { name: `attendance-exceptions-${type}`, format, filters, headers: RECORD_EXPORT_HEADERS, rows: recordExportRows(result.items) });
    }
    if (report === "monthly") {
      const periodKey = parseAttendancePeriodKey(req.query?.periodKey).periodKey;
      const result = await listMonthlyReport({ ...ctx, query: req.query, periodKey, page: 1, limit: REPORT_EXPORT_LIMIT });
      const days = Array.from({ length: new Date(Date.UTC(Number(periodKey.slice(0, 4)), Number(periodKey.slice(5, 7)), 0)).getUTCDate() }, (_, index) => `${periodKey}-${String(index + 1).padStart(2, "0")}`);
      const headers = ["Employee code", "Employee", "Department", "Team", "Location", ...days, "Payable days", "LOP days", "Worked minutes", "Approved OT minutes", "Exceptions"];
      const rows = result.items.map((summary: any) => {
        const byDate = new Map((summary.daily || []).map((day: any) => [day.attendanceDate, String(day.status || "").toUpperCase()]));
        return [summary.employeeCodeSnapshot, summary.employeeNameSnapshot, summary.departmentNameSnapshot || "", summary.teamNameSnapshot || "", summary.officeLocationNameSnapshot || "", ...days.map((date) => byDate.get(date) || "-"), summary.paidDays, summary.unpaidDays, summary.workedMinutes, summary.approvedOvertimeMinutes, summary.exceptionCount];
      });
      return sendReportExport(res, { name: `monthly-muster-${periodKey}`, format, filters: { ...filters, source: result.source, attendancePeriodVersion: result.attendancePeriodVersion }, headers, rows });
    }
    throw generateError("Report must be daily, monthly, or exceptions", 422);
  } catch (error) { next(error); }
}

function sumSummaryTotals(items: any[]) {
  return PAYROLL_SUMMARY_FIELDS.reduce<Record<string, number>>((totals, field) => {
    totals[field] = items.reduce((sum, item) => sum + Number(item[field] || 0), 0);
    return totals;
  }, {});
}

async function payrollView(company: mongoose.Types.ObjectId, periodKey: string, page = 1, limit = 25) {
  const period: any = await AttendancePeriod.findOne({ company, periodKey }).lean();
  const companyDocument: any = await Company.findById(company)
    .select("payrollSettings.attendanceCutoffDay")
    .lean();
  if (!companyDocument) throw generateError("Company not found", 404);
  const attendanceCutoffDay = Number(companyDocument.payrollSettings?.attendanceCutoffDay || 31);
  const cycle = period
    ? {
        periodKey,
        startDate: period.startDate,
        endDate: period.endDate,
        attendanceCutoffDay: Number(period.attendanceCutoffDay || attendanceCutoffDay),
      }
    : await resolveAttendanceCycleRange({ company, periodKey });
  const currentVersion = period?.status === "locked" ? Number(period.version || 0) : 0;
  const [latestInput, history, pendingAdjustments, summaries, total] = await Promise.all([
    AttendancePayrollInput.findOne({ company, periodKey }).sort({ version: -1 }).populate("lockedBy", "name code role").lean(),
    AttendancePayrollInput.find({ company, periodKey }).sort({ version: -1 }).limit(20).populate("lockedBy", "name code role").lean(),
    AttendancePayrollAdjustment.find({ company, targetPeriodKey: periodKey, status: "pending" }).sort({ employeeCodeSnapshot: 1 }).lean(),
    currentVersion ? AttendanceMonthlySummary.find({ company, periodKey, attendancePeriodVersion: currentVersion }).sort({ employeeNameSnapshot: 1 }).skip((page - 1) * limit).limit(limit).lean() : Promise.resolve([]),
    currentVersion ? AttendanceMonthlySummary.countDocuments({ company, periodKey, attendancePeriodVersion: currentVersion }) : Promise.resolve(0),
  ]);
  return {
    period: period || { _id: null, ...cycle, status: "open", version: 0 },
    cycle,
    settings: { attendanceCutoffDay },
    summaryVersion: currentVersion,
    summaries,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    pendingAdjustments,
    latestInput,
    history,
    canLock: Boolean(period?.status === "locked" && total > 0 && !latestInput),
  };
}

export async function updateAttendancePayrollSettingsService(
  req: any,
  res: Response,
  next: NextFunction
) {
  try {
    const ctx = reportContext(req, PERMISSION_KEYS.MANAGE_ATTENDANCE_PAYROLL);
    const attendanceCutoffDay = Number(req.body?.attendanceCutoffDay);
    if (!Number.isInteger(attendanceCutoffDay) || attendanceCutoffDay < 1 || attendanceCutoffDay > 31) {
      throw generateError("Attendance cutoff day must be between 1 and 31", 422);
    }
    const company = await Company.findOneAndUpdate(
      { _id: ctx.company, deletedAt: null },
      {
        $set: {
          "payrollSettings.attendanceCutoffDay": attendanceCutoffDay,
          updatedAt: new Date(),
        },
      },
      { new: true, runValidators: true }
    ).select("payrollSettings.attendanceCutoffDay").lean();
    if (!company) throw generateError("Company not found", 404);
    await AttendancePeriod.deleteMany({
      company: ctx.company,
      status: "open",
      version: 0,
    });
    return res.status(200).json({
      success: true,
      message: "Payroll attendance cutoff updated",
      data: {
        attendanceCutoffDay: Number((company as any).payrollSettings?.attendanceCutoffDay || 31),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getAttendancePayrollService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = reportContext(req, PERMISSION_KEYS.MANAGE_ATTENDANCE_PAYROLL);
    const periodKey = parseAttendancePeriodKey(req.params.periodKey).periodKey;
    const page = parsePage(req.query?.page, 1, 100_000);
    const limit = parsePage(req.query?.limit, 25, 100);
    return res.status(200).json({ success: true, data: await payrollView(ctx.company, periodKey, page, limit) });
  } catch (error) { next(error); }
}

export async function lockAttendancePayrollService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = reportContext(req, PERMISSION_KEYS.MANAGE_ATTENDANCE_PAYROLL);
    const periodKey = parseAttendancePeriodKey(req.params.periodKey).periodKey;
    const reason = text(req.body?.reason);
    if (reason.length < 3 || reason.length > 1000) throw generateError("Payroll lock reason must contain 3 to 1000 characters", 422);
    const requestedVersion = Number(req.body?.expectedAttendancePeriodVersion);
    if (!Number.isInteger(requestedVersion) || requestedVersion < 1) throw generateError("Expected attendance period version is required", 422);

    await mongoose.connection.transaction(async (session) => {
      const period: any = await AttendancePeriod.findOne({ company: ctx.company, periodKey }).session(session);
      if (!period || period.status !== "locked") throw generateError("Lock the attendance cycle before creating payroll input", 409);
      if (Number(period.version) !== requestedVersion) throw generateError("Attendance period changed. Refresh and try again", 409);
      const existing = await AttendancePayrollInput.exists({ company: ctx.company, periodKey }).session(session);
      if (existing) {
        throw generateError(
          "Payroll input is already locked for this cycle. Later attendance corrections are carried to a future payroll run",
          409
        );
      }
      const summaries: any[] = await AttendanceMonthlySummary.find({ company: ctx.company, periodKey, attendancePeriodVersion: requestedVersion }).session(session).lean();
      if (!summaries.length) throw generateError("Attendance cycle summaries are missing. Re-lock attendance after processing the cycle", 409);
      const latest: any = await AttendancePayrollInput.findOne({ company: ctx.company, periodKey }).sort({ version: -1 }).session(session).lean();
      const adjustments: any[] = await AttendancePayrollAdjustment.find({ company: ctx.company, targetPeriodKey: periodKey, status: "pending" }).session(session).lean();
      const currentTotals = sumSummaryTotals(summaries);
      const adjustmentTotals = PAYROLL_SUMMARY_FIELDS.reduce<Record<string, number>>((totals, field) => {
        totals[field] = adjustments.reduce((sum, item) => sum + Number(item.deltas?.[field] || 0), 0);
        return totals;
      }, {});
      const payrollTotals = PAYROLL_SUMMARY_FIELDS.reduce<Record<string, number>>((totals, field) => {
        totals[field] = Number(currentTotals[field] || 0) + Number(adjustmentTotals[field] || 0);
        return totals;
      }, {});
      const [input]: any[] = await AttendancePayrollInput.create([{
        company: ctx.company,
        attendancePeriod: period._id,
        periodKey,
        cycleStartDate: period.startDate,
        cycleEndDate: period.endDate,
        attendanceCutoffDay: Number(period.attendanceCutoffDay || 31),
        version: Number(latest?.version || 0) + 1,
        attendancePeriodVersion: requestedVersion,
        summaryCount: summaries.length,
        adjustmentCount: adjustments.length,
        totals: { current: currentTotals, adjustments: adjustmentTotals, payroll: payrollTotals },
        reason,
        status: "locked",
        lockedAt: new Date(),
        lockedBy: ctx.actor._id,
      }], { session });
      if (adjustments.length) {
        await AttendancePayrollAdjustment.updateMany(
          { _id: { $in: adjustments.map((item) => item._id) }, status: "pending" },
          { $set: { status: "included", includedInPayrollInput: input._id, includedAt: new Date() } },
          { session }
        );
      }
    });
    return res.status(201).json({ success: true, message: `Payroll attendance input for ${periodKey} locked`, data: await payrollView(ctx.company, periodKey) });
  } catch (error) { next(error); }
}

export async function exportAttendancePayrollService(req: any, res: Response, next: NextFunction) {
  try {
    const ctx = reportContext(req, PERMISSION_KEYS.MANAGE_ATTENDANCE_PAYROLL);
    const periodKey = parseAttendancePeriodKey(req.params.periodKey).periodKey;
    const format = text(req.query?.format || "xlsx") as "csv" | "xlsx";
    if (!["csv", "xlsx"].includes(format)) throw generateError("Payroll export format must be csv or xlsx", 422);
    const requestedInputVersion = req.query?.version ? Number(req.query.version) : null;
    if (requestedInputVersion !== null && (!Number.isInteger(requestedInputVersion) || requestedInputVersion < 1)) throw generateError("Invalid payroll input version", 422);
    const input: any = await AttendancePayrollInput.findOne({ company: ctx.company, periodKey, ...(requestedInputVersion ? { version: requestedInputVersion } : {}) }).sort({ version: -1 }).lean();
    if (!input) throw generateError("Lock payroll attendance input before exporting it", 409);
    const [summaries, adjustments] = await Promise.all([
      AttendanceMonthlySummary.find({ company: ctx.company, periodKey, attendancePeriodVersion: input.attendancePeriodVersion }).sort({ employeeCodeSnapshot: 1 }).lean(),
      AttendancePayrollAdjustment.find({ company: ctx.company, includedInPayrollInput: input._id }).sort({ employeeCodeSnapshot: 1 }).lean(),
    ]);
    const adjustmentByEmployee = new Map<string, any>();
    for (const item of adjustments as any[]) {
      const key = idString(item.employee);
      const current = adjustmentByEmployee.get(key) || {
        employee: item.employee,
        employeeCodeSnapshot: item.employeeCodeSnapshot,
        employeeNameSnapshot: item.employeeNameSnapshot,
        sourcePeriodKeys: [],
        deltas: {},
      };
      current.sourcePeriodKeys.push(item.sourcePeriodKey);
      for (const field of PAYROLL_SUMMARY_FIELDS) {
        current.deltas[field] = Number(current.deltas[field] || 0) + Number(item.deltas?.[field] || 0);
      }
      adjustmentByEmployee.set(key, current);
    }
    const headers = ["Employee code", "Employee", "Department", "Payable days", "LOP days", "Worked minutes", "Approved OT minutes", "Late minutes", "Early exit minutes", "Absence days", "Exceptions", "Adjustment source", "Payable days adjustment", "LOP days adjustment", "OT minutes adjustment"];
    const rows = (summaries as any[]).map((summary) => {
      const adjustment: any = adjustmentByEmployee.get(idString(summary.employee));
      adjustmentByEmployee.delete(idString(summary.employee));
      return [summary.employeeCodeSnapshot, summary.employeeNameSnapshot, summary.departmentNameSnapshot || "", summary.paidDays, summary.unpaidDays, summary.workedMinutes, summary.approvedOvertimeMinutes, summary.lateMinutes, summary.earlyExitMinutes, summary.absentDays, summary.exceptionCount, adjustment?.sourcePeriodKeys?.join(" | ") || "", adjustment?.deltas?.paidDays || 0, adjustment?.deltas?.unpaidDays || 0, adjustment?.deltas?.approvedOvertimeMinutes || 0];
    });
    for (const adjustment of adjustmentByEmployee.values()) {
      rows.push([
        adjustment.employeeCodeSnapshot,
        adjustment.employeeNameSnapshot,
        "",
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        adjustment.sourcePeriodKeys.join(" | "),
        adjustment.deltas.paidDays || 0,
        adjustment.deltas.unpaidDays || 0,
        adjustment.deltas.approvedOvertimeMinutes || 0,
      ]);
    }
    return sendReportExport(res, { name: `payroll-attendance-${periodKey}-v${input.version}`, format, filters: { periodKey, cycleStartDate: input.cycleStartDate, cycleEndDate: input.cycleEndDate, attendanceCutoffDay: input.attendanceCutoffDay, payrollInputVersion: input.version, attendancePeriodVersion: input.attendancePeriodVersion }, headers, rows });
  } catch (error) { next(error); }
}
