import crypto from "crypto";
import { NextFunction, Response } from "express";
import ExcelJS from "exceljs";
import mongoose, { ClientSession } from "mongoose";
import { Readable } from "stream";
import { generateError } from "../../config/Error/functions";
import AttendanceImportBatch from "../../schemas/Attendance/AttendanceImportBatch.schema";
import AttendanceRecord, {
  ATTENDANCE_RECORD_STATUSES,
  ATTENDANCE_WORK_MODES,
} from "../../schemas/Attendance/AttendanceRecord.schema";
import AttendanceRecordRevision from "../../schemas/Attendance/AttendanceRecordRevision.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import User from "../../schemas/User/User";
import AttendancePolicyVersion from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import { calendarEmployeeActive, calendarOrganizationAccess } from "../calendar/calendar.utils";
import {
  getEmployeeRequestActor,
  resolveEmployeeRequestCompanyId,
} from "../leave/leaveAccess.utils";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import type { PermissionKey } from "../permissions/permission.utils";
import { calculateAttendance } from "./attendanceCalculator.utils";
import { loadAttendanceEmployeeDay } from "./attendanceOverview.service";
import { hasOpenPunch } from "./attendanceOverview.utils";
import { resolveEmployeeDayContext } from "./employeeDayContext.service";
import { parseAttendanceDate } from "./employeeDayContext.utils";
import {
  contextSnapshotFields,
  localAttendanceTimeToUtc,
} from "./attendanceRegularization.service";

type AttendanceOperation =
  | "adjust"
  | "set_status"
  | "set_work_mode"
  | "recalculate"
  | "finalize"
  | "reopen";

type AttendanceMutationInput = {
  operation: AttendanceOperation;
  reason: string;
  source?: "manual" | "import";
  punchInTime?: string;
  punchOutTime?: string;
  punchOutNextDay?: boolean;
  clearPunches?: boolean;
  status?: string;
  workMode?: string;
};

const MUTABLE_STATUSES = ATTENDANCE_RECORD_STATUSES.filter((status) => status !== "leave");

function text(value: unknown) {
  return String(value ?? "").trim();
}

