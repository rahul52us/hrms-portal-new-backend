import mongoose, { ClientSession } from "mongoose";
import AttendanceMonthlySummary from "../../schemas/Attendance/AttendanceMonthlySummary.schema";
import AttendancePayrollAdjustment from "../../schemas/Attendance/AttendancePayrollAdjustment.schema";
import AttendancePayrollInput from "../../schemas/Attendance/AttendancePayrollInput.schema";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";
import AttendanceRegularizationRequest from "../../schemas/Attendance/AttendanceRegularizationRequest.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import User from "../../schemas/User/User";

export const PAYROLL_SUMMARY_FIELDS = [
  "paidDays",
  "unpaidDays",
  "workedMinutes",
  "approvedOvertimeMinutes",
  "lateMinutes",
  "earlyExitMinutes",
  "absentDays",
  "exceptionCount",
] as const;

const roundUnits = (value: number) => Math.round((Number(value) || 0) * 100) / 100;
const idString = (value: any) => String(value?._id || value || "");

function leaveDayUnits(record: any) {
  const rawUnits = Math.max(0, Number(record.leaveUnits || 0));
  if (record.leaveUnit === "hours") {
    const expectedHours = Math.max(0.25, Number(record.expectedWorkMinutesSnapshot || 480) / 60);
    return Math.min(1, rawUnits / expectedHours);
  }
  if (rawUnits) return Math.min(1, rawUnits);
  if (record.status === "leave") return 1;
  if (record.status === "half_day" && record.leaveRequest) return 0.5;
  return 0;
}

