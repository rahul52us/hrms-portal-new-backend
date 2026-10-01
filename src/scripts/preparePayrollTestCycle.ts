import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import AttendancePeriod from "../schemas/Attendance/AttendancePeriod.schema";
import AttendanceProcessorRun from "../schemas/Attendance/AttendanceProcessorRun.schema";
import AttendanceRecord from "../schemas/Attendance/AttendanceRecord.schema";
import AttendanceRecordRevision from "../schemas/Attendance/AttendanceRecordRevision.schema";
import EmployeeAssignmentHistory from "../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import User from "../schemas/User/User";
import Company from "../schemas/company/Company";
import HolidayCalendar from "../schemas/WorkforcePolicy/HolidayCalendar.schema";
import HolidayCalendarVersion from "../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
import WorkforcePolicyAssignment from "../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import WorkforcePolicyAuditLog from "../schemas/WorkforcePolicy/WorkforcePolicyAuditLog.schema";
import { calendarEmployeeActive } from "../services/calendar/calendar.utils";
import { resolveEmployeeDayContext } from "../services/attendance/employeeDayContext.service";
import { parseAttendanceDate } from "../services/attendance/employeeDayContext.utils";
import {
  executeAttendanceProcessorRun,
} from "../services/attendance/attendanceProcessor.service";
import {
  loadPeriodReadiness,
  parseAttendancePeriodKey,
  resolveAttendanceCycleRange,
} from "../services/attendance/attendancePeriod.service";
import { localAttendanceTimeToUtc } from "../services/attendance/attendanceRegularization.service";

const applyChanges = process.argv.includes("--apply");
const TEST_CALENDAR_CODE = "PAYROLL-TEST-FALLBACK";
const TEST_REASON = "Development payroll cycle test-data preparation";

type DateSegment = { startDate: string; endDate: string };
type EmployeeContext = {
  employee: any;
  attendanceDate: string;
  context: any;
};

function argument(name: string) {
  const prefix = `--${name}=`;
  return String(process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "").trim();
}

function positionalArguments() {
  return process.argv.slice(2).filter((value) => !value.startsWith("--"));
}

