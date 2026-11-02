import User from "../../schemas/User/User";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import ProjectAssignment from "../../schemas/project/ProjectAssignment.schema";
import ProjectAudit from "../../schemas/project/ProjectAuditLog.schema";
import DayControl from "../../schemas/Timesheet/TimesheetDayControl.schema";
import { applyExemption, controlSnapshot } from "./timesheetDayControl.utils";
import { generateError } from "../../config/Error/functions";
import { resolveEmployeeDayContext } from "../attendance/employeeDayContext.service";
import { addDateDays, dateInZone, localInstant, workRequirement } from "./timesheet.utils";
import { timesheetDeadlines, TimesheetCycle, usesPayrollCutoff } from "./timesheetDeadline.utils";
import { loadTimesheetCycle } from "./timesheetCycle.service";

export async function resolveTimesheetDay(company: any, employeeId: any, attendanceDate: string, now = new Date(), versionCache?: Map<string, Promise<any>>, includeArchived = false, suppliedControl?: any) {
  const employee: any = await User.findOne({ _id: employeeId, company, ...(includeArchived ? {} : { deletedAt: null }) }).select("_id joiningDate employmentEndDate is_enabled").lean();
  if (!employee) throw generateError("Employee not found", 404);
  const context = await resolveEmployeeDayContext({ companyId: company, employeeId, attendanceDate, versionCache });
  const [record, leaves, assigned, control] = await Promise.all([
    AttendanceRecord.findOne({ company, employee: employeeId, attendanceDate }).lean(),
    LeaveRequest.find({ company, employee: employeeId, status: "approved", "dayBreakdown.attendanceDate": attendanceDate }).select("_id unit dayBreakdown updatedAt").lean(),
    ProjectAssignment.exists({ company, employee: employeeId, status: "assigned", effectiveFrom: { $lte: attendanceDate }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: attendanceDate } }] }),
    suppliedControl === undefined ? DayControl.findOne({ company, employee: employeeId, attendanceDate }).lean() : suppliedControl,
  ]);
  const cycle = usesPayrollCutoff(context.policies.timesheetPolicy?.version?.rules) ? await loadTimesheetCycle(company, attendanceDate, versionCache) : undefined;
  return buildTimesheetDay({ employee: includeArchived ? { ...employee, is_enabled: true } : employee, context, record, leaves, assigned: Boolean(assigned), now, control, cycle });
}

