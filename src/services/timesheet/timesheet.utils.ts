import { randomUUID } from "crypto";
import { generateError } from "../../config/Error/functions";
import { TimesheetRules } from "../../schemas/WorkforcePolicy/TimesheetPolicyVersion.schema";
import { localAttendanceTimeToUtc } from "../attendance/attendanceRegularization.service";
import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";
import { objectId } from "../project/project.utils";

export function addDateDays(value: string, days: number) {
  const { date } = parseAttendanceDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function dateInZone(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function localInstant(date: string, time: string, timezone: string) {
  parseAttendanceDate(date);
  return localAttendanceTimeToUtc(date, time, timezone);
}
export function workRequirement(context: any, leaves: any[]) {
  const fullMinutes = context.schedule.grossMinutes == null ? null : context.schedule.grossMinutes - context.schedule.unpaidBreakMinutes;
  const expected = context.expectedWorkMinutes;
  let leaveMinutes = 0;
  let fullLeave = false;
  const leavePortions = new Set<string>();
  for (const request of leaves) {
    for (const day of request.dayBreakdown.filter((d: any) => d.attendanceDate === context.attendanceDate)) {
      if (Number(day.requestedUnits) <= 0) continue;
      if (request.unit === "hours") leaveMinutes += Number(day.requestedUnits) * 60;
      else {
        const fraction = day.portion === "full" ? 1 : 0.5;
        leaveMinutes += (fullMinutes || 0) * fraction;
        leavePortions.add(day.portion);
        if (day.portion === "full") fullLeave = true;
      }
    }
  }
  const exemptLeaveMinutes = expected == null ? 0 : Math.min(expected, Math.ceil(leaveMinutes));
  const remainingMinutes = expected == null ? null : Math.max(0, expected - exemptLeaveMinutes);
  const policyRequired = context.policies.timesheetPolicy?.version?.rules?.required === true;
  return { fullMinutes, expectedMinutes: expected, exemptLeaveMinutes,
    requiredMinutes: policyRequired ? remainingMinutes : 0, workingMinutes: remainingMinutes,
    fullLeave, leavePortions: [...leavePortions] };
}

export function validateTimesheetEntries(options: {
  input: any; existingEntries: any[]; rules: TimesheetRules; context: any;
  requirement: ReturnType<typeof workRequirement>; record: any; now: Date;
  projects: Map<string, any>; workTypes: Map<string, any>; assignments: Map<string, any>;
}) {
  const { input, rules, context, requirement, record, now } = options;
  if (!Array.isArray(input) || input.length > rules.maximumDailyEntries) throw generateError(`Entries must be a list of at most ${rules.maximumDailyEntries}`, 422);
  if (input.length && !record?.punchSessions?.some((session: any) => session.punchIn)) throw generateError("Punch in or request attendance regularization before logging work", 422);
  const knownIds = new Set(options.existingEntries.map((e) => e.entryId));
  const usedIds = new Set<string>();
  const day = context.attendanceDate;
  const nextDay = addDateDays(day, 1);
  const overnight = context.schedule.endTime <= context.schedule.startTime;
  const dayEnd = localInstant(addDateDays(day, overnight ? 2 : 1), "00:00", context.timezone);
  const scheduleStart = localInstant(day, context.schedule.startTime, context.timezone);
  const scheduleEnd = localInstant(overnight ? nextDay : day, context.schedule.endTime, context.timezone);
  const midpoint = (scheduleStart.getTime() + scheduleEnd.getTime()) / 2;
  const result = input.map((entry: any) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw generateError("Each entry must be an object", 400);
    const entryId = entry.entryId === undefined ? randomUUID() : entry.entryId;
    if (typeof entryId !== "string" || !knownIds.has(entryId) && entry.entryId !== undefined) throw generateError("Entry ID does not belong to this timesheet", 422);
    if (usedIds.has(entryId)) throw generateError("Duplicate entry ID", 422);
    usedIds.add(entryId);
    const projectId = String(objectId(entry.projectId, "project id"));
    const workTypeId = String(objectId(entry.workTypeId, "work type id"));
    const project = options.projects.get(projectId);
    const workType = options.workTypes.get(workTypeId);
    const assignment = options.assignments.get(projectId);
    if (!project || !assignment || project.startDate > day || project.endDate && project.endDate < day) throw generateError("Project is not assigned or available on this work date", 422);
    if (!workType || String(workType.project) !== projectId) throw generateError("Select an available work type belonging to the project", 422);
    if (project.status === "archived" || workType.status === "archived") throw generateError("Project or work type was archived on this work date", 422);
    if (typeof entry.notes !== "string" && entry.notes !== undefined) throw generateError("Notes must be text", 422);
    const notes = String(entry.notes || "").trim();
    if (notes.length > 2000 || rules.notesRequired && notes.length < rules.minimumNotesLength) throw generateError(`Notes must contain ${rules.notesRequired ? rules.minimumNotesLength : 0} to 2000 characters`, 422);
    const startedAt = localInstant(entry.startDate, entry.startTime, context.timezone);
    const endedAt = localInstant(entry.endDate, entry.endTime, context.timezone);
    const start = startedAt.getTime(), end = endedAt.getTime();
    if (entry.startDate < day || entry.endDate > (overnight ? nextDay : day) || start >= dayEnd.getTime() || end > dayEnd.getTime() || end <= start) throw generateError("Entry must have a positive duration within this attendance day", 422);
    if (end > now.getTime()) throw generateError("Future work cannot be logged", 422);
    const minutes = (end - start) / 60000;
    if (!Number.isSafeInteger(minutes) || minutes < rules.minimumEntryMinutes) throw generateError(`Entry duration must be a whole number of minutes, at least ${rules.minimumEntryMinutes} minute(s)`, 422);
    if (requirement.fullLeave || requirement.leavePortions.includes("first_half") && start < midpoint || requirement.leavePortions.includes("second_half") && end > midpoint) throw generateError("Entry overlaps approved leave", 422);
    return { entryId, project: project._id, workType: workType._id, assignment: assignment._id,
      projectNameSnapshot: project.name, projectCodeSnapshot: project.code, projectRevisionSnapshot: project.revision,
      workTypeNameSnapshot: workType.name, workTypeCodeSnapshot: workType.code,
      startDate: entry.startDate, startTime: entry.startTime, endDate: entry.endDate, endTime: entry.endTime,
      startedAt, endedAt, minutes, notes };
  }).sort((a: any, b: any) => a.startedAt.getTime() - b.startedAt.getTime());
  for (let i = 1; i < result.length; i++) {
    if (result[i].startedAt < result[i - 1].endedAt) throw generateError("Work entries overlap; the same time cannot be logged to multiple projects", 422);
  }
  const total = result.reduce((sum: number, entry: any) => sum + entry.minutes, 0);
  // The scheduled target already excludes unpaid breaks. Do not subtract lunch again from split entries or partial attendance.
  const baseLimit = requirement.workingMinutes === 0 && !requirement.fullLeave ? requirement.fullMinutes || 0 : requirement.workingMinutes || 0;
  const limit = baseLimit + (rules.allowExtraHours ? rules.maximumExtraMinutes : 0);
  if (total > limit) throw generateError(`Logged time exceeds the allowed ${Math.floor(limit)} minutes for this day`, 422);
  return { entries: result, loggedMinutes: total };
}
