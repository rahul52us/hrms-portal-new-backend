import type { HolidayEntry } from "../../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
import type { WorkScheduleRules } from "../../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
import { generateError } from "../../config/Error/functions";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type EmployeeDayType =
  | "unconfigured"
  | "working_day"
  | "weekly_off"
  | "mandatory_holiday"
  | "mandatory_half_day_holiday"
  | "optional_holiday";

export type DefaultAttendanceStatus = "pending" | "holiday" | "weekly_off";

export interface WorkScheduleVersionLike {
  _id?: unknown;
  versionNumber?: number;
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
  rules?: Partial<WorkScheduleRules>;
}

export interface HolidayCalendarVersionLike {
  _id?: unknown;
  versionNumber?: number;
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
  timezone?: string;
  holidays?: Array<Partial<HolidayEntry> & { _id?: unknown }>;
}

export interface ResolvedPolicyLike<TVersion = Record<string, unknown>> {
  assignment: Record<string, any>;
  version: TVersion & Record<string, any>;
}

export interface EmployeePolicyResolutionLike {
  employee: Record<string, any>;
  at: Date;
  organizationAssignment: Record<string, any>;
  attendancePolicy?: ResolvedPolicyLike | null;
  workSchedule?: ResolvedPolicyLike<WorkScheduleVersionLike> | null;
  holidayCalendar?: ResolvedPolicyLike<HolidayCalendarVersionLike> | null;
  leavePolicy?: ResolvedPolicyLike | null;
  remoteWorkPolicy?: ResolvedPolicyLike | null;
  warnings?: string[];
}

export interface EmployeeDayClassification {
  attendanceDate: string;
  dayOfWeek: (typeof DAY_NAMES)[number];
  weekOfMonth: number;
  timezone: string | null;
  dayType: EmployeeDayType;
  requiresAttendance: boolean | null;
  expectedWorkMinutes: number | null;
  defaultAttendanceStatus: DefaultAttendanceStatus;
  schedule: {
    configured: boolean;
    isWorkingDay: boolean | null;
    weeklyOffReason: string | null;
    startTime: string | null;
    endTime: string | null;
    grossMinutes: number | null;
    unpaidBreakMinutes: number | null;
    scheduledMinutes: number | null;
  };
  holiday: {
    id: string | null;
    date: string;
    name: string;
    type: "mandatory" | "optional";
    isHalfDay: boolean;
    description: string;
  } | null;
  warnings: string[];
}

export interface EmployeeDayPolicyReference {
  assignmentId: string | null;
  resourceId: string | null;
  versionId: string | null;
  versionNumber: number | null;
  scopeType: string | null;
  scopeId: string | null;
  effectiveFrom: unknown;
  effectiveTo: unknown;
}

function idString(value: any): string | null {
  const normalized = value?._id || value;
  if (normalized === undefined || normalized === null || normalized === "") return null;
  return String(normalized);
}

function dateKey(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function parseAttendanceDate(attendanceDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(attendanceDate || "").trim());
  if (!match) throw generateError("Attendance date must use YYYY-MM-DD format", 400);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw generateError("Attendance date is invalid", 400);
  }

  return {
    date,
    dateKey: `${match[1]}-${match[2]}-${match[3]}`,
    dayOfWeek: DAY_NAMES[date.getUTCDay()],
    weekOfMonth: Math.floor((day - 1) / 7) + 1,
  };
}

function timeToMinutes(value: unknown): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function scheduledShiftMinutes(rules: Partial<WorkScheduleRules>) {
  const startMinutes = timeToMinutes(rules.startTime);
  const endMinutes = timeToMinutes(rules.endTime);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return null;
  const grossMinutes =
    endMinutes > startMinutes
      ? endMinutes - startMinutes
      : 24 * 60 - startMinutes + endMinutes;
  const unpaidBreakMinutes = Math.max(0, Number(rules.unpaidBreakMinutes || 0));
  if (unpaidBreakMinutes >= grossMinutes) return null;
  return {
    grossMinutes,
    unpaidBreakMinutes,
    scheduledMinutes: grossMinutes - unpaidBreakMinutes,
  };
}