export function buildTimesheetDay({ employee, context, record, leaves, assigned, now, clockCache, control, cycle }: {
  employee: any; context: Awaited<ReturnType<typeof resolveEmployeeDayContext>>; record: any;
  leaves: any[]; assigned: boolean; now: Date; clockCache?: Map<string, any>; control?: any; cycle?: TimesheetCycle | null;
}) {
  const attendanceDate = context.attendanceDate;
  if (context.timezone) {
    const key = `zone:${context.timezone}`;
    let valid = clockCache?.get(key);
    if (valid === undefined) { try { new Intl.DateTimeFormat("en", { timeZone: context.timezone }).format(now); valid = true; } catch { valid = false; } clockCache?.set(key, valid); }
    if (!valid) context.timezone = null;
  }
  const requirement = workRequirement(context, leaves);
  const exemption = applyExemption(requirement, control);
  const rules = context.policies.timesheetPolicy?.version?.rules;
  const setupIssues: { code: string; message: string; action: string }[] = [];
  const saveIssues: typeof setupIssues = [];
  const submissionIssues: typeof setupIssues = [];
  const issue = (code: string, message: string, action: string) => ({ code, message, action });
  if (!rules) setupIssues.push(issue("MISSING_TIMESHEET_POLICY", "No timesheet policy is effective on this date", "ask_hr_to_assign_policy"));
  if (!context.policies.workSchedule || !context.timezone || requirement.fullMinutes == null) setupIssues.push(issue("MISSING_WORK_SCHEDULE", "A valid work schedule is required", "ask_hr_to_assign_schedule"));
  if (!context.policies.holidayCalendar) setupIssues.push(issue("MISSING_HOLIDAY_CALENDAR", "Holiday calendar is not configured", "ask_hr_to_assign_calendar"));
  if (!context.organizationAssignment?._id) setupIssues.push(issue("MISSING_ASSIGNMENT_HISTORY", "Historical employee assignment is missing", "ask_hr_to_backfill_history"));
  if (!assigned && requirement.requiredMinutes) setupIssues.push(issue("NO_PROJECT_ASSIGNMENT", "No project is assigned on this date", "ask_manager_to_assign_project"));
  const employmentDate = (value: any) => value ? new Date(value).toISOString().slice(0, 10) : null;
  const joining = employmentDate(employee.joiningDate), exit = employmentDate(employee.employmentEndDate);
  const outsideEmployment = Boolean(joining && attendanceDate < joining || exit && attendanceDate > exit);
  if (outsideEmployment) { requirement.requiredMinutes = 0; requirement.workingMinutes = 0; }
  if (outsideEmployment || employee.is_enabled === false) saveIssues.push(issue("OUTSIDE_EMPLOYMENT", "This date is outside active employment", "ask_hr_to_review_employment"));
  if (control?.payrollLockedAt) saveIssues.push(issue("PAYROLL_LOCKED", "This timesheet day is payroll-locked", "ask_hr_to_review_payroll"));
  let deadlineAt: Date | null = null;
  let editableUntilDate: string | null = null;
  let editableUntilAt: Date | null = null;
  let payrollCycle: ReturnType<typeof timesheetDeadlines>["payrollCycle"] = null;
  if (context.timezone && rules && requirement.fullMinutes != null && context.schedule.startTime && context.schedule.endTime) {
    const key = JSON.stringify([attendanceDate, context.timezone, context.schedule.startTime, context.schedule.endTime, rules.deadlineDaysAfterShift, rules.deadlineTime, rules.maxBackdateDays, rules.deadlineMode, rules.payrollCutoffEnabled, rules.payrollSubmissionDaysAfterCycleEnd, rules.payrollSubmissionTime, rules.payrollApprovalDaysAfterCycleEnd, rules.payrollApprovalTime, cycle]);
    let clock = clockCache?.get(key);
    if (!clock) {
      clock = { today: dateInZone(now, context.timezone), ...timesheetDeadlines(attendanceDate, context.schedule, rules, context.timezone, cycle) };
      clockCache?.set(key, clock);
    }
    const today = clock.today;
    deadlineAt = clock.deadline; editableUntilDate = clock.editable;
    payrollCycle = clock.payrollCycle;
    if (clock.missingCycle) setupIssues.push(issue("MISSING_PAYROLL_CYCLE", "A unique payroll attendance cycle could not be resolved for this date", "ask_hr_to_review_payroll_cycle"));
    if (clock.invalid) setupIssues.push(issue("INVALID_SUBMISSION_DEADLINE", "The submission deadline is before this shift ends", "ask_hr_to_review_deadline"));
    if (today < attendanceDate) saveIssues.push(issue("FUTURE_DATE", "Future timesheets cannot be saved", "select_worked_date"));
    if (control?.extension?.until && deadlineAt && new Date(control.extension.until) > deadlineAt) deadlineAt = new Date(control.extension.until);
    editableUntilAt = clock.editEnd;
    if (control?.extension?.until && new Date(control.extension.until) > editableUntilAt!) {
      editableUntilAt = new Date(control.extension.until);
      editableUntilDate = dateInZone(editableUntilAt, context.timezone);
    }
    if (editableUntilAt && now > editableUntilAt) saveIssues.push(payrollCycle && editableUntilAt.getTime() >= payrollCycle.submissionAt!.getTime()
      ? issue("PAYROLL_CUTOFF_CLOSED", "The payroll-cycle submission cutoff has passed. Ask HR for a deadline extension.", "ask_hr_for_deadline_extension")
      : issue("EDIT_WINDOW_CLOSED", "The backdated edit window has closed", "ask_hr_for_deadline_extension"));
  }
  const hasPunchIn = record?.punchSessions?.some((s: any) => s.punchIn);
  const hasOpenPunch = record?.punchSessions?.some((s: any) => s.punchIn && !s.punchOut);
  if (!hasPunchIn && requirement.requiredMinutes) saveIssues.push(issue("MISSING_PUNCH_IN", "Punch in or request attendance regularization before logging work", "request_regularization"));
  if (hasOpenPunch || record?.hasMissingPunch) submissionIssues.push(issue("INCOMPLETE_ATTENDANCE", "Complete punch-out or regularize attendance before submission", "request_regularization"));
  return { context, record, leaves, rules, requirement, controls: controlSnapshot(control),
    eligibility: { setupIssues, saveIssues, submissionIssues, canSave: !setupIssues.length && !saveIssues.length,
      canSubmit: !setupIssues.length && !saveIssues.length && !submissionIssues.length, submissionAvailable: true, deadlineAt, editableUntilDate, editableUntilAt, payrollCycle,
      overdue: Boolean(deadlineAt && now > deadlineAt && requirement.requiredMinutes),
      required: Boolean(requirement.requiredMinutes), requiredMinutes: requirement.requiredMinutes,
      workingMinutes: requirement.workingMinutes, fullShiftMinutes: requirement.fullMinutes,
      exemptLeaveMinutes: requirement.exemptLeaveMinutes, ...exemption, payrollMode: rules?.payrollMode || "report_only", payrollImpactActive: Boolean(rules?.required && rules?.payrollMode && rules.payrollMode !== "report_only") },
  };
}