export function nextAttendancePeriodKey(periodKey: string) {
  const [year, month] = periodKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function attendanceDayPayrollUnits(record: any, paidLeave: boolean) {
  const status = String(record.status || "pending");
  if (status === "pending" || (status === "incomplete" && record.state !== "finalized")) {
    return { paidUnits: 0, unpaidUnits: 0 };
  }
  const leaveUnits = leaveDayUnits(record);
  const nonWorkingDay = record.requiresAttendanceSnapshot === false || ["holiday", "weekly_off"].includes(status);

  if (nonWorkingDay) return { paidUnits: 1, unpaidUnits: 0 };
  if (status === "present") return { paidUnits: 1, unpaidUnits: 0 };

  if (status === "half_day") {
    const workedUnits = 0.5;
    const paidUnits = Math.min(1, workedUnits + (paidLeave ? leaveUnits : 0));
    return { paidUnits: roundUnits(paidUnits), unpaidUnits: roundUnits(1 - paidUnits) };
  }

  if (status === "leave") {
    const chargedUnits = leaveUnits || 1;
    const paidUnits = paidLeave ? chargedUnits : 0;
    return { paidUnits: roundUnits(paidUnits), unpaidUnits: roundUnits(1 - paidUnits) };
  }

  return { paidUnits: 0, unpaidUnits: 1 };
}

function dayExceptions(record: any, regularized: boolean) {
  const exceptions: string[] = [];
  if (record.hasMissingPunch) exceptions.push("missing_punch");
  if (record.isLate || Number(record.lateMinutes || 0) > 0) exceptions.push("late_arrival");
  if (record.isEarlyExit || Number(record.earlyExitMinutes || 0) > 0) exceptions.push("early_exit");
  if (record.status === "absent") exceptions.push("absence");
  if (Number(record.overtimeMinutes || 0) > 0) exceptions.push("overtime");
  if (record.workMode === "remote") exceptions.push("wfh");
  if (regularized) exceptions.push("regularization");
  return exceptions;
}

export function buildAttendanceEmployeeSummary(options: {
  records: any[];
  employee: any;
  paidLeaveRequestIds?: Set<string>;
  regularizedRecordKeys?: Set<string>;
}) {
  const records = [...options.records].sort((a, b) => String(a.attendanceDate).localeCompare(String(b.attendanceDate)));
  const latest = records[records.length - 1] || {};
  const paidLeaveIds = options.paidLeaveRequestIds || new Set<string>();
  const regularizedKeys = options.regularizedRecordKeys || new Set<string>();
  const daily = records.map((record) => {
    const paidLeave = record.leaveRequest ? paidLeaveIds.has(idString(record.leaveRequest)) : false;
    const units = attendanceDayPayrollUnits(record, paidLeave);
    const regularized = regularizedKeys.has(`${idString(record.employee)}:${record.attendanceDate}`);
    return {
      attendanceDate: record.attendanceDate,
      attendanceRecord: record._id,
      attendanceRevisionNumber: Number(record.revisionNumber || 0),
      status: record.status,
      dayType: record.dayTypeSnapshot || "working_day",
      workMode: record.workMode || "office",
      workedMinutes: Number(record.workedMinutes || 0),
      lateMinutes: Number(record.lateMinutes || 0),
      earlyExitMinutes: Number(record.earlyExitMinutes || 0),
      overtimeMinutes: Number(record.overtimeMinutes || 0),
      approvedOvertimeMinutes: Number(record.approvedOvertimeMinutes || 0),
      paidUnits: units.paidUnits,
      unpaidUnits: units.unpaidUnits,
      leaveUnits: roundUnits(leaveDayUnits(record)),
      paidLeave,
      exceptions: dayExceptions(record, regularized),
    };
  });

  const countStatus = (status: string) => daily.filter((day) => day.status === status).length;
  const sum = (key: keyof (typeof daily)[number]) =>
    daily.reduce((total, day) => total + Number(day[key] || 0), 0);

  return {
    employee: options.employee._id,
    employeeNameSnapshot: options.employee.name || "Employee",
    employeeCodeSnapshot: options.employee.code || options.employee.employeeNumber || idString(options.employee._id),
    designationSnapshot: latest.designationSnapshot || options.employee.designation || "",
    department: latest.department || null,
    departmentNameSnapshot: latest.departmentNameSnapshot || options.employee.department || "",
    teamId: latest.teamId || null,
    teamNameSnapshot: latest.teamNameSnapshot || options.employee.team || "",
    officeLocation: latest.officeLocation || options.employee.officeLocation || null,
    officeLocationNameSnapshot: latest.officeLocationNameSnapshot || "",
    reportingManager: latest.reportingManager || options.employee.reportingManager || null,
    reportingManagerNameSnapshot: latest.reportingManagerNameSnapshot || "",
    calendarDays: daily.length,
    expectedDays: records.filter((record) => record.requiresAttendanceSnapshot !== false).length,
    paidDays: roundUnits(sum("paidUnits")),
    unpaidDays: roundUnits(sum("unpaidUnits")),
    presentDays: countStatus("present"),
    halfDays: countStatus("half_day"),
    absentDays: countStatus("absent"),
    paidLeaveDays: roundUnits(daily.filter((day) => day.paidLeave).reduce((total, day) => total + day.leaveUnits, 0)),
    unpaidLeaveDays: roundUnits(daily.filter((day) => day.leaveUnits && !day.paidLeave).reduce((total, day) => total + day.leaveUnits, 0)),
    holidayDays: countStatus("holiday"),
    weeklyOffDays: countStatus("weekly_off"),
    wfhDays: daily.filter((day) => day.workMode === "remote").length,
    incompleteDays: countStatus("incomplete"),
    pendingDays: countStatus("pending"),
    workedMinutes: sum("workedMinutes"),
    rawOvertimeMinutes: sum("overtimeMinutes"),
    approvedOvertimeMinutes: sum("approvedOvertimeMinutes"),
    lateMinutes: sum("lateMinutes"),
    earlyExitMinutes: sum("earlyExitMinutes"),
    lateDays: daily.filter((day) => day.lateMinutes > 0).length,
    earlyExitDays: daily.filter((day) => day.earlyExitMinutes > 0).length,
    missingPunchDays: daily.filter((day) => day.exceptions.includes("missing_punch")).length,
    overtimeDays: daily.filter((day) => day.overtimeMinutes > 0).length,
    regularizationDays: daily.filter((day) => day.exceptions.includes("regularization")).length,
    exceptionCount: daily.reduce((total, day) => total + day.exceptions.filter((value) => value !== "wfh").length, 0),
    sourceRecordCount: daily.length,
    daily,
  };
}

function numericSnapshot(summary: any) {
  return PAYROLL_SUMMARY_FIELDS.reduce<Record<string, number>>((result, field) => {
    result[field] = Number(summary?.[field] || 0);
    return result;
  }, {});
}

export function payrollSummaryDelta(beforeSummary: any, afterSummary: any) {
  const before = numericSnapshot(beforeSummary);
  const after = numericSnapshot(afterSummary);
  const deltas = PAYROLL_SUMMARY_FIELDS.reduce<Record<string, number>>((result, field) => {
    result[field] = roundUnits(after[field] - before[field]);
    return result;
  }, {});
  return { before, after, deltas, changed: Object.values(deltas).some((value) => value !== 0) };
}

export async function createAttendanceMonthlySummaries(options: {
  company: mongoose.Types.ObjectId;
  attendancePeriod: mongoose.Types.ObjectId;
  periodKey: string;
  attendancePeriodVersion: number;
  startDate: string;
  endDate: string;
  actor: mongoose.Types.ObjectId;
  session: ClientSession;
}) {
  const records: any[] = await AttendanceRecord.find({
    company: options.company,
    attendanceDate: { $gte: options.startDate, $lte: options.endDate },
    state: "finalized",
  }).sort({ employee: 1, attendanceDate: 1 }).session(options.session).lean();

  const employeeIds = [...new Set(records.map((record) => idString(record.employee)))];
  const leaveRequestIds = [...new Set(records.map((record) => idString(record.leaveRequest)).filter(Boolean))];
  const [employees, leaveRequests, regularizations] = await Promise.all([
    User.find({ company: options.company, _id: { $in: employeeIds } })
      .select("name code employeeNumber designation department team officeLocation reportingManager")
      .session(options.session)
      .lean(),
    leaveRequestIds.length
      ? LeaveRequest.find({ company: options.company, _id: { $in: leaveRequestIds }, status: "approved" })
          .select("_id paid")
          .session(options.session)
          .lean()
      : Promise.resolve([]),
    AttendanceRegularizationRequest.find({
      company: options.company,
      attendanceDate: { $gte: options.startDate, $lte: options.endDate },
      status: "approved",
    }).select("employee attendanceDate").session(options.session).lean(),
  ]);

  const recordsByEmployee = new Map<string, any[]>();
  for (const record of records) {
    const key = idString(record.employee);
    recordsByEmployee.set(key, [...(recordsByEmployee.get(key) || []), record]);
  }
  const paidLeaveIds = new Set((leaveRequests as any[]).filter((request) => request.paid).map(idString));
  const regularizedKeys = new Set(
    (regularizations as any[]).map((request) => `${idString(request.employee)}:${request.attendanceDate}`)
  );
  const employeeById = new Map((employees as any[]).map((employee) => [idString(employee), employee]));
  const documents = employeeIds.map((employeeId) => ({
    company: options.company,
    attendancePeriod: options.attendancePeriod,
    periodKey: options.periodKey,
    attendancePeriodVersion: options.attendancePeriodVersion,
    ...buildAttendanceEmployeeSummary({
      records: recordsByEmployee.get(employeeId) || [],
      employee: employeeById.get(employeeId) || { _id: employeeId, name: "Employee", code: employeeId },
      paidLeaveRequestIds: paidLeaveIds,
      regularizedRecordKeys: regularizedKeys,
    }),
    createdBy: options.actor,
  }));

  if (documents.length) {
    await AttendanceMonthlySummary.insertMany(documents, { session: options.session });
  }
  await createPayrollAdjustmentsForCorrectedPeriod({ ...options, summaries: documents });
  return documents;
}

async function createPayrollAdjustmentsForCorrectedPeriod(options: {
  company: mongoose.Types.ObjectId;
  periodKey: string;
  attendancePeriodVersion: number;
  actor: mongoose.Types.ObjectId;
  session: ClientSession;
  summaries: any[];
}) {
  const priorInput: any = await AttendancePayrollInput.findOne({
    company: options.company,
    periodKey: options.periodKey,
    attendancePeriodVersion: { $lt: options.attendancePeriodVersion },
  }).sort({ version: -1 }).session(options.session).lean();
  if (!priorInput) return;

  const previous: any[] = await AttendanceMonthlySummary.find({
    company: options.company,
    periodKey: options.periodKey,
    attendancePeriodVersion: priorInput.attendancePeriodVersion,
  }).session(options.session).lean();
  const previousAdjustments: any[] = await AttendancePayrollAdjustment.find({
    company: options.company,
    sourcePeriodKey: options.periodKey,
  }).sort({ correctedAttendancePeriodVersion: 1, createdAt: 1 }).session(options.session).lean();
  let targetPeriodKey = nextAttendancePeriodKey(options.periodKey);
  const lockedTargets = new Set(
    (await AttendancePayrollInput.find({
      company: options.company,
      periodKey: { $gte: targetPeriodKey },
    }).select("periodKey").session(options.session).lean()).map((input: any) => input.periodKey)
  );
  while (lockedTargets.has(targetPeriodKey)) targetPeriodKey = nextAttendancePeriodKey(targetPeriodKey);
  const beforeByEmployee = new Map(previous.map((summary) => [idString(summary.employee), summary]));
  const afterByEmployee = new Map(options.summaries.map((summary) => [idString(summary.employee), summary]));
  const employeeIds = new Set([...beforeByEmployee.keys(), ...afterByEmployee.keys()]);

  for (const employeeId of employeeIds) {
    const employeeAdjustments = previousAdjustments.filter((item) => idString(item.employee) === employeeId);
    const pending = [...employeeAdjustments].reverse().find((item) => item.status === "pending");
    const latestIncluded = [...employeeAdjustments].reverse().find((item) => item.status === "included");
    const beforeSummary = latestIncluded?.after || beforeByEmployee.get(employeeId);
    const afterSummary = afterByEmployee.get(employeeId);
    const delta = payrollSummaryDelta(beforeSummary, afterSummary);
    if (!delta.changed) {
      if (pending) {
        await AttendancePayrollAdjustment.updateOne(
          { _id: pending._id, status: "pending" },
          { $set: { status: "superseded", supersededAt: new Date() } },
          { session: options.session }
        );
      }
      continue;
    }
    const [adjustment]: any[] = await AttendancePayrollAdjustment.create([{
      company: options.company,
      employee: employeeId,
      employeeNameSnapshot: afterSummary?.employeeNameSnapshot || beforeSummary?.employeeNameSnapshot || "Employee",
      employeeCodeSnapshot: afterSummary?.employeeCodeSnapshot || beforeSummary?.employeeCodeSnapshot || "",
      sourcePeriodKey: options.periodKey,
      targetPeriodKey,
      sourcePayrollInput: priorInput._id,
      sourcePayrollInputVersion: priorInput.version,
      correctedAttendancePeriodVersion: options.attendancePeriodVersion,
      deltas: delta.deltas,
      before: delta.before,
      after: delta.after,
      status: "pending",
      createdBy: options.actor,
    }], { session: options.session });
    if (pending) {
      await AttendancePayrollAdjustment.updateOne(
        { _id: pending._id, status: "pending" },
        { $set: { status: "superseded", supersededAt: new Date(), supersededByAdjustment: adjustment._id } },
        { session: options.session }
      );
    }
  }
}