function classifyScheduledDay(
  dayOfWeek: (typeof DAY_NAMES)[number],
  weekOfMonth: number,
  rules: Partial<WorkScheduleRules>
) {
  if (dayOfWeek !== "Saturday") {
    const isWorkingDay = (rules.workingDays || []).some(
      (day) => String(day).toLowerCase() === dayOfWeek.toLowerCase()
    );
    return {
      isWorkingDay,
      weeklyOffReason: isWorkingDay ? null : "not_in_working_days",
    };
  }

  const saturdayRule = rules.saturdayRule || "all_off";
  let isOff = false;
  let weeklyOffReason: string | null = null;
  if (saturdayRule === "all_off") {
    isOff = true;
    weeklyOffReason = "all_saturdays_off";
  } else if (saturdayRule === "first_and_third_off") {
    isOff = weekOfMonth === 1 || weekOfMonth === 3;
    weeklyOffReason = isOff ? "first_or_third_saturday_off" : null;
  } else if (saturdayRule === "second_and_fourth_off") {
    isOff = weekOfMonth === 2 || weekOfMonth === 4;
    weeklyOffReason = isOff ? "second_or_fourth_saturday_off" : null;
  } else if (saturdayRule === "custom_weeks_off") {
    isOff = (rules.customSaturdayOffWeeks || []).includes(weekOfMonth);
    weeklyOffReason = isOff ? "custom_saturday_off" : null;
  }

  return { isWorkingDay: !isOff, weeklyOffReason };
}

export function classifyEmployeeDay(options: {
  attendanceDate: string;
  workScheduleVersion?: WorkScheduleVersionLike | null;
  holidayCalendarVersion?: HolidayCalendarVersionLike | null;
}): EmployeeDayClassification {
  const parsedDate = parseAttendanceDate(options.attendanceDate);
  const rules = options.workScheduleVersion?.rules;
  const warnings: string[] = [];
  const shift = rules ? scheduledShiftMinutes(rules) : null;
  const scheduledDay = rules
    ? classifyScheduledDay(parsedDate.dayOfWeek, parsedDate.weekOfMonth, rules)
    : { isWorkingDay: null, weeklyOffReason: null };

  if (rules && !shift) warnings.push("Work schedule has an invalid time window");

  const holidaySource = (options.holidayCalendarVersion?.holidays || []).find(
    (holiday) => dateKey(holiday.date) === parsedDate.dateKey
  );
  const holidayType = holidaySource?.type === "optional" ? "optional" : "mandatory";
  const holiday = holidaySource
    ? {
        id: idString(holidaySource._id),
        date: parsedDate.dateKey,
        name: String(holidaySource.name || "Holiday").trim(),
        type: holidayType as "mandatory" | "optional",
        isHalfDay: holidaySource.isHalfDay === true,
        description: String(holidaySource.description || "").trim(),
      }
    : null;

  const scheduledMinutes =
    scheduledDay.isWorkingDay === true && shift ? shift.scheduledMinutes : scheduledDay.isWorkingDay === false ? 0 : null;
  let dayType: EmployeeDayType =
    scheduledDay.isWorkingDay === null
      ? "unconfigured"
      : scheduledDay.isWorkingDay
        ? "working_day"
        : "weekly_off";
  let requiresAttendance = scheduledDay.isWorkingDay;
  let expectedWorkMinutes = scheduledMinutes;

  if (holiday?.type === "mandatory") {
    if (holiday.isHalfDay) {
      dayType = "mandatory_half_day_holiday";
      if (scheduledDay.isWorkingDay === true && scheduledMinutes !== null) {
        expectedWorkMinutes = Math.round(scheduledMinutes / 2);
        requiresAttendance = expectedWorkMinutes > 0;
      } else if (scheduledDay.isWorkingDay === false) {
        expectedWorkMinutes = 0;
        requiresAttendance = false;
      } else {
        expectedWorkMinutes = null;
        requiresAttendance = null;
      }
    } else {
      dayType = "mandatory_holiday";
      expectedWorkMinutes = 0;
      requiresAttendance = false;
    }
  } else if (holiday?.type === "optional" && scheduledDay.isWorkingDay === true) {
    dayType = "optional_holiday";
  }

  const defaultAttendanceStatus: DefaultAttendanceStatus =
    holiday?.type === "mandatory" && !holiday.isHalfDay
      ? "holiday"
      : scheduledDay.isWorkingDay === false
        ? "weekly_off"
        : "pending";

  return {
    attendanceDate: parsedDate.dateKey,
    dayOfWeek: parsedDate.dayOfWeek,
    weekOfMonth: parsedDate.weekOfMonth,
    timezone: rules?.timezone || options.holidayCalendarVersion?.timezone || null,
    dayType,
    requiresAttendance,
    expectedWorkMinutes,
    defaultAttendanceStatus,
    schedule: {
      configured: Boolean(rules),
      isWorkingDay: scheduledDay.isWorkingDay,
      weeklyOffReason: scheduledDay.weeklyOffReason,
      startTime: rules?.startTime || null,
      endTime: rules?.endTime || null,
      grossMinutes: shift?.grossMinutes ?? null,
      unpaidBreakMinutes: shift?.unpaidBreakMinutes ?? null,
      scheduledMinutes,
    },
    holiday,
    warnings,
  };
}