function addDays(date: string, days: number) {
  const parsed = parseAttendanceDate(date).date;
  return new Date(parsed.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function datesInRange(startDate: string, endDate: string) {
  const dates: string[] = [];
  for (let cursor = startDate; cursor <= endDate; cursor = addDays(cursor, 1)) {
    dates.push(cursor);
  }
  return dates;
}

function groupConsecutiveDates(dates: string[]): DateSegment[] {
  const sorted = [...new Set(dates)].sort();
  if (!sorted.length) return [];
  const segments: DateSegment[] = [];
  let startDate = sorted[0];
  let endDate = sorted[0];
  for (const date of sorted.slice(1)) {
    if (date === addDays(endDate, 1)) {
      endDate = date;
      continue;
    }
    segments.push({ startDate, endDate });
    startDate = date;
    endDate = date;
  }
  segments.push({ startDate, endDate });
  return segments;
}

function currentDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function recordSnapshot(record: any) {
  return record.toObject({ depopulate: true });
}

function recordSummary(record: any) {
  return {
    state: record.state,
    status: record.status,
    punchSessions: (record.punchSessions || []).map((session: any) => ({
      punchIn: session.punchIn || null,
      punchOut: session.punchOut || null,
      source: session.source,
    })),
    hasMissingPunch: record.hasMissingPunch,
    source: record.source,
  };
}

function validDate(value: unknown) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveCompanyQuery(value: string) {
  if (mongoose.Types.ObjectId.isValid(value)) return { _id: new mongoose.Types.ObjectId(value) };
  return { companyCode: value.toUpperCase() };
}

async function resolveTarget() {
  const username = (argument("user") || positionalArguments()[0] || "").toLowerCase();
  const companyArgument = argument("company");
  if (!username && !companyArgument) {
    throw new Error("Pass --user=<employee username> or --company=<company id/code>");
  }

  const selectedUser = username
    ? await User.findOne({ username, deletedAt: null }).select("_id username company").lean()
    : null;
  if (username && !selectedUser) throw new Error(`User ${username} was not found`);

  const companyId = selectedUser?.company;
  const company = companyId
    ? await Company.findById(companyId).select("_id company_name companyCode payrollSettings").lean()
    : await Company.findOne(resolveCompanyQuery(companyArgument))
        .select("_id company_name companyCode payrollSettings")
        .lean();
  if (!company) throw new Error("Company was not found");

  const actor = await User.findOne({
    company: company._id,
    role: { $in: ["admin", "hradmin"] },
    is_enabled: true,
    deletedAt: null,
  })
    .sort({ role: 1, createdAt: 1 })
    .select("_id name username role")
    .lean();
  if (!actor) throw new Error("The company needs an enabled Company Admin or HR Admin for audit ownership");

  return { company, actor };
}

async function loadEmployees(company: mongoose.Types.ObjectId) {
  return User.find({
    company,
    is_enabled: true,
    deletedAt: null,
    role: { $ne: "superadmin" },
  })
    .select("_id name username code role joiningDate employmentEndDate createdAt deletedAt")
    .sort({ _id: 1 })
    .lean();
}

async function inspectCoverage(options: {
  company: mongoose.Types.ObjectId;
  employees: any[];
  dates: string[];
}) {
  const contexts = new Map<string, EmployeeContext>();
  const missingHolidayDates = new Map<string, string[]>();
  const otherSetupGaps: string[] = [];
  const versionCache = new Map<string, Promise<any>>();

  const employeesWithNoHistory = [];
  for (const employee of options.employees) {
    const hasHistory = await EmployeeAssignmentHistory.exists({
      company: options.company,
      employee: employee._id,
    });
    if (!hasHistory) employeesWithNoHistory.push(`${employee.name} (${employee.code})`);
  }
  if (employeesWithNoHistory.length) {
    throw new Error(
      `Backfill employee assignment history first for: ${employeesWithNoHistory.join(", ")}`
    );
  }

  const jobs = options.dates.flatMap((attendanceDate) =>
    options.employees.map((employee) => ({ attendanceDate, employee }))
  );
  let nextJob = 0;
  const inspectNext = async (): Promise<void> => {
    const job = jobs[nextJob++];
    if (!job) return;
    const { attendanceDate, employee } = job;
    try {
      if (calendarEmployeeActive(employee, attendanceDate)) {
        const context = await resolveEmployeeDayContext({
          companyId: options.company,
          employeeId: employee._id,
          attendanceDate,
          versionCache,
        });
        contexts.set(`${employee._id}:${attendanceDate}`, { employee, attendanceDate, context });
        const missing = new Set<string>(context.missingPolicies || []);
        if (missing.has("holiday_calendar")) {
          const key = String(employee._id);
          missingHolidayDates.set(key, [...(missingHolidayDates.get(key) || []), attendanceDate]);
        }
        const blocking = ["attendance_policy", "work_schedule"].filter((type) => missing.has(type));
        if (blocking.length) {
          otherSetupGaps.push(
            `${attendanceDate} ${employee.name} (${employee.code}): ${blocking.join(", ")}`
          );
        }
      }
    } finally {
      await inspectNext();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(10, jobs.length) }, () => inspectNext())
  );
  return { contexts, missingHolidayDates, otherSetupGaps };
}

async function ensureTestCalendar(options: {
  company: any;
  actor: any;
  effectiveFrom: string;
}) {
  let calendar: any = await HolidayCalendar.findOne({
    company: options.company._id,
    code: TEST_CALENDAR_CODE,
  });
  if (!calendar) {
    calendar = await HolidayCalendar.create({
      company: options.company._id,
      name: "Payroll test fallback calendar",
      code: TEST_CALENDAR_CODE,
      description: "Temporary empty calendar used only for historical payroll-cycle testing.",
      status: "active",
      latestVersionNumber: 1,
      createdBy: options.actor._id,
    });
    await WorkforcePolicyAuditLog.create({
      company: options.company._id,
      entityType: "holiday_calendar",
      entityId: calendar._id,
      action: "created_for_payroll_test",
      actor: options.actor._id,
      details: { effectiveFrom: options.effectiveFrom },
    });
  }
  if (calendar.status !== "active") {
    throw new Error(`${TEST_CALENDAR_CODE} exists but is archived`);
  }

  let version: any = await HolidayCalendarVersion.findOne({
    company: options.company._id,
    calendar: calendar._id,
    status: "published",
    effectiveFrom: { $lte: parseAttendanceDate(options.effectiveFrom).date },
  }).sort({ effectiveFrom: -1, versionNumber: -1 });
  if (!version) {
    const versionNumber = Math.max(1, Number(calendar.latestVersionNumber || 0) + 1);
    version = await HolidayCalendarVersion.create({
      company: options.company._id,
      calendar: calendar._id,
      versionNumber,
      status: "published",
      effectiveFrom: parseAttendanceDate(options.effectiveFrom).date,
      timezone: "Asia/Kolkata",
      holidays: [],
      changeReason: TEST_REASON,
      createdBy: options.actor._id,
      publishedAt: new Date(),
      publishedBy: options.actor._id,
    });
    calendar.latestVersionNumber = versionNumber;
    await calendar.save();
    await WorkforcePolicyAuditLog.create({
      company: options.company._id,
      entityType: "holiday_version",
      entityId: version._id,
      action: "published_for_payroll_test",
      actor: options.actor._id,
      details: { calendarId: calendar._id, effectiveFrom: options.effectiveFrom },
    });
  }
  return calendar;
}

async function createFallbackAssignments(options: {
  company: any;
  actor: any;
  employees: any[];
  missingHolidayDates: Map<string, string[]>;
  calendar: any;
}) {
  let created = 0;
  const employeeById = new Map(options.employees.map((employee) => [String(employee._id), employee]));
  for (const [employeeId, missingDates] of options.missingHolidayDates) {
    const employee = employeeById.get(employeeId);
    if (!employee) continue;
    for (const segment of groupConsecutiveDates(missingDates)) {
      const effectiveFrom = parseAttendanceDate(segment.startDate).date;
      const effectiveTo = parseAttendanceDate(addDays(segment.endDate, 1)).date;
      const existing = await WorkforcePolicyAssignment.findOne({
        company: options.company._id,
        resourceType: "holiday_calendar",
        resource: options.calendar._id,
        scopeType: "employee",
        scopeId: employee._id,
        effectiveFrom,
        effectiveTo,
      });
      if (existing) continue;
      const assignment = await WorkforcePolicyAssignment.create({
        company: options.company._id,
        resourceType: "holiday_calendar",
        resourceModel: "HolidayCalendar",
        resource: options.calendar._id,
        scopeType: "employee",
        scopeId: employee._id,
        scopeNameSnapshot: `${employee.name} (${employee.code})`,
        priority: 500,
        effectiveFrom,
        effectiveTo,
        changeReason: `${TEST_REASON}: ${segment.startDate} to ${segment.endDate}`,
        createdBy: options.actor._id,
      });
      await WorkforcePolicyAuditLog.create({
        company: options.company._id,
        entityType: "assignment",
        entityId: assignment._id,
        action: "assigned_for_payroll_test",
        actor: options.actor._id,
        details: {
          resourceType: "holiday_calendar",
          employee: employee._id,
          startDate: segment.startDate,
          endDate: segment.endDate,
        },
      });
      created += 1;
    }
  }
  return created;
}

function repairedSessions(record: any, context: any) {
  const timezone = record.timezone || context.timezone || "Asia/Kolkata";
  const startTime = record.scheduleStartTimeSnapshot || context.schedule?.startTime;
  const endTime = record.scheduleEndTimeSnapshot || context.schedule?.endTime;
  if (!startTime || !endTime) return null;
  const scheduledStart = localAttendanceTimeToUtc(record.attendanceDate, startTime, timezone);
  const overnight = String(endTime) <= String(startTime);
  const scheduledEnd = localAttendanceTimeToUtc(
    record.attendanceDate,
    endTime,
    timezone,
    overnight
  );
  let changed = false;
  const sessions = (record.punchSessions || []).map((source: any) => {
    const session = source.toObject ? source.toObject() : { ...source };
    let punchIn = validDate(session.punchIn);
    let punchOut = validDate(session.punchOut);
    if (punchIn && punchOut && punchOut.getTime() >= punchIn.getTime()) return session;
    if (!punchIn && !punchOut) return session;
    if (!punchIn) punchIn = scheduledStart;
    if (!punchOut || punchOut.getTime() < punchIn.getTime()) {
      punchOut = new Date(scheduledEnd);
      while (punchOut.getTime() <= punchIn.getTime()) {
        punchOut = new Date(punchOut.getTime() + 86_400_000);
      }
    }
    changed = true;
    return {
      ...session,
      punchIn,
      punchOut,
      deviceInfo: session.deviceInfo || "Payroll test cycle repair",
    };
  });
  return changed ? sessions : null;
}

async function repairPunches(options: {
  company: mongoose.Types.ObjectId;
  actor: any;
  startDate: string;
  endDate: string;
  contexts: Map<string, EmployeeContext>;
}) {
  const records = await AttendanceRecord.find({
    company: options.company,
    attendanceDate: { $gte: options.startDate, $lte: options.endDate },
    state: { $ne: "finalized" },
  }).sort({ attendanceDate: 1, employee: 1 });
  let repaired = 0;
  for (const sourceRecord of records) {
    const contextEntry = options.contexts.get(`${sourceRecord.employee}:${sourceRecord.attendanceDate}`);
    if (!contextEntry) continue;
    const sessions = repairedSessions(sourceRecord, contextEntry.context);
    if (!sessions) continue;

    await mongoose.connection.transaction(async (session) => {
      const record: any = await AttendanceRecord.findById(sourceRecord._id).session(session);
      if (!record || record.state === "finalized") return;
      const before = recordSnapshot(record);
      const latestRevision = await AttendanceRecordRevision.findOne({
        company: options.company,
        attendanceRecord: record._id,
      })
        .sort({ revisionNumber: -1 })
        .select("revisionNumber")
        .session(session)
        .lean();
      record.punchSessions = sessions;
      record.state = "open";
      record.source = "recalculation";
      record.updatedBy = options.actor._id;
      record.revisionNumber = Math.max(
        Number(record.revisionNumber || 0),
        Number(latestRevision?.revisionNumber || 0)
      ) + 1;
      await record.save({ session });
      await AttendanceRecordRevision.create(
        [{
          company: options.company,
          attendanceRecord: record._id,
          employee: record.employee,
          revisionNumber: record.revisionNumber,
          action: "manual_adjustment",
          reason: TEST_REASON,
          changes: { before: recordSummary(before), after: recordSummary(record) },
          snapshot: recordSnapshot(record),
          actor: options.actor._id,
          source: "manual",
        }],
        { session }
      );
      repaired += 1;
    });
  }
  return repaired;
}

async function processCycle(options: {
  company: mongoose.Types.ObjectId;
  actor: any;
  dates: string[];
  periodKey: string;
}) {
  const batchKey = `payroll-test:${options.periodKey}:${Date.now()}`;
  const summaries = [];
  for (const attendanceDate of options.dates) {
    const run = await AttendanceProcessorRun.create({
      company: options.company,
      attendanceDate,
      idempotencyKey: `${batchKey}:${attendanceDate}`,
      trigger: "cycle_preparation",
      finalizeClean: true,
      reason: TEST_REASON,
      status: "pending",
      active: true,
      requestedBy: options.actor._id,
      batchSize: 100,
    });
    const completed: any = await executeAttendanceProcessorRun(run._id as mongoose.Types.ObjectId);
    summaries.push({
      attendanceDate,
      status: completed.status,
      counts: completed.counts?.toObject?.() || completed.counts,
    });
  }
  return summaries;
}

async function run() {
  await connectToDatabase();
  const periodKey = parseAttendancePeriodKey(
    argument("period") || positionalArguments()[1] || "2026-09"
  ).periodKey;
  const { company, actor } = await resolveTarget();
  const companyId = company._id as mongoose.Types.ObjectId;
  const range = await resolveAttendanceCycleRange({ company: companyId, periodKey });
  if (range.endDate > currentDateKey()) {
    throw new Error(`Attendance cycle ${range.startDate} to ${range.endDate} has not ended yet`);
  }
  const lockedPeriod = await AttendancePeriod.exists({
    company: companyId,
    periodKey,
    status: "locked",
  });
  if (lockedPeriod) throw new Error("Reopen this attendance cycle before preparing test data");
  const activeRun = await AttendanceProcessorRun.findOne({
    company: companyId,
    attendanceDate: { $gte: range.startDate, $lte: range.endDate },
    active: true,
    status: { $in: ["pending", "running"] },
  }).select("attendanceDate status createdAt").lean();
  if (applyChanges && activeRun) {
    throw new Error(
      `Wait for the active ${activeRun.attendanceDate} attendance processor run (${activeRun.status}) to finish`
    );
  }

  const employees = await loadEmployees(companyId);
  const dates = datesInRange(range.startDate, range.endDate);
  const initialReadiness = await loadPeriodReadiness({ company: companyId, ...range });
  const records = await AttendanceRecord.find({
    company: companyId,
    attendanceDate: { $gte: range.startDate, $lte: range.endDate },
    state: { $ne: "finalized" },
  }).lean();
  const targetDates = [...new Set([
    ...initialReadiness.missingProcessorDates,
    ...initialReadiness.problemProcessorDates,
    ...records.map((record: any) => String(record.attendanceDate)),
  ])]
    .filter((date) => dates.includes(date))
    .sort();
  const inspection = await inspectCoverage({
    company: companyId,
    employees,
    dates: targetDates,
  });
  const punchRepairs = records.filter((record: any) =>
    (record.punchSessions || []).some((session: any) => {
      const punchIn = validDate(session.punchIn);
      const punchOut = validDate(session.punchOut);
      return Boolean((punchIn || punchOut) && (!punchIn || !punchOut || punchOut < punchIn));
    })
  );
  const fallbackSegments = Array.from(inspection.missingHolidayDates.values())
    .reduce((total, employeeDates) => total + groupConsecutiveDates(employeeDates).length, 0);

  console.log(`${applyChanges ? "Applying" : "Dry run for"} payroll test-cycle preparation`);
  console.log(`Company: ${company.company_name} (${company.companyCode})`);
  console.log(`Cycle: ${periodKey}, ${range.startDate} to ${range.endDate}`);
  console.log(`Employees: ${employees.length}`);
  console.log(`Attendance dates requiring preparation: ${targetDates.length}`);
  console.log(`Missing holiday coverage: ${fallbackSegments} employee date segment(s)`);
  console.log(`Incomplete punch records to repair: ${punchRepairs.length}`);
  if (inspection.otherSetupGaps.length) {
    console.error("Attendance policy/work-schedule gaps cannot be synthesized by this script:");
    inspection.otherSetupGaps.slice(0, 20).forEach((gap) => console.error(`- ${gap}`));
    if (inspection.otherSetupGaps.length > 20) {
      console.error(`- ...and ${inspection.otherSetupGaps.length - 20} more`);
    }
    throw new Error("Resolve the reported attendance policy/work-schedule gaps first");
  }
  if (!applyChanges) {
    console.log("No data changed. Run the apply command to create fallback coverage, repair punches, and process the cycle.");
    return;
  }

  let assignmentsCreated = 0;
  if (inspection.missingHolidayDates.size) {
    const calendar = await ensureTestCalendar({
      company,
      actor,
      effectiveFrom: range.startDate,
    });
    assignmentsCreated = await createFallbackAssignments({
      company,
      actor,
      employees,
      missingHolidayDates: inspection.missingHolidayDates,
      calendar,
    });
  }
  const punchesRepaired = await repairPunches({
    company: companyId,
    actor,
    startDate: range.startDate,
    endDate: range.endDate,
    contexts: inspection.contexts,
  });
  const processorRuns = await processCycle({
    company: companyId,
    actor,
    dates: targetDates,
    periodKey,
  });
  const failedRuns = processorRuns.filter((item) => item.status !== "completed");
  const readiness = await loadPeriodReadiness({ company: companyId, ...range });

  console.log(`Fallback assignments created: ${assignmentsCreated}`);
  console.log(`Punch records repaired: ${punchesRepaired}`);
  console.log(`Processor runs completed cleanly: ${processorRuns.length - failedRuns.length}/${processorRuns.length}`);
  console.log(`Attendance finalized: ${readiness.finalizedRecords}/${readiness.totalRecords}`);
  console.log(`Processed closed dates: ${readiness.processedDays}/${readiness.closedCalendarDays}`);
  if (readiness.readyToLock) {
    console.log("The attendance cycle is ready to lock and use for final payroll testing.");
  } else {
    console.error("Remaining payroll readiness blockers:");
    readiness.blockers.forEach((blocker) => console.error(`- ${blocker}`));
    process.exitCode = 1;
  }
}

run()
  .catch((error) => {
    console.error("Payroll test-cycle preparation failed:", error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
