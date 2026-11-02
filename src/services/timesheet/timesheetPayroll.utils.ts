import { createHash } from "crypto";
import { timesheetContextSnapshot, timesheetWorkFingerprint } from "./timesheetContext.service";

export const roundTimesheetDays = (value: number) => Math.round(value * 1000000) / 1000000;
export const timesheetSourceHash = (value: any) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function calculateTimesheetPayrollDay(day: any, sheet: any, attendance: any, now: Date, correction = false) {
  const fullMinutes = day.requirement.fullMinutes || 0, requiredMinutes = day.requirement.requiredMinutes || 0;
  const mode = day.rules?.payrollMode || "report_only", blockers: string[] = [];
  const status = sheet?.status || "missing";
  const creditedMinutes = status === "approved" ? Math.min(requiredMinutes, sheet.loggedMinutes) : 0;
  const unpaidLeaveUnits = attendance?.paidLeave ? 0 : Math.min(Number(attendance?.leaveUnits || 0), Number(attendance?.unpaidUnits || 0));
  const baseAttendanceLop = Math.max(0, Number(attendance?.unpaidUnits || 0) - unpaidLeaveUnits);
  const remainingPaidWork = Math.max(0, Number(attendance?.paidUnits || 0) - (attendance?.paidLeave ? Number(attendance.leaveUnits || 0) : 0));
  const shortfallFraction = fullMinutes ? Math.max(0, requiredMinutes - creditedMinutes) / fullMinutes : 0;
  const active = mode !== "report_only" && Boolean(day.rules?.required && (requiredMinutes || day.eligibility.setupIssues.length));
  if (active) {
    blockers.push(...day.eligibility.setupIssues.map((issue: any) => issue.message));
    if (!fullMinutes) blockers.push("Net shift duration is missing");
    if (!attendance || String(day.record?._id) !== String(attendance.attendanceRecord) || day.record?.revisionNumber !== attendance.attendanceRevisionNumber) blockers.push("Attendance changed after its locked payroll handoff; reconcile attendance first");
    if (status === "submitted") blockers.push("Timesheet approval is pending");
    if (status === "approved" && (sheet.requiredMinutes !== requiredMinutes || timesheetWorkFingerprint(sheet.contextSnapshot) !== timesheetWorkFingerprint(timesheetContextSnapshot(day)))) blockers.push("Timesheet context changed; return/reopen and reapprove it");
    const cutoff = day.eligibility.editableUntilAt;
    if (!correction && (!cutoff || now <= new Date(cutoff))) blockers.push("The employee submission/correction cutoff has not passed");
    if (mode === "block" && (status !== "approved" || creditedMinutes < requiredMinutes)) blockers.push("The policy blocks payroll until this day is complete or HR-exempt");
  }
  const additionalLopDays = active && mode === "shortfall" && !blockers.length ? roundTimesheetDays(Math.min(remainingPaidWork, Math.max(0, shortfallFraction - baseAttendanceLop))) : 0;
  const evidence = {
    attendanceDate: day.context.attendanceDate, mode, status, fullMinutes, requiredMinutes,
    loggedMinutes: sheet?.loggedMinutes || 0, creditedMinutes, exemptMinutes: day.eligibility.exemptMinutes || 0,
    shortfallMinutes: Math.max(0, requiredMinutes - creditedMinutes), baseAttendanceLop, unpaidLeaveUnits,
    additionalLopDays, remainingPaidWork, cutoffAt: day.eligibility.editableUntilAt,
    timesheet: sheet?._id || null, sheetRevision: sheet?.revision || 0, controlRevision: day.controls.revision,
    attendanceRecord: attendance?.attendanceRecord || null, attendanceRevision: attendance?.attendanceRevisionNumber ?? null,
    policyReferences: day.context.policyReferences, contextHash: timesheetSourceHash(timesheetWorkFingerprint(timesheetContextSnapshot(day))),
    blockers: [...new Set(blockers)], financial: active,
  };
  return { ...evidence, sourceHash: timesheetSourceHash(evidence) };
}
