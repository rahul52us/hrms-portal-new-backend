export interface PunchSessionValue {
  punchIn?: Date | string | null;
  punchOut?: Date | string | null;
  [key: string]: any;
}

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

export function previousAttendanceDate(attendanceDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(attendanceDate);
  if (!match) return "";
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    value.getUTCFullYear() !== Number(match[1]) ||
    value.getUTCMonth() !== Number(match[2]) - 1 ||
    value.getUTCDate() !== Number(match[3])
  ) {
    return "";
  }
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function isPunchOutAllowedForAttendanceDay(options: {
  attendanceDate: string;
  currentAttendanceDate: string;
  scheduleStartTime?: string | null;
  scheduleEndTime?: string | null;
}) {
  if (options.attendanceDate === options.currentAttendanceDate) return true;
  if (previousAttendanceDate(options.currentAttendanceDate) !== options.attendanceDate) return false;

  const start = timeMinutes(options.scheduleStartTime);
  const end = timeMinutes(options.scheduleEndTime);
  return start !== null && end !== null && end < start;
}

export function buildFinalPunchSession(
  sessions: PunchSessionValue[],
  punchOut: Date
) {
  const punchedIn = (sessions || [])
    .map((session) => ({
      raw: session?.toObject ? session.toObject() : session,
      punchIn: validDate(session?.punchIn),
      punchOut: validDate(session?.punchOut),
    }))
    .filter(
      (session): session is {
        raw: PunchSessionValue;
        punchIn: Date;
        punchOut: Date | null;
      } => Boolean(session.punchIn)
    )
    .sort((left, right) => left.punchIn.getTime() - right.punchIn.getTime());

  const first = punchedIn[0];
  if (!first) return null;

  const previousPunchOut = punchedIn
    .map((session) => session.punchOut)
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime())[0] || null;

  return {
    session: {
      ...first.raw,
      punchIn: first.punchIn,
      punchOut,
    },
    previousPunchOut,
  };
}
