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
