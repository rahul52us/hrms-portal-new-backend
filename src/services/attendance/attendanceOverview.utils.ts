export const ATTENDANCE_OVERVIEW_STATUSES = [
  "all",
  "not_marked",
  "pending",
  "present",
  "half_day",
  "absent",
  "incomplete",
  "leave",
  "holiday",
  "weekly_off",
] as const;

export const ATTENDANCE_OVERVIEW_WORK_MODES = [
  "all",
  "office",
  "remote",
  "hybrid",
  "field",
] as const;

export const ATTENDANCE_OVERVIEW_EXCEPTIONS = [
  "all",
  "missing_punch",
  "late_arrival",
  "early_exit",
  "absence",
  "overtime",
  "setup_gap",
] as const;

export type AttendanceOverviewStatus =
  (typeof ATTENDANCE_OVERVIEW_STATUSES)[number];

export function idString(value: any) {
  return String(value?._id || value || "");
}

export function approvedRequestDay(request: any, attendanceDate: string, kind: "leave" | "wfh") {
  if (!request || request.status !== "approved") return null;
  const days = kind === "leave" ? request.dayBreakdown || [] : request.dates || [];
  const day = days.find((item: any) => item.attendanceDate === attendanceDate) || null;
  if (kind === "leave" && day && Number(day.chargedUnits || 0) <= 0) return null;
  return day;
}

export function deriveAttendanceStatus(options: {
  record?: any;
  leaveDay?: any;
  classification?: any;
}) {
  if (options.record?.status) return String(options.record.status);
  if (options.leaveDay) {
    return Number(options.leaveDay.chargedUnits || 0) >= 1 ? "leave" : "half_day";
  }
  if (options.classification?.defaultAttendanceStatus === "holiday") return "holiday";
  if (options.classification?.defaultAttendanceStatus === "weekly_off") return "weekly_off";
  return "not_marked";
}

export function deriveAttendanceWorkMode(options: {
  record?: any;
  remoteWorkDay?: any;
}) {
  if (options.record?.workMode) return String(options.record.workMode);
  if (!options.remoteWorkDay) return "office";
  return options.remoteWorkDay.portion === "full" ? "remote" : "hybrid";
}

export function firstPunchIn(record: any) {
  return (record?.punchSessions || [])
    .map((session: any) => session?.punchIn)
    .filter(Boolean)
    .sort((left: any, right: any) => new Date(left).getTime() - new Date(right).getTime())[0] || null;
}

export function finalPunchOut(record: any) {
  return (record?.punchSessions || [])
    .map((session: any) => session?.punchOut)
    .filter(Boolean)
    .sort((left: any, right: any) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
}

export function hasOpenPunch(record: any) {
  return (record?.punchSessions || []).some(
    (session: any) => Boolean(session?.punchIn) && !session?.punchOut
  );
}

export function createAttendanceSummary() {
  return {
    employees: 0,
    expected: 0,
    exceptions: 0,
    punchedIn: 0,
    present: 0,
    absent: 0,
    halfDay: 0,
    onLeave: 0,
    wfh: 0,
    holiday: 0,
    weeklyOff: 0,
    late: 0,
    incomplete: 0,
    pending: 0,
    notMarked: 0,
    unconfigured: 0,
  };
}

export function addAttendanceSummaryRow(summary: ReturnType<typeof createAttendanceSummary>, row: any) {
  summary.employees += 1;
  if (row.requiresAttendance === true) summary.expected += 1;
  if (
    ["absent", "incomplete"].includes(row.status) ||
    row.isLate ||
    row.isEarlyExit ||
    row.hasMissingPunch
  ) {
    summary.exceptions += 1;
  }
  if (row.firstIn) summary.punchedIn += 1;
  if (row.status === "present") summary.present += 1;
  if (row.status === "absent") summary.absent += 1;
  if (row.status === "half_day") summary.halfDay += 1;
  if (row.status === "leave") summary.onLeave += 1;
  if (row.workMode === "remote" || row.workMode === "hybrid") summary.wfh += 1;
  if (row.status === "holiday") summary.holiday += 1;
  if (row.status === "weekly_off") summary.weeklyOff += 1;
  if (row.isLate) summary.late += 1;
  if (row.status === "incomplete") summary.incomplete += 1;
  if (row.status === "pending") summary.pending += 1;
  if (row.status === "not_marked") summary.notMarked += 1;
  if (row.dayType === "unconfigured" || row.setupGaps?.length) summary.unconfigured += 1;
  return summary;
}

export function attendanceRowMatches(
  row: any,
  status: string,
  workMode: string,
  exception = "all"
) {
  if (status !== "all" && row.status !== status) return false;
  if (workMode !== "all" && row.workMode !== workMode) return false;
  if (exception === "missing_punch" && !row.hasMissingPunch) return false;
  if (exception === "late_arrival" && !row.isLate) return false;
  if (exception === "early_exit" && !row.isEarlyExit) return false;
  if (exception === "absence" && row.status !== "absent") return false;
  if (exception === "overtime" && Number(row.overtimeMinutes || 0) <= 0) return false;
  if (
    exception === "setup_gap" &&
    row.dayType !== "unconfigured" &&
    row.schedule?.configured !== false &&
    !row.setupGaps?.length
  ) {
    return false;
  }
  return true;
}
