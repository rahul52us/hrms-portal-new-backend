import { generateError } from "../../config/Error/functions";
import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";

export type LeavePortion = "full" | "first_half" | "second_half";

export interface LeaveCalculationInput {
  leaveTypeId: string;
  leaveUnit: "days" | "hours";
  fromDate: string;
  toDate: string;
  startPortion?: LeavePortion;
  endPortion?: LeavePortion;
  requestedHours?: number | null;
  contexts: any[];
  currentDate?: string;
  attachmentCount?: number;
  joiningDate?: unknown;
  confirmationDate?: unknown;
  employmentEndDate?: unknown;
}

function idString(value: any) {
  return String(value?._id || value || "").trim();
}

function roundUnits(value: number) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function dateKey(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatUtcDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function enumerateDateKeys(fromDate: string, toDate: string, maxDays = 366) {
  const from = parseAttendanceDate(fromDate).date;
  const to = parseAttendanceDate(toDate).date;
  if (from.getTime() > to.getTime()) {
    throw generateError("Leave start date cannot be after end date", 400);
  }

  const inclusiveDays = Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;
  if (inclusiveDays > maxDays) {
    throw generateError(`A leave request cannot span more than ${maxDays} calendar days`, 400);
  }

  return Array.from({ length: inclusiveDays }, (_, index) => formatUtcDate(addUtcDays(from, index)));
}

function clampedDate(year: number, month: number, day: number) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(day, lastDay)));
}

export function resolveLeaveYear(
  attendanceDate: string,
  startMonth: number,
  startDay: number
) {
  const date = parseAttendanceDate(attendanceDate).date;
  const candidate = clampedDate(date.getUTCFullYear(), startMonth, startDay);
  const startYear = date.getTime() >= candidate.getTime() ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  const start = clampedDate(startYear, startMonth, startDay);
  const nextStart = clampedDate(startYear + 1, startMonth, startDay);
  const end = addUtcDays(nextStart, -1);
  const leaveYearStart = formatUtcDate(start);
  const leaveYearEnd = formatUtcDate(end);
  return {
    leaveYearKey: `${leaveYearStart}:${leaveYearEnd}`,
    leaveYearStart,
    leaveYearEnd,
  };
}

function getRule(context: any, leaveTypeId: string) {
  const leavePolicyVersion = context?.policies?.leavePolicy?.version;
  if (!leavePolicyVersion) {
    throw generateError(`No leave policy is effective on ${context.attendanceDate}`, 422);
  }
  const rule = (leavePolicyVersion.rules || []).find(
    (item: any) => idString(item.leaveType) === leaveTypeId
  );
  if (!rule) {
    throw generateError(`The selected leave type is not available on ${context.attendanceDate}`, 422);
  }
  return { rule, leavePolicyVersion };
}

function portionForDate(
  index: number,
  total: number,
  startPortion: LeavePortion,
  endPortion: LeavePortion
) {
  if (total === 1) return startPortion;
  if (index === 0) return startPortion;
  if (index === total - 1) return endPortion;
  return "full" as LeavePortion;
}

function portionUnits(portion: LeavePortion) {
  return portion === "full" ? 1 : 0.5;
}

function buildPolicyFields(context: any) {
  const organization = context.organizationAssignment || {};
  const refs = context.policyReferences || {};
  return {
    employeeAssignmentHistory: organization._id || null,
    department: organization.department || null,
    departmentNameSnapshot: organization.departmentNameSnapshot || "",
    teamId: organization.teamId || null,
    teamNameSnapshot: organization.teamNameSnapshot || "",
    officeLocation: organization.officeLocation || null,
    officeLocationNameSnapshot: organization.officeLocationNameSnapshot || "",
    reportingManager: organization.reportingManager || null,
    reportingManagerNameSnapshot: organization.reportingManagerNameSnapshot || "",
    attendancePolicyAssignment: refs.attendancePolicy?.assignmentId || null,
    attendancePolicy: refs.attendancePolicy?.resourceId || null,
    attendancePolicyVersion: refs.attendancePolicy?.versionId || null,
    leavePolicyAssignment: refs.leavePolicy?.assignmentId || null,
    leavePolicy: refs.leavePolicy?.resourceId || null,
    leavePolicyVersion: refs.leavePolicy?.versionId || null,
    leavePolicyVersionNumber: refs.leavePolicy?.versionNumber || null,
    workScheduleAssignment: refs.workSchedule?.assignmentId || null,
    workSchedule: refs.workSchedule?.resourceId || null,
    workScheduleVersion: refs.workSchedule?.versionId || null,
    holidayCalendarAssignment: refs.holidayCalendar?.assignmentId || null,
    holidayCalendar: refs.holidayCalendar?.resourceId || null,
    holidayCalendarVersion: refs.holidayCalendar?.versionId || null,
  };
}

