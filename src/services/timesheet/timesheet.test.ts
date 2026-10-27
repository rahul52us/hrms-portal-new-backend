import assert from "node:assert/strict";
import mongoose from "mongoose";
import { buildEmployeeDayContext } from "../attendance/employeeDayContext.utils";
import { DEFAULT_TIMESHEET_RULES, normalizeTimesheetRules } from "./timesheetRules.utils";
import { addDateDays, dateInZone, localInstant, validateTimesheetEntries, workRequirement } from "./timesheet.utils";

const id = () => new mongoose.Types.ObjectId();
const project = { _id: id(), name: "HRMS", code: "HRMS", status: "active", startDate: "2026-01-01", revision: 1 };
const workType = { _id: id(), name: "Development", code: "DEV", project: project._id, status: "active" };
const assignment = { _id: id() };
const rules = { ...DEFAULT_TIMESHEET_RULES };
function context(date = "2026-10-23", extra: any = {}) {
  return buildEmployeeDayContext({ attendanceDate: date, policyResolution: {
    employee: {}, organizationAssignment: {}, at: new Date(`${date}T00:00:00Z`),
    workSchedule: { assignment: {}, version: { rules: { timezone: "Asia/Kolkata", workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], saturdayRule: "all_off", startTime: "09:30", endTime: "18:30", unpaidBreakMinutes: 60, ...extra } } },
    holidayCalendar: { assignment: {}, version: { holidays: [] } },
    timesheetPolicy: { assignment: {}, version: { rules } },
  } });
}
const base = context();
const entry = (start: string, end: string, extra: any = {}) => ({ projectId: String(project._id), workTypeId: String(workType._id), startDate: base.attendanceDate, endDate: base.attendanceDate, startTime: start, endTime: end, notes: "Feature implementation", ...extra });
function validate(input: any[], extra: any = {}) {
  return validateTimesheetEntries({ input, existingEntries: [], rules, context: base, requirement: workRequirement(base, []),
    record: { punchSessions: [{ punchIn: localInstant(base.attendanceDate, "09:30", base.timezone!), punchOut: localInstant(base.attendanceDate, "18:30", base.timezone!) }] },
    now: new Date("2026-10-25T00:00:00Z"), projects: new Map([[String(project._id), project]]), workTypes: new Map([[String(workType._id), workType]]), assignments: new Map([[String(project._id), assignment]]), ...extra });
}
let count = 0;
function test(name: string, action: () => void) { action(); count++; console.log(`PASS ${name}`); }
test("strict policy validation and blank numeric rejection", () => {
  assert.deepEqual(normalizeTimesheetRules(), rules);
  for (const bad of [{ required: "true" }, { minimumEntryMinutes: 16 }, { minuteIncrement: 0 }, { maxBackdateDays: "31" }, { maxBackdateDays: 0 }, { minimumNotesLength: 0 }, { notesRequired: false }, { maximumDailyEntries: 101 }, { allowExtraHours: true }, { bogus: true }]) assert.throws(() => normalizeTimesheetRules(bad));
});
test("net target excludes lunch once", () => {
  assert.equal(workRequirement(base, []).requiredMinutes, 480);
  assert.equal(validate([entry("09:30", "13:00"), entry("14:00", "18:30")]).loggedMinutes, 480);
});
test("full-day approved paid or unpaid leave removes work obligation", () => {
  for (const paid of [true, false]) {
    const requirement = workRequirement(base, [{ unit: "days", paid, dayBreakdown: [{ attendanceDate: base.attendanceDate, portion: "full", requestedUnits: 1 }] }]);
    assert.equal(requirement.requiredMinutes, 0);
    assert.throws(() => validate([entry("09:30", "10:00")], { requirement }), /approved leave/);
  }
});
test("half-day leave and hourly leave reduce only working minutes", () => {
  const requirement = workRequirement(base, [{ unit: "days", dayBreakdown: [{ attendanceDate: base.attendanceDate, portion: "first_half", requestedUnits: 0.5 }] }]);
  assert.equal(requirement.requiredMinutes, 240);
  assert.equal(validate([entry("14:00", "18:00")], { requirement }).loggedMinutes, 240);
  assert.throws(() => validate([entry("09:30", "10:00")], { requirement }), /approved leave/);
  assert.equal(workRequirement(base, [{ unit: "hours", dayBreakdown: [{ attendanceDate: base.attendanceDate, portion: "full", requestedUnits: 2 }] }]).requiredMinutes, 360);
});
test("weekly off is optional but accepts eligible punched work", () => {
  const off = context("2026-10-25");
  assert.equal(workRequirement(off, []).requiredMinutes, 0);
  assert.equal(validate([entry("09:30", "10:30", { startDate: off.attendanceDate, endDate: off.attendanceDate })], { context: off, requirement: workRequirement(off, []), now: new Date("2026-10-26T00:00:00Z"), record: { punchSessions: [{ punchIn: localInstant(off.attendanceDate, "09:30", off.timezone!), punchOut: localInstant(off.attendanceDate, "10:30", off.timezone!) }] } }).loggedMinutes, 60);
});
test("mandatory holiday and half-day holiday targets", () => {
  const resolution: any = { employee: {}, organizationAssignment: {}, at: new Date(), workSchedule: base.policies.workSchedule, timesheetPolicy: base.policies.timesheetPolicy, holidayCalendar: { assignment: {}, version: { holidays: [{ date: base.attendanceDate, name: "Holiday", type: "mandatory" }] } } };
  assert.equal(workRequirement(buildEmployeeDayContext({ attendanceDate: base.attendanceDate, policyResolution: resolution }), []).requiredMinutes, 0);
  resolution.holidayCalendar.version.holidays[0].isHalfDay = true;
  assert.equal(workRequirement(buildEmployeeDayContext({ attendanceDate: base.attendanceDate, policyResolution: resolution }), []).requiredMinutes, 240);
});
test("permanent WFH has the same work obligation", () => assert.equal(workRequirement(context(base.attendanceDate, { defaultWorkMode: "remote" }), []).requiredMinutes, 480));
test("overlap rejected and adjacency permitted", () => {
  assert.throws(() => validate([entry("09:30", "11:00"), entry("10:30", "11:30")]), /overlap/);
  assert.equal(validate([entry("09:30", "11:00"), entry("11:00", "11:30")]).loggedMinutes, 120);
});
test("zero, negative, increment, note, invalid type and assignment checks", () => {
  for (const bad of [entry("10:00", "10:00"), entry("11:00", "10:00"), entry("10:00", "10:16"), entry("10:00", "10:30", { notes: "x" }), entry("10:00", "10:30", { workTypeId: String(id()) }), entry("10:00", "10:30", { projectId: String(id()) })]) assert.throws(() => validate([bad]));
});
test("split punches cannot be bridged through a break", () => {
  const record = { punchSessions: [{ punchIn: localInstant(base.attendanceDate, "09:30", base.timezone!), punchOut: localInstant(base.attendanceDate, "13:00", base.timezone!) }, { punchIn: localInstant(base.attendanceDate, "14:00", base.timezone!), punchOut: localInstant(base.attendanceDate, "18:30", base.timezone!) }] };
  assert.throws(() => validate([entry("12:30", "14:30")], { record }), /punched work interval/);
  assert.equal(validate([entry("09:30", "13:00"), entry("14:00", "18:30")], { record }).loggedMinutes, 480);
});
test("open attendance permits only work already done", () => {
  const now = localInstant(base.attendanceDate, "12:00", base.timezone!);
  const record = { punchSessions: [{ punchIn: localInstant(base.attendanceDate, "09:30", base.timezone!) }] };
  assert.equal(validate([entry("09:30", "11:30")], { record, now }).loggedMinutes, 120);
  assert.throws(() => validate([entry("09:30", "12:30")], { record, now }), /Future work/);
});
test("partial attendance does not shrink the required full-day target", () => {
  assert.equal(workRequirement(base, []).requiredMinutes, 480);
  const record = { punchSessions: [{ punchIn: localInstant(base.attendanceDate, "14:00", base.timezone!), punchOut: localInstant(base.attendanceDate, "18:00", base.timezone!) }] };
  assert.equal(validate([entry("14:00", "18:00")], { record }).loggedMinutes, 240);
});
test("daily target and explicitly permitted extra-hours caps", () => {
  assert.throws(() => validate([entry("09:30", "18:30")]), /exceeds/);
  assert.equal(validate([entry("09:30", "18:30")], { rules: { ...rules, allowExtraHours: true, maximumExtraMinutes: 60 } }).loggedMinutes, 540);
});
test("stable IDs may only refer to this day's existing entries", () => {
  const saved = validate([entry("09:30", "10:30")]);
  const changed = entry("09:30", "11:00", { entryId: saved.entries[0].entryId });
  assert.throws(() => validate([changed]), /does not belong/);
  assert.equal(validate([changed], { existingEntries: saved.entries }).entries[0].entryId, saved.entries[0].entryId);
  assert.throws(() => validate([changed, changed], { existingEntries: saved.entries }), /Duplicate entry/);
});
test("overnight entries belong to shift start date", () => {
  const night = context(base.attendanceDate, { startTime: "19:00", endTime: "03:00", unpaidBreakMinutes: 0 });
  const record = { punchSessions: [{ punchIn: localInstant(base.attendanceDate, "19:00", night.timezone!), punchOut: localInstant("2026-10-24", "03:00", night.timezone!) }] };
  assert.equal(validate([entry("19:00", "00:00", { endDate: "2026-10-24" }), entry("00:00", "03:00", { startDate: "2026-10-24", endDate: "2026-10-24" })], { context: night, requirement: workRequirement(night, []), record }).loggedMinutes, 480);
});
test("invalid dates, non-existent DST time, timezone and leap boundaries", () => {
  assert.throws(() => localInstant("2026-02-30", "12:00", "Asia/Kolkata"));
  assert.throws(() => localInstant("2026-03-08", "02:30", "America/New_York"));
  assert.equal(dateInZone(new Date("2026-10-23T20:00:00Z"), "Asia/Kolkata"), "2026-10-24");
  assert.equal(addDateDays("2028-02-28", 1), "2028-02-29");
});
console.log(`${count} timesheet core tests passed`);
