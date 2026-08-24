import type { AttendanceRules } from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";

export interface AttendanceCalculationPunchSession {
  punchIn?: Date | string | null;
  punchOut?: Date | string | null;
}

export interface AttendanceCalculationSchedule {
  startTime?: string | null;
  endTime?: string | null;
}

export interface AttendanceCalculationInput {
  attendanceDate: string;
  timezone: string;
  punchSessions: AttendanceCalculationPunchSession[];
  attendanceRules: Partial<AttendanceRules>;
  schedule?: AttendanceCalculationSchedule | null;
  requiresAttendance?: boolean | null;
  expectedWorkMinutes?: number | null;
  defaultAttendanceStatus?: "pending" | "holiday" | "weekly_off";
}

export interface AttendanceCalculationResult {
  status:
    | "pending"
    | "present"
    | "absent"
    | "half_day"
    | "holiday"
    | "weekly_off"
    | "incomplete";
  state: "open" | "calculated";
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyExitMinutes: number;
  overtimeMinutes: number;
  isLate: boolean;
  isEarlyExit: boolean;
  hasMissingPunch: boolean;
  hasOpenSession: boolean;
}

const DEFAULT_RULES: AttendanceRules = {
  gracePeriodMinutesLate: 0,
  gracePeriodMinutesEarly: 0,
  minimumFullDayMinutes: 480,
  minimumHalfDayMinutes: 240,
  requirePunchOut: true,
  allowMultiplePunches: false,
  missingPunchTreatment: "flag_incomplete",
  overtimeEnabled: false,
  overtimeStartsAfterMinutes: 0,
};

function validDate(value: Date | string | null | undefined) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function timeMinutes(value: string | null | undefined) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
}

function localParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function wallClockScalar(value: Date, timezone: string) {
  const parts = localParts(value, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) / 60_000;
}

function scheduleScalars(attendanceDate: string, schedule?: AttendanceCalculationSchedule | null) {
  const start = timeMinutes(schedule?.startTime);
  const end = timeMinutes(schedule?.endTime);
  if (start === null || end === null || start === end) return null;
  const [year, month, day] = attendanceDate.split("-").map(Number);
  const dayStart = Date.UTC(year, month - 1, day) / 60_000;
  return {
    start: dayStart + start,
    end: dayStart + end + (end <= start ? 24 * 60 : 0),
  };
}

function roundedMinutes(milliseconds: number) {
  return Math.max(0, Math.floor(milliseconds / 60_000));
}

export function calculateAttendance(
  input: AttendanceCalculationInput
): AttendanceCalculationResult {
  const rules = { ...DEFAULT_RULES, ...(input.attendanceRules || {}) };
  const sessions = (input.punchSessions || []).map((session) => ({
    punchIn: validDate(session.punchIn),
    punchOut: validDate(session.punchOut),
  }));
  const completeSessions = sessions
    .filter(
      (session): session is { punchIn: Date; punchOut: Date } =>
        Boolean(
          session.punchIn &&
            session.punchOut &&
            session.punchOut.getTime() >= session.punchIn.getTime()
        )
    )
    .sort((left, right) => left.punchIn.getTime() - right.punchIn.getTime());
  const hasMissingPunch = sessions.some(
    (session) =>
      !session.punchIn ||
      !session.punchOut ||
      session.punchOut.getTime() < session.punchIn.getTime()
  );
  const hasOpenSession = sessions.some(
    (session) => Boolean(session.punchIn && !session.punchOut)
  );
  const workedMinutes = completeSessions.reduce(
    (total, session) =>
      total + roundedMinutes(session.punchOut.getTime() - session.punchIn.getTime()),
    0
  );
  const breakMinutes = completeSessions.slice(1).reduce((total, session, index) => {
    const previous = completeSessions[index];
    return total + roundedMinutes(session.punchIn.getTime() - previous.punchOut.getTime());
  }, 0);

  const schedule = scheduleScalars(input.attendanceDate, input.schedule);
  const firstPunch = sessions
    .map((session) => session.punchIn)
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => left.getTime() - right.getTime())[0];
  const lastPunchOut = completeSessions.length
    ? completeSessions[completeSessions.length - 1].punchOut
    : undefined;
  const lateMinutes =
    schedule && firstPunch
      ? Math.max(
          0,
          Math.floor(
            wallClockScalar(firstPunch, input.timezone) -
              schedule.start -
              Math.max(0, Number(rules.gracePeriodMinutesLate || 0))
          )
        )
      : 0;
  const earlyExitMinutes =
    schedule && lastPunchOut && !hasOpenSession
      ? Math.max(
          0,
          Math.floor(
            schedule.end -
              wallClockScalar(lastPunchOut, input.timezone) -
              Math.max(0, Number(rules.gracePeriodMinutesEarly || 0))
          )
        )
      : 0;
  const overtimeThreshold = Math.max(
    0,
    Number(rules.overtimeStartsAfterMinutes || input.expectedWorkMinutes || 0)
  );
  const overtimeMinutes = rules.overtimeEnabled
    ? Math.max(0, workedMinutes - overtimeThreshold)
    : 0;

  let status: AttendanceCalculationResult["status"] =
    input.defaultAttendanceStatus || "pending";
  if (sessions.length > 0) {
    if (hasOpenSession) {
      status = "pending";
    } else if (hasMissingPunch && rules.requirePunchOut) {
      status =
        rules.missingPunchTreatment === "half_day"
          ? "half_day"
          : rules.missingPunchTreatment === "absent"
            ? "absent"
            : "incomplete";
    } else if (input.requiresAttendance === false && workedMinutes > 0) {
      status = "present";
    } else {
      const configuredFullDay = Math.max(1, Number(rules.minimumFullDayMinutes || 1));
      const expected = Number(input.expectedWorkMinutes);
      const fullDayThreshold =
        Number.isFinite(expected) && expected > 0
          ? Math.min(configuredFullDay, expected)
          : configuredFullDay;
      const halfDayThreshold = Math.min(
        Math.max(1, Number(rules.minimumHalfDayMinutes || 1)),
        fullDayThreshold
      );
      status =
        workedMinutes >= fullDayThreshold
          ? "present"
          : workedMinutes >= halfDayThreshold
            ? "half_day"
            : "absent";
    }
  }

  return {
    status,
    state: hasOpenSession ? "open" : "calculated",
    workedMinutes,
    breakMinutes,
    lateMinutes,
    earlyExitMinutes,
    overtimeMinutes,
    isLate: lateMinutes > 0,
    isEarlyExit: earlyExitMinutes > 0,
    hasMissingPunch,
    hasOpenSession,
  };
}
