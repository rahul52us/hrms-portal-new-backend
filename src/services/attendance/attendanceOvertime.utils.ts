export function overtimeMinutesForApproval(record: {
  dayTypeSnapshot?: string | null;
  workedMinutes?: number | null;
  overtimeMinutes?: number | null;
}) {
  const dayType = String(record.dayTypeSnapshot || "").toLowerCase();
  if (["weekly_off", "mandatory_holiday"].includes(dayType)) {
    return Math.max(0, Number(record.workedMinutes || 0));
  }
  return Math.max(0, Number(record.overtimeMinutes || 0));
}

export function approvedMinutesAvailable(record: {
  overtimeApprovalRequiredSnapshot?: boolean | null;
  overtimeApprovalStatus?: string | null;
  approvedOvertimeMinutes?: number | null;
  workedMinutes?: number | null;
}) {
  if (!record.overtimeApprovalRequiredSnapshot) {
    return Math.max(0, Number(record.workedMinutes || 0));
  }
  if (record.overtimeApprovalStatus !== "approved") return 0;
  return Math.max(0, Number(record.approvedOvertimeMinutes || 0));
}