export function compactPolicyReference(
  resolved: ResolvedPolicyLike<any> | null | undefined
): EmployeeDayPolicyReference | null {
  if (!resolved) return null;
  const resource = resolved.assignment?.resource;
  return {
    assignmentId: idString(resolved.assignment?._id),
    resourceId:
      idString(resource) ||
      idString(resolved.version?.policy) ||
      idString(resolved.version?.schedule) ||
      idString(resolved.version?.calendar),
    versionId: idString(resolved.version?._id),
    versionNumber: Number.isFinite(Number(resolved.version?.versionNumber))
      ? Number(resolved.version.versionNumber)
      : null,
    scopeType: resolved.assignment?.scopeType || null,
    scopeId: idString(resolved.assignment?.scopeId),
    effectiveFrom: resolved.version?.effectiveFrom || null,
    effectiveTo: resolved.version?.effectiveTo || null,
  };
}

export function buildEmployeeDayContext(options: {
  attendanceDate: string;
  policyResolution: EmployeePolicyResolutionLike;
}) {
  const { policyResolution } = options;
  const classification = classifyEmployeeDay({
    attendanceDate: options.attendanceDate,
    workScheduleVersion: policyResolution.workSchedule?.version || null,
    holidayCalendarVersion: policyResolution.holidayCalendar?.version || null,
  });
  const missingPolicies = [
    ["attendance_policy", policyResolution.attendancePolicy],
    ["work_schedule", policyResolution.workSchedule],
    ["holiday_calendar", policyResolution.holidayCalendar],
    ["leave_policy", policyResolution.leavePolicy],
  ]
    .filter(([, resolved]) => !resolved)
    .map(([resourceType]) => resourceType as string);
  const warnings = new Set<string>([
    ...(policyResolution.warnings || []),
    ...classification.warnings,
  ]);
  const scheduleTimezone = policyResolution.workSchedule?.version?.rules?.timezone;
  const calendarTimezone = policyResolution.holidayCalendar?.version?.timezone;
  if (scheduleTimezone && calendarTimezone && scheduleTimezone !== calendarTimezone) {
    warnings.add("Work schedule and holiday calendar use different timezones");
  }

  return {
    ...classification,
    employee: policyResolution.employee,
    organizationAssignment: policyResolution.organizationAssignment,
    policies: {
      attendancePolicy: policyResolution.attendancePolicy || null,
      workSchedule: policyResolution.workSchedule || null,
      holidayCalendar: policyResolution.holidayCalendar || null,
      leavePolicy: policyResolution.leavePolicy || null,
      remoteWorkPolicy: policyResolution.remoteWorkPolicy || null,
    },
    policyReferences: {
      attendancePolicy: compactPolicyReference(policyResolution.attendancePolicy),
      workSchedule: compactPolicyReference(policyResolution.workSchedule),
      holidayCalendar: compactPolicyReference(policyResolution.holidayCalendar),
      leavePolicy: compactPolicyReference(policyResolution.leavePolicy),
      remoteWorkPolicy: compactPolicyReference(policyResolution.remoteWorkPolicy),
    },
    missingPolicies,
    warnings: Array.from(warnings),
  };
}