function getCurrentDateKey(value?: string) {
  if (value) return parseAttendanceDate(value).dateKey;
  return new Date().toISOString().slice(0, 10);
}

export function calculateLeaveRequest(input: LeaveCalculationInput) {
  const leaveTypeId = idString(input.leaveTypeId);
  const dateKeys = enumerateDateKeys(input.fromDate, input.toDate);
  if (input.contexts.length !== dateKeys.length) {
    throw generateError("Leave calculation context is incomplete", 500);
  }
  input.contexts.forEach((context, index) => {
    if (context.attendanceDate !== dateKeys[index]) {
      throw generateError("Leave calculation context dates are out of sequence", 500);
    }
  });

  const joiningDate = dateKey(input.joiningDate);
  const confirmationDate = dateKey(input.confirmationDate);
  const employmentEndDate = dateKey(input.employmentEndDate);
  if (joiningDate && input.fromDate < joiningDate) {
    throw generateError("Leave cannot start before the employee joining date", 422);
  }
  if (employmentEndDate && input.toDate > employmentEndDate) {
    throw generateError("Leave cannot end after the employee employment end date", 422);
  }

  const startPortion = input.startPortion || "full";
  const endPortion = dateKeys.length === 1 ? startPortion : input.endPortion || "full";
  const validPortions: LeavePortion[] = ["full", "first_half", "second_half"];
  if (!validPortions.includes(startPortion) || !validPortions.includes(endPortion)) {
    throw generateError("Leave day portion must be full, first_half, or second_half", 422);
  }
  const isHourly = input.leaveUnit === "hours";
  if (isHourly && dateKeys.length !== 1) {
    throw generateError("Hourly leave must be requested for one date at a time", 422);
  }
  if (isHourly && (startPortion !== "full" || endPortion !== "full")) {
    throw generateError("Day portions do not apply to hourly leave", 422);
  }

  const requestedHours = Number(input.requestedHours || 0);
  if (isHourly && (!Number.isFinite(requestedHours) || requestedHours < 0.25)) {
    throw generateError("Requested hours must be at least 0.25", 422);
  }

  const rules: any[] = [];
  const days = input.contexts.map((context, index) => {
    const { rule, leavePolicyVersion } = getRule(context, leaveTypeId);
    rules.push(rule);
    const portion = isHourly
      ? ("full" as LeavePortion)
      : portionForDate(index, dateKeys.length, startPortion, endPortion);
    if (!isHourly && portion !== "full" && (!rule.allowHalfDay || rule.allowHalfDay === false)) {
      throw generateError(`Half-day leave is not allowed on ${context.attendanceDate}`, 422);
    }

    const requestedUnits = isHourly ? requestedHours : portionUnits(portion);
    let chargedUnits = requestedUnits;
    let chargeReason = "scheduled_work";
    if (context.dayType === "weekly_off" || context.dayType === "mandatory_holiday") {
      chargedUnits = 0;
      chargeReason = context.dayType;
    } else if (context.dayType === "mandatory_half_day_holiday") {
      if (isHourly) {
        const maxHours = Number(context.expectedWorkMinutes || 0) / 60;
        if (maxHours <= 0) {
          chargedUnits = 0;
          chargeReason = "mandatory_half_day_holiday_without_work";
        } else if (requestedHours > maxHours) {
          throw generateError(`Hourly leave exceeds the scheduled hours on ${context.attendanceDate}`, 422);
        } else {
          chargeReason = "scheduled_half_day_work";
        }
      } else {
        chargedUnits = Math.min(requestedUnits, 0.5);
        chargeReason = "scheduled_half_day_work";
      }
    } else if (context.dayType === "unconfigured") {
      throw generateError(`Work schedule is not configured on ${context.attendanceDate}`, 422);
    } else if (isHourly) {
      const maxHours = Number(context.expectedWorkMinutes || 0) / 60;
      if (maxHours <= 0 || requestedHours > maxHours) {
        throw generateError(`Hourly leave exceeds the scheduled hours on ${context.attendanceDate}`, 422);
      }
    }

    const leaveYear = resolveLeaveYear(
      context.attendanceDate,
      Number(leavePolicyVersion.leaveYearStartMonth || 1),
      Number(leavePolicyVersion.leaveYearStartDay || 1)
    );
    return {
      attendanceDate: context.attendanceDate,
      dayType: context.dayType,
      portion,
      requestedUnits: roundUnits(requestedUnits),
      chargedUnits: roundUnits(chargedUnits),
      chargeReason,
      entitlementMode: rule.entitlementMode || (rule.balanceTracked === false ? "untracked" : "fixed"),
      timezone: context.timezone || "Asia/Kolkata",
      ...leaveYear,
      holiday: context.holiday
        ? {
            name: context.holiday.name,
            type: context.holiday.type,
            isHalfDay: context.holiday.isHalfDay,
          }
        : null,
      ...buildPolicyFields(context),
    };
  });

  if (!isHourly) {
    const chargedIndexes = days
      .map((day, index) => (day.chargedUnits > 0 ? index : -1))
      .filter((index) => index >= 0);
    const firstChargedIndex = chargedIndexes[0];
    const lastChargedIndex = chargedIndexes[chargedIndexes.length - 1];
    if (firstChargedIndex !== undefined && lastChargedIndex !== undefined) {
      for (let index = firstChargedIndex + 1; index < lastChargedIndex; index += 1) {
        const day = days[index];
        if (
          day.chargedUnits === 0 &&
          rules[index]?.sandwichRuleEnabled === true &&
          ["weekly_off", "mandatory_holiday"].includes(day.dayType)
        ) {
          day.chargedUnits = 1;
          day.chargeReason = "sandwich_rule";
        }
      }
    }
  }

  const requestedUnits = roundUnits(days.reduce((sum, day) => sum + day.requestedUnits, 0));
  const chargedUnits = roundUnits(days.reduce((sum, day) => sum + day.chargedUnits, 0));
  if (chargedUnits <= 0) {
    throw generateError("The selected dates do not contain any chargeable work time", 422);
  }
  const entitlementModes = new Set(days.map((day) => day.entitlementMode));
  if (entitlementModes.size > 1) {
    throw generateError("The leave entitlement mode changes within the selected date range", 409);
  }

  const minimumRequest = Math.max(...rules.map((rule) => Number(rule.minimumRequestDays || 0.25)));
  const maximumValues = rules
    .map((rule) => Number(rule.maximumRequestDays))
    .filter((value) => Number.isFinite(value) && value > 0);
  const maximumRequest = maximumValues.length ? Math.min(...maximumValues) : null;
  if (chargedUnits < minimumRequest) {
    throw generateError(`Minimum leave request is ${minimumRequest} ${input.leaveUnit}`, 422);
  }
  if (maximumRequest !== null && chargedUnits > maximumRequest) {
    throw generateError(`Maximum leave request is ${maximumRequest} ${input.leaveUnit}`, 422);
  }

  const minimumNoticeDays = Math.max(...rules.map((rule) => Number(rule.minimumNoticeDays || 0)));
  const currentDate = parseAttendanceDate(getCurrentDateKey(input.currentDate)).date;
  const fromDate = parseAttendanceDate(input.fromDate).date;
  const noticeDays = Math.floor((fromDate.getTime() - currentDate.getTime()) / 86400000);
  if (noticeDays < minimumNoticeDays) {
    throw generateError(`This leave requires at least ${minimumNoticeDays} calendar days notice`, 422);
  }

  const probationRules = rules.map((rule) => String(rule.probationEligibility || "allowed"));
  if (probationRules.includes("not_allowed")) {
    throw generateError("This leave type is not available during the configured probation rule", 422);
  }
  if (probationRules.includes("after_confirmation")) {
    if (!confirmationDate) {
      throw generateError("Employee confirmation date is required for this leave type", 422);
    }
    if (input.fromDate < confirmationDate) {
      throw generateError("This leave type is available only after employee confirmation", 422);
    }
  }

  const documentRules = rules
    .map((rule) => ({
      thresholdUnits: Number(
        rule.documentRequiredFromUnits ?? rule.documentRequiredAfterDays
      ),
      submissionMode:
        rule.documentSubmissionMode === "with_request"
          ? "with_request"
          : "allow_later",
      dueDaysAfterLeaveEnd: Number(rule.documentDueDaysAfterLeaveEnd ?? 2),
    }))
    .filter((rule) => Number.isFinite(rule.thresholdUnits) && rule.thresholdUnits > 0);
  const documentRequiredFrom = documentRules.length
    ? Math.min(...documentRules.map((rule) => rule.thresholdUnits))
    : null;
  const documentRequired =
    documentRequiredFrom !== null && chargedUnits >= documentRequiredFrom;
  const documentSubmissionMode = documentRequired
    ? documentRules.some((rule) => rule.submissionMode === "with_request")
      ? "with_request"
      : "allow_later"
    : null;
  const documentDueDaysAfterLeaveEnd = documentRequired && documentSubmissionMode === "allow_later"
    ? Math.max(
        0,
        Math.min(
          ...documentRules.map((rule) =>
            Number.isFinite(rule.dueDaysAfterLeaveEnd)
              ? rule.dueDaysAfterLeaveEnd
              : 2
          )
        )
      )
    : null;
  const documentDueDate = documentDueDaysAfterLeaveEnd === null
    ? null
    : formatUtcDate(
        addUtcDays(parseAttendanceDate(input.toDate).date, documentDueDaysAfterLeaveEnd)
      );

  const balanceRulesByYear = new Map<string, any>();
  days.forEach((day, index) => {
    if (day.chargedUnits <= 0) return;
    const current = balanceRulesByYear.get(day.leaveYearKey);
    const rule = rules[index];
    const negativeBalanceAllowed = rule.negativeBalanceAllowed === true;
    const maxNegativeBalance = negativeBalanceAllowed ? Number(rule.maxNegativeBalance || 0) : 0;
    balanceRulesByYear.set(day.leaveYearKey, {
      leaveYearKey: day.leaveYearKey,
      leaveYearStart: day.leaveYearStart,
      leaveYearEnd: day.leaveYearEnd,
      chargedUnits: roundUnits((current?.chargedUnits || 0) + day.chargedUnits),
      firstAttendanceDate: current?.firstAttendanceDate || day.attendanceDate,
      lastAttendanceDate: day.attendanceDate,
      balanceTracked: rule.balanceTracked !== false,
      entitlementMode: rule.entitlementMode || (rule.balanceTracked === false ? "untracked" : "fixed"),
      negativeBalanceAllowed: current
        ? current.negativeBalanceAllowed && negativeBalanceAllowed
        : negativeBalanceAllowed,
      maxNegativeBalance: current
        ? Math.min(current.maxNegativeBalance, maxNegativeBalance)
        : maxNegativeBalance,
      leavePolicyAssignment: day.leavePolicyAssignment,
      leavePolicy: day.leavePolicy,
      leavePolicyVersion: day.leavePolicyVersion,
    });
  });

  return {
    requestedUnits,
    chargedUnits,
    startPortion,
    endPortion,
    requestedHours: isHourly ? requestedHours : null,
    dayBreakdown: days,
    balanceSegments: Array.from(balanceRulesByYear.values()),
    constraints: {
      minimumRequest,
      maximumRequest,
      minimumNoticeDays,
      documentRequiredFrom,
    },
    documentRequirement: {
      required: documentRequired,
      thresholdUnits: documentRequiredFrom,
      submissionMode: documentSubmissionMode,
      dueDaysAfterLeaveEnd: documentDueDaysAfterLeaveEnd,
      dueDate: documentDueDate,
      provided: Number(input.attachmentCount || 0) > 0,
    },
    entitlementMode: days[0]?.entitlementMode || "fixed",
  };
}