function objectId(value: unknown, label: string) {
  const normalized = text((value as any)?._id || value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function requiredReason(value: unknown) {
  const reason = text(value);
  if (reason.length < 3) throw generateError("Reason must contain at least 3 characters", 422);
  if (reason.length > 500) throw generateError("Reason cannot exceed 500 characters", 422);
  return reason;
}

function todayInTimezone(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function recordSnapshot(record: any) {
  return record?.toObject
    ? record.toObject({ depopulate: true })
    : record
      ? { ...record }
      : null;
}

function firstPunchIn(record: any) {
  return (record?.punchSessions || [])
    .map((session: any) => session?.punchIn)
    .filter(Boolean)
    .sort((left: any, right: any) => new Date(left).getTime() - new Date(right).getTime())[0] || null;
}

function finalPunchOut(record: any) {
  return (record?.punchSessions || [])
    .map((session: any) => session?.punchOut)
    .filter(Boolean)
    .sort((left: any, right: any) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
}

function revisionSummary(record: any) {
  if (!record) return null;
  return {
    state: record.state,
    status: record.status,
    workMode: record.workMode,
    firstPunchIn: firstPunchIn(record),
    finalPunchOut: finalPunchOut(record),
    workedMinutes: Number(record.workedMinutes || 0),
    breakMinutes: Number(record.breakMinutes || 0),
    lateMinutes: Number(record.lateMinutes || 0),
    earlyExitMinutes: Number(record.earlyExitMinutes || 0),
    overtimeMinutes: Number(record.overtimeMinutes || 0),
    hasMissingPunch: record.hasMissingPunch === true,
  };
}

function assertPermission(actor: any, permission: PermissionKey, message: string) {
  if (!hasPermission(actor, permission)) throw generateError(message, 403);
}

async function assertEmployeeAccess(options: {
  actor: any;
  company: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  attendanceDate: string;
}) {
  const details = await loadAttendanceEmployeeDay({
    company: options.company,
    employeeId: options.employeeId,
    attendanceDate: options.attendanceDate,
  });
  if (!calendarOrganizationAccess(options.actor, details.organization)) {
    throw generateError("You cannot manage this employee's attendance", 403);
  }
  return details;
}

async function attendanceRules(record: any, context: any, session: ClientSession) {
  const versionId = record.attendancePolicyVersion || context.policyReferences?.attendancePolicy?.versionId;
  if (!versionId) throw generateError("Attendance policy is not configured for this date", 422);
  const version = await AttendancePolicyVersion.findOne({
    _id: versionId,
    company: record.company,
  }).session(session).lean();
  if (!version) throw generateError("Attendance policy snapshot is unavailable", 409);
  return version.rules || {};
}

async function recalculateRecord(record: any, context: any, session: ClientSession) {
  const rules = await attendanceRules(record, context, session);
  const calculation = calculateAttendance({
    attendanceDate: record.attendanceDate,
    timezone: record.timezone || context.timezone || "Asia/Kolkata",
    punchSessions: record.punchSessions || [],
    attendanceRules: rules,
    schedule: {
      startTime: record.scheduleStartTimeSnapshot || context.schedule?.startTime,
      endTime: record.scheduleEndTimeSnapshot || context.schedule?.endTime,
    },
    requiresAttendance:
      typeof record.requiresAttendanceSnapshot === "boolean"
        ? record.requiresAttendanceSnapshot
        : context.requiresAttendance,
    expectedWorkMinutes: Number.isFinite(Number(record.expectedWorkMinutesSnapshot))
      ? Number(record.expectedWorkMinutesSnapshot)
      : context.expectedWorkMinutes,
    defaultAttendanceStatus: context.defaultAttendanceStatus,
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

function normalizedStatus(value: unknown) {
  const status = text(value).toLowerCase();
  if (!(MUTABLE_STATUSES as readonly string[]).includes(status)) {
    throw generateError("Select a valid manual attendance status", 422);
  }
  return status;
}

function normalizedWorkMode(value: unknown) {
  const workMode = text(value).toLowerCase();
  if (!(ATTENDANCE_WORK_MODES as readonly string[]).includes(workMode as any)) {
    throw generateError("Select a valid work mode", 422);
  }
  return workMode;
}

async function mutateAttendance(options: {
  actor: any;
  company: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  attendanceDate: string;
  input: AttendanceMutationInput;
}) {
  const { actor, company, employeeId, attendanceDate, input } = options;
  const access = await assertEmployeeAccess({ actor, company, employeeId, attendanceDate });
  const context = await resolveEmployeeDayContext({ companyId: company, employeeId, attendanceDate });
  if (attendanceDate > todayInTimezone(context.timezone || "Asia/Kolkata")) {
    throw generateError("Future attendance cannot be changed", 422);
  }
  if (
    access.data.leaveRequest &&
    ["adjust", "set_status", "set_work_mode", "recalculate"].includes(input.operation)
  ) {
    throw generateError("Approved leave applies to this date. Change the leave request before editing attendance", 409);
  }

  let savedRecord: any = null;
  await mongoose.connection.transaction(async (session) => {
    let record: any = await AttendanceRecord.findOne({ company, employee: employeeId, attendanceDate }).session(session);
    const previous = recordSnapshot(record);

    if (input.operation === "reopen") {
      if (!record || record.state !== "finalized") throw generateError("Only finalized attendance can be reopened", 409);
      record.state = hasOpenPunch(record) ? "open" : "calculated";
    } else {
      if (record?.state === "finalized") {
        throw generateError("Attendance is finalized. Reopen it before making changes", 409);
      }
      if (["recalculate", "finalize"].includes(input.operation) && !record) {
        throw generateError("Create or mark attendance before using this action", 409);
      }
      if (!record) {
        record = new AttendanceRecord({
          company,
          employee: employeeId,
          attendanceDate,
          timezone: context.timezone || "Asia/Kolkata",
          state: "open",
          status: context.defaultAttendanceStatus || "pending",
          workMode: "office",
          workModeSource: input.source === "import" ? "import" : "manual",
          punchSessions: [],
          revisionNumber: 0,
          calculationVersion: 0,
          source: input.source === "import" ? "import" : "manual",
          createdBy: actor._id,
          ...contextSnapshotFields(context),
        });
      }

      if (["adjust", "set_work_mode"].includes(input.operation) && input.workMode !== undefined) {
        record.workMode = normalizedWorkMode(input.workMode);
        record.workModeSource = input.source === "import" ? "import" : "manual";
      }

      if (input.operation === "adjust") {
        const hasPunchInput = input.punchInTime !== undefined || input.punchOutTime !== undefined;
        if (input.clearPunches) {
          record.punchSessions = [];
        } else if (hasPunchInput) {
          const punchIn = input.punchInTime === undefined
            ? firstPunchIn(record)
            : text(input.punchInTime)
              ? localAttendanceTimeToUtc(attendanceDate, input.punchInTime, record.timezone, false)
              : null;
          const punchOut = input.punchOutTime === undefined
            ? finalPunchOut(record)
            : text(input.punchOutTime)
              ? localAttendanceTimeToUtc(
                  attendanceDate,
                  input.punchOutTime,
                  record.timezone,
                  Boolean(input.punchOutNextDay)
                )
              : null;
          if (punchIn && punchOut && new Date(punchOut).getTime() < new Date(punchIn).getTime()) {
            throw generateError("Punch-out must be after punch-in. Use next-day punch-out for overnight shifts", 422);
          }
          record.punchSessions = punchIn || punchOut
            ? [{
                punchIn,
                punchOut,
                source: input.source === "import" ? "import" : "admin",
                latitude: null,
                longitude: null,
                deviceInfo: input.source === "import" ? "Attendance import" : "HR attendance adjustment",
              }]
            : [];
        }
        if (hasPunchInput || input.clearPunches) await recalculateRecord(record, context, session);
      }

      if (input.operation === "recalculate") await recalculateRecord(record, context, session);

      if (["adjust", "set_status"].includes(input.operation) && input.status !== undefined) {
        record.status = normalizedStatus(input.status);
        record.state = record.status === "pending" ? "open" : "calculated";
      }

      if (input.operation === "set_work_mode") {
        record.workMode = normalizedWorkMode(input.workMode);
        record.workModeSource = input.source === "import" ? "import" : "manual";
      }

      if (input.operation === "finalize") {
        if (record.state === "open" || record.status === "pending" || hasOpenPunch(record)) {
          throw generateError("Open attendance cannot be finalized. Complete or correct it first", 409);
        }
        record.state = "finalized";
      }
    }

    record.revisionNumber = Number(record.revisionNumber || 0) + 1;
    record.calculationVersion = Number(record.calculationVersion || 0) + 1;
    record.calculatedAt = new Date();
    record.calculatedBy = actor._id;
    record.calculationReason = input.reason;
    record.source = input.source === "import" ? "import" : input.operation === "recalculate" ? "recalculation" : "manual";
    record.updatedBy = actor._id;
    await record.save({ session });

    const action = input.operation === "finalize"
      ? "finalized"
      : input.operation === "reopen"
        ? "reopened"
        : input.operation === "recalculate"
          ? "recalculated"
          : "manual_adjustment";
    await AttendanceRecordRevision.create([{
      company,
      attendanceRecord: record._id,
      employee: employeeId,
      revisionNumber: record.revisionNumber,
      action,
      reason: input.reason,
      changes: {
        operation: input.operation,
        before: revisionSummary(previous),
        after: revisionSummary(record),
      },
      snapshot: recordSnapshot(record),
      actor: actor._id,
      source: input.source === "import" ? "import" : input.operation === "recalculate" ? "recalculation" : "manual",
    }], { session });
    savedRecord = recordSnapshot(record);
  });
  return savedRecord;
}

function operationPermission(operation: AttendanceOperation) {
  if (operation === "finalize") return PERMISSION_KEYS.FINALIZE_ATTENDANCE;
  if (operation === "reopen") return PERMISSION_KEYS.REOPEN_ATTENDANCE;
  return PERMISSION_KEYS.ADJUST_ATTENDANCE;
}

export function operationInput(body: any, forcedOperation?: AttendanceOperation): AttendanceMutationInput {
  const operation = forcedOperation || text(body?.operation).toLowerCase() as AttendanceOperation;
  if (!["adjust", "set_status", "set_work_mode", "recalculate", "finalize", "reopen"].includes(operation)) {
    throw generateError("Select a valid attendance operation", 422);
  }
  const input: AttendanceMutationInput = {
    operation,
    reason: requiredReason(body?.reason),
    source: "manual",
  };
  if (body?.punchInTime !== undefined) input.punchInTime = text(body.punchInTime);
  if (body?.punchOutTime !== undefined) input.punchOutTime = text(body.punchOutTime);
  if (body?.punchOutNextDay !== undefined) input.punchOutNextDay = Boolean(body.punchOutNextDay);
  if (body?.clearPunches !== undefined) input.clearPunches = Boolean(body.clearPunches);
  if (body?.status !== undefined && text(body.status)) input.status = normalizedStatus(body.status);
  if (body?.workMode !== undefined && text(body.workMode)) input.workMode = normalizedWorkMode(body.workMode);
  if (operation === "set_status" && !input.status) throw generateError("Status is required", 422);
  if (operation === "set_work_mode" && !input.workMode) throw generateError("Work mode is required", 422);
  if (
    operation === "adjust" &&
    input.punchInTime === undefined &&
    input.punchOutTime === undefined &&
    !input.clearPunches &&
    !input.status &&
    !input.workMode
  ) {
    throw generateError("Change punches, status, or work mode", 422);
  }
  return input;
}

function requestContext(req: any) {
  const actor = getEmployeeRequestActor(req);
  if (actor.role === "superadmin") throw generateError("Attendance operations require a company account", 403);
  const company = resolveEmployeeRequestCompanyId(actor, undefined, "attendance operations");
  return { actor, company };
}

export async function updateAttendanceEmployeeDayService(req: any, res: Response, next: NextFunction) {
  try {
    const { actor, company } = requestContext(req);
    const employeeId = objectId(req.params.employeeId, "employee id");
    const attendanceDate = parseAttendanceDate(text(req.body?.attendanceDate)).dateKey;
    const input = operationInput(req.body, "adjust");
    assertPermission(actor, PERMISSION_KEYS.ADJUST_ATTENDANCE, "You do not have permission to adjust attendance");
    await mutateAttendance({ actor, company, employeeId, attendanceDate, input });
    const details = await loadAttendanceEmployeeDay({ company, employeeId, attendanceDate });
    return res.status(200).json({ success: true, message: "Attendance updated", data: details.data });
  } catch (error) {
    next(error);
  }
}

export async function reopenAttendanceEmployeeDayService(req: any, res: Response, next: NextFunction) {
  try {
    const { actor, company } = requestContext(req);
    const employeeId = objectId(req.params.employeeId, "employee id");
    const attendanceDate = parseAttendanceDate(text(req.body?.attendanceDate)).dateKey;
    const input = operationInput(req.body, "reopen");
    assertPermission(actor, PERMISSION_KEYS.REOPEN_ATTENDANCE, "You do not have permission to reopen attendance");
    await mutateAttendance({ actor, company, employeeId, attendanceDate, input });
    const details = await loadAttendanceEmployeeDay({ company, employeeId, attendanceDate });
    return res.status(200).json({ success: true, message: "Attendance reopened", data: details.data });
  } catch (error) {
    next(error);
  }
}

export async function bulkAttendanceOperationsService(req: any, res: Response, next: NextFunction) {
  try {
    const { actor, company } = requestContext(req);
    const attendanceDate = parseAttendanceDate(text(req.body?.attendanceDate)).dateKey;
    const input = operationInput(req.body);
    const permission = operationPermission(input.operation);
    assertPermission(actor, permission, "You do not have permission to run this attendance operation");
    const rawIds = Array.isArray(req.body?.employeeIds) ? req.body.employeeIds : [];
    if (!rawIds.length || rawIds.length > 100) throw generateError("Select between 1 and 100 employees", 422);
    const employeeIds = rawIds.map((value: unknown) => objectId(value, "employee id"));
    if (new Set(employeeIds.map(String)).size !== employeeIds.length) {
      throw generateError("Each employee can be selected once", 422);
    }
    const results: any[] = [];
    for (const employeeId of employeeIds) {
      try {
        const record = await mutateAttendance({ actor, company, employeeId, attendanceDate, input });
        results.push({ employeeId, success: true, recordId: record?._id });
      } catch (error: any) {
        results.push({ employeeId, success: false, error: error?.message || "Attendance operation failed" });
      }
    }
    const applied = results.filter((item) => item.success).length;
    return res.status(200).json({
      success: applied > 0,
      message: `${applied} of ${results.length} attendance record(s) updated`,
      data: { operation: input.operation, attendanceDate, applied, failed: results.length - applied, results },
    });
  } catch (error) {
    next(error);
  }
}

type ImportRow = {
  rowNumber: number;
  employeeCode: string;
  attendanceDate: string;
  punchInTime: string;
  punchOutTime: string;
  punchOutNextDay: boolean;
  workMode: string;
  status: string;
  reason: string;
  employeeId?: mongoose.Types.ObjectId;
};

const IMPORT_HEADERS: Record<string, keyof Omit<ImportRow, "rowNumber" | "employeeId">> = {
  employeecode: "employeeCode",
  attendancedate: "attendanceDate",
  punchintime: "punchInTime",
  punchouttime: "punchOutTime",
  punchoutnextday: "punchOutNextDay",
  workmode: "workMode",
  status: "status",
  reason: "reason",
};

function headerKey(value: unknown) {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cellValue(value: any) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value && typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((item: any) => item.text || "").join("");
    if (value.result !== undefined) return cellValue(value.result);
    if (value.text !== undefined) return text(value.text);
  }
  return text(value);
}

function booleanCell(value: unknown) {
  return ["true", "yes", "y", "1"].includes(text(value).toLowerCase());
}

async function parseImportFile(file: any): Promise<ImportRow[]> {
  if (!file?.buffer) throw generateError("Attendance CSV or XLSX file is required", 400);
  const fileName = text(file.originalname).toLowerCase();
  if (!fileName.endsWith(".csv") && !fileName.endsWith(".xlsx")) {
    throw generateError("Upload a CSV or XLSX attendance file", 422);
  }
  const workbook = new ExcelJS.Workbook();
  if (fileName.endsWith(".csv")) {
    await workbook.csv.read(Readable.from([file.buffer]) as any);
  } else {
    await workbook.xlsx.load(file.buffer as any);
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet || worksheet.rowCount < 2) throw generateError("Attendance import has no data rows", 422);
  const headerMap = new Map<number, keyof Omit<ImportRow, "rowNumber" | "employeeId">>();
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    const mapped = IMPORT_HEADERS[headerKey(cell.value)];
    if (mapped) headerMap.set(columnNumber, mapped);
  });
  for (const required of ["employeeCode", "attendanceDate", "reason"]) {
    if (![...headerMap.values()].includes(required as any)) throw generateError(`Missing ${required} column`, 422);
  }
  const rows: ImportRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw: any = {};
    headerMap.forEach((key, columnNumber) => { raw[key] = cellValue(row.getCell(columnNumber).value); });
    if (!Object.values(raw).some((value) => text(value))) return;
    rows.push({
      rowNumber,
      employeeCode: text(raw.employeeCode).toUpperCase(),
      attendanceDate: text(raw.attendanceDate),
      punchInTime: text(raw.punchInTime),
      punchOutTime: text(raw.punchOutTime),
      punchOutNextDay: booleanCell(raw.punchOutNextDay),
      workMode: text(raw.workMode).toLowerCase(),
      status: text(raw.status).toLowerCase(),
      reason: text(raw.reason),
    });
  });
  if (!rows.length) throw generateError("Attendance import has no data rows", 422);
  if (rows.length > 5000) throw generateError("Attendance import cannot exceed 5000 rows", 422);
  return rows;
}

async function validateImportRows(company: mongoose.Types.ObjectId, rows: ImportRow[]) {
  const codes = [...new Set(rows.map((row) => row.employeeCode).filter(Boolean))];
  const employees: any[] = await User.find({ company, code: { $in: codes }, role: { $ne: "superadmin" } })
    .select("_id code joiningDate createdAt employmentEndDate deletedAt")
    .lean();
  const employeeByCode = new Map(employees.map((employee) => [text(employee.code).toUpperCase(), employee]));
  const normalizedDates = new Map<number, string>();
  for (const row of rows) {
    try { normalizedDates.set(row.rowNumber, parseAttendanceDate(row.attendanceDate).dateKey); }
    catch { /* Reported in the row validation loop. */ }
  }
  const employeeIds = employees.map((employee) => employee._id);
  const attendanceDates = [...new Set(normalizedDates.values())];
  const [finalizedRecords, approvedLeaves]: any[][] = employeeIds.length && attendanceDates.length
    ? await Promise.all([
        AttendanceRecord.find({
          company,
          employee: { $in: employeeIds },
          attendanceDate: { $in: attendanceDates },
          state: "finalized",
        }).select("employee attendanceDate").lean(),
        LeaveRequest.find({
          company,
          employee: { $in: employeeIds },
          status: "approved",
          "dayBreakdown.attendanceDate": { $in: attendanceDates },
        }).select("employee dayBreakdown").lean(),
      ])
    : [[], []];
  const finalizedKeys = new Set(
    finalizedRecords.map((record) => `${record.employee}:${record.attendanceDate}`)
  );
  const approvedLeaveKeys = new Set<string>();
  for (const request of approvedLeaves) {
    for (const day of request.dayBreakdown || []) {
      if (attendanceDates.includes(day.attendanceDate) && Number(day.chargedUnits || 0) > 0) {
        approvedLeaveKeys.add(`${request.employee}:${day.attendanceDate}`);
      }
    }
  }
  const seen = new Set<string>();
  const errors: Array<{ rowNumber: number; employeeCode: string; attendanceDate: string; errors: string[] }> = [];
  const validRows: ImportRow[] = [];
  for (const row of rows) {
    const rowErrors: string[] = [];
    const employee = employeeByCode.get(row.employeeCode);
    if (!row.employeeCode) rowErrors.push("Employee code is required");
    else if (!employee) rowErrors.push("Employee code was not found in this company");
    const attendanceDate = normalizedDates.get(row.rowNumber) || "";
    if (!attendanceDate) rowErrors.push("Attendance date must use YYYY-MM-DD");
    if (employee && attendanceDate && !calendarEmployeeActive(employee, attendanceDate)) {
      rowErrors.push("Employee was not active on this date");
    }
    if (employee && attendanceDate && finalizedKeys.has(`${employee._id}:${attendanceDate}`)) {
      rowErrors.push("Attendance is finalized; reopen it before importing changes");
    }
    if (employee && attendanceDate && approvedLeaveKeys.has(`${employee._id}:${attendanceDate}`)) {
      rowErrors.push("Approved leave applies to this date");
    }
    const duplicateKey = `${row.employeeCode}:${attendanceDate}`;
    if (attendanceDate && seen.has(duplicateKey)) rowErrors.push("Duplicate employee and date in this file");
    if (attendanceDate) seen.add(duplicateKey);
    if (row.reason.length < 3) rowErrors.push("Reason must contain at least 3 characters");
    if (row.reason.length > 500) rowErrors.push("Reason cannot exceed 500 characters");
    if (row.status && !(MUTABLE_STATUSES as readonly string[]).includes(row.status)) rowErrors.push("Invalid status");
    if (row.workMode && !(ATTENDANCE_WORK_MODES as readonly string[]).includes(row.workMode as any)) rowErrors.push("Invalid work mode");
    for (const [label, value] of [["Punch-in", row.punchInTime], ["Punch-out", row.punchOutTime]]) {
      if (value && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) rowErrors.push(`${label} must use HH:mm`);
    }
    if (!row.punchInTime && !row.punchOutTime && !row.status && !row.workMode) {
      rowErrors.push("Provide punches, status, or work mode");
    }
    if (rowErrors.length) {
      errors.push({ rowNumber: row.rowNumber, employeeCode: row.employeeCode, attendanceDate: row.attendanceDate, errors: rowErrors });
    } else {
      validRows.push({ ...row, attendanceDate, employeeId: employee._id });
    }
  }
  return { validRows, errors };
}

async function importPreview(company: mongoose.Types.ObjectId, file: any) {
  const rows = await parseImportFile(file);
  const validated = await validateImportRows(company, rows);
  return {
    totalRows: rows.length,
    validRows: validated.validRows.length,
    invalidRows: validated.errors.length,
    errors: validated.errors.slice(0, 200),
    sample: validated.validRows.slice(0, 20).map(({ employeeId, ...row }) => row),
    parsedRows: validated.validRows,
  };
}

export async function previewAttendanceImportService(req: any, res: Response, next: NextFunction) {
  try {
    const { actor, company } = requestContext(req);
    assertPermission(actor, PERMISSION_KEYS.IMPORT_ATTENDANCE, "You do not have permission to import attendance");
    const preview = await importPreview(company, req.file);
    const { parsedRows, ...response } = preview;
    return res.status(200).json({ success: true, data: response });
  } catch (error) {
    next(error);
  }
}

export async function applyAttendanceImportService(req: any, res: Response, next: NextFunction) {
  try {
    const { actor, company } = requestContext(req);
    assertPermission(actor, PERMISSION_KEYS.IMPORT_ATTENDANCE, "You do not have permission to import attendance");
    assertPermission(actor, PERMISSION_KEYS.ADJUST_ATTENDANCE, "You do not have permission to adjust attendance");
    const idempotencyKey = text(req.body?.idempotencyKey);
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw generateError("Idempotency key must contain between 8 and 200 characters", 422);
    }
    if (!req.file?.buffer) throw generateError("Attendance CSV or XLSX file is required", 400);
    const fileHash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    const existing: any = await AttendanceImportBatch.findOne({ company, idempotencyKey }).lean();
    if (existing) {
      if (existing.fileHash !== fileHash) throw generateError("This idempotency key was used with another file", 409);
      if (existing.status === "processing") throw generateError("This attendance import is still processing", 409);
      return res.status(200).json({ success: true, replayed: true, data: existing.result });
    }
    const preview = await importPreview(company, req.file);
    if (preview.invalidRows) {
      const { parsedRows, ...response } = preview;
      return res.status(422).json({ success: false, message: "Fix import validation errors before applying", data: response });
    }
    let batch: any;
    try {
      batch = await AttendanceImportBatch.create({
        company,
        idempotencyKey,
        fileName: text(req.file.originalname),
        fileHash,
        status: "processing",
        totalRows: preview.totalRows,
        createdBy: actor._id,
      });
    } catch (error: any) {
      if (error?.code === 11000) throw generateError("This attendance import is already processing", 409);
      throw error;
    }
    const results: any[] = new Array(preview.parsedRows.length);
    let nextRowIndex = 0;
    const applyNextRow = async () => {
      const index = nextRowIndex++;
      if (index >= preview.parsedRows.length) return;
      const row = preview.parsedRows[index];
      try {
        const input: AttendanceMutationInput = {
          operation: "adjust",
          reason: row.reason,
          source: "import",
          ...(row.punchInTime ? { punchInTime: row.punchInTime } : {}),
          ...(row.punchOutTime ? { punchOutTime: row.punchOutTime } : {}),
          ...(row.punchOutTime ? { punchOutNextDay: row.punchOutNextDay } : {}),
          ...(row.workMode ? { workMode: row.workMode } : {}),
          ...(row.status ? { status: row.status } : {}),
        };
        const record = await mutateAttendance({
          actor,
          company,
          employeeId: row.employeeId!,
          attendanceDate: row.attendanceDate,
          input,
        });
        results[index] = { rowNumber: row.rowNumber, employeeCode: row.employeeCode, attendanceDate: row.attendanceDate, success: true, recordId: record?._id };
      } catch (error: any) {
        results[index] = { rowNumber: row.rowNumber, employeeCode: row.employeeCode, attendanceDate: row.attendanceDate, success: false, error: error?.message || "Import row failed" };
      }
      await applyNextRow();
    };
    const workerCount = Math.min(5, preview.parsedRows.length);
    await Promise.all(Array.from({ length: workerCount }, () => applyNextRow()));
    const appliedRows = results.filter((item) => item.success).length;
    const result = {
      batchId: batch._id,
      idempotencyKey,
      totalRows: results.length,
      appliedRows,
      failedRows: results.length - appliedRows,
      results,
    };
    batch.status = appliedRows === results.length ? "completed" : "completed_with_errors";
    batch.appliedRows = appliedRows;
    batch.failedRows = results.length - appliedRows;
    batch.result = result;
    batch.completedAt = new Date();
    await batch.save();
    return res.status(200).json({ success: appliedRows > 0, data: result });
  } catch (error) {
    next(error);
  }
}

export async function downloadAttendanceImportTemplateService(req: any, res: Response, next: NextFunction) {
  try {
    const { actor } = requestContext(req);
    assertPermission(actor, PERMISSION_KEYS.IMPORT_ATTENDANCE, "You do not have permission to import attendance");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Attendance Import");
    sheet.columns = [
      { header: "Employee Code", key: "employeeCode", width: 20 },
      { header: "Attendance Date", key: "attendanceDate", width: 18 },
      { header: "Punch In Time", key: "punchInTime", width: 16 },
      { header: "Punch Out Time", key: "punchOutTime", width: 17 },
      { header: "Punch Out Next Day", key: "punchOutNextDay", width: 21 },
      { header: "Work Mode", key: "workMode", width: 15 },
      { header: "Status", key: "status", width: 15 },
      { header: "Reason", key: "reason", width: 36 },
    ];
    sheet.addRow({ employeeCode: "ACME-101", attendanceDate: "2026-09-22", punchInTime: "09:30", punchOutTime: "18:15", punchOutNextDay: "No", workMode: "office", status: "", reason: "Imported from verified attendance register" });
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const instructions = workbook.addWorksheet("Instructions");
    [
      ["Field", "Rule"],
      ["Employee Code", "Required. Must match a company employee code."],
      ["Attendance Date", "Required. Use YYYY-MM-DD."],
      ["Punch times", "Optional. Use 24-hour HH:mm."],
      ["Punch Out Next Day", "Use Yes for overnight shifts."],
      ["Work Mode", "Optional: office, remote, hybrid, or field."],
      ["Status", "Optional: pending, present, absent, half_day, holiday, weekly_off, or incomplete."],
      ["Reason", "Required for every row, minimum 3 characters."],
    ].forEach((row) => instructions.addRow(row));
    instructions.getRow(1).font = { bold: true };
    instructions.columns = [{ width: 24 }, { width: 80 }];
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="attendance-import-template.xlsx"');
    return res.status(200).send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
}