export function timesheetContextSnapshot(day: Awaited<ReturnType<typeof resolveTimesheetDay>>) {
  const { context, record, leaves, eligibility, rules } = day;
  return { attendanceDate: context.attendanceDate, timezone: context.timezone, dayType: context.dayType,
    schedule: context.schedule, holiday: context.holiday, policyReferences: context.policyReferences,
    organizationAssignment: context.organizationAssignment, rules, eligibility,
    ...(day.controls.revision ? { dayControl: day.controls } : {}),
    attendance: record ? { _id: record._id, revision: record.revisionNumber, state: record.state, status: record.status,
      workMode: record.workMode, workedMinutes: record.workedMinutes, punchSessions: record.punchSessions.map((s: any) => ({ punchIn: s.punchIn, punchOut: s.punchOut })) } : null,
    approvedLeave: leaves.map((leave: any) => ({ _id: leave._id, updatedAt: leave.updatedAt, unit: leave.unit,
      days: leave.dayBreakdown.filter((d: any) => d.attendanceDate === context.attendanceDate).map((d: any) => ({ portion: d.portion, requestedUnits: d.requestedUnits })) })),
  };
}

export function timesheetWorkFingerprint(snapshot: any) {
  const { eligibility: _eligibility, dayControl, ...work } = snapshot;
  const { minuteIncrement: _retiredIncrement, ...rules } = work.rules || {};
  const references = Object.fromEntries(Object.entries(work.policyReferences || {}).map(([key, value]: [string, any]) => {
    if (!value) return [key, value];
    const { effectiveTo: _effectiveTo, ...reference } = value;
    return [key, reference];
  }));
  const organization = work.organizationAssignment;
  const assignment = organization ? Object.fromEntries(["_id", "employee", "department", "teamId", "officeLocation", "reportingManager"].map((key) => [key, organization[key] || null])) : null;
  const leaves = work.approvedLeave?.map(({ updatedAt: _updatedAt, ...leave }: any) => leave).sort((a: any, b: any) => String(a._id).localeCompare(String(b._id)));
  return JSON.stringify({ ...work, ...(work.rules ? { rules } : {}), ...(work.policyReferences ? { policyReferences: references } : {}), ...(organization ? { organizationAssignment: assignment } : {}), ...(leaves ? { approvedLeave: leaves } : {}), ...(dayControl?.exemption ? { hrExemption: { eventId: dayControl.exemption.eventId, mode: dayControl.exemption.mode, minutes: dayControl.exemption.minutes } } : {}) });
}

export async function historicalProjectStates(company: any, entities: any[], day: string, timezone: string, session: any = null) {
  const cutoff = localInstant(addDateDays(day, 1), "00:00", timezone);
  const changes = await ProjectAudit.aggregate([
    { $match: { company, entityId: { $in: entities.map((e) => e._id) }, createdAt: { $gte: cutoff }, action: { $in: ["project_archived", "project_restored", "project_updated", "work_type_updated"] } } },
    { $sort: { createdAt: 1, _id: 1 } }, { $group: { _id: "$entityId", before: { $first: "$before" } } },
  ]).session(session);
  return new Map(entities.map((entity) => {
    const before = changes.find((event) => String(event._id) === String(entity._id))?.before;
    const value = before || entity;
    if (!before && value.status === "archived" && value.archivedAt && new Date(value.archivedAt) >= cutoff) return [String(entity._id), { ...value, status: "active" }];
    return [String(entity._id), value];
  }));
}
