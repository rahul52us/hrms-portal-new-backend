import { createHash, randomUUID } from "crypto";
import mongoose from "mongoose";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import Timesheet from "../../schemas/Timesheet/Timesheet.schema";
import Submission from "../../schemas/Timesheet/TimesheetSubmission.schema";
import Attendance from "../../schemas/Attendance/AttendanceRecord.schema";
import Leave from "../../schemas/Leave/LeaveRequest.schema";
import Assignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import ScheduleVersion from "../../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
import CalendarVersion from "../../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
import PolicyVersion from "../../schemas/WorkforcePolicy/TimesheetPolicyVersion.schema";
import Notification from "../../schemas/Notification/notification.schema";
import { TimesheetAutomationJob as Job, TimesheetAutomationState as State, TimesheetContextEvent as Event } from "../../schemas/Timesheet/TimesheetAutomation.schema";
import { buildRequestNotificationDocuments, RequestNotificationOptions } from "../notification/notification.utils";
import { generateError } from "../../config/Error/functions";
import { ownContext } from "./timesheet.service";
import { addDateDays, dateInZone } from "./timesheet.utils";
import { dateKey, objectId } from "../project/project.utils";
import { buildOperationsDays } from "./timesheetOperationsBatch.service";
import { resolveTimesheetDay, timesheetContextSnapshot, timesheetWorkFingerprint } from "./timesheetContext.service";
import { timesheetPagination } from "./timesheetRules.utils";
import { loadTimesheetScopedEmployee, timesheetOperationsContext } from "./timesheetOperationsAccess.service";
import { timesheetBackgroundTask } from "./timesheetWriteGuard";

const id = (value: any) => String(value?._id || value || "");
const digest = (value: any) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function upsertTimesheetNotifications(options: RequestNotificationOptions, session?: mongoose.ClientSession) {
  const documents = buildRequestNotificationDocuments(options);
  if (!documents.length) return 0;
  const result = await Notification.bulkWrite(documents.map((document) => ({ updateOne: { filter: { dedupeKey: document.dedupeKey }, update: { $setOnInsert: document }, upsert: true } })), { session, ordered: false });
  return result.upsertedCount;
}
export function timesheetAutomationAdmin(req: any) {
  const context = ownContext(req);
  if (!["admin", "hradmin"].includes(context.actor.role)) throw generateError("Company-wide Timesheet jobs require Company Admin or HR Admin", 403);
  return context;
}
export async function queueTimesheetAutomation(company: any, key: string, requestedBy: any = null, referenceAt = new Date()) {
  const existing = await Job.findOne({ company, active: true }).lean();
  if (existing) return existing;
  const previous: any = await State.findOne({ company }).lean();
  const today = referenceAt.toISOString().slice(0, 10);
  try { return await Job.create({ company, key, requestedBy, referenceAt, from: addDateDays(today, -40), to: addDateDays(today, 1), changedSince: previous?.reconciledThrough || new Date(0) }); }
  catch (error: any) { if (error.code !== 11000) throw error; return Job.findOne({ company, $or: [{ active: true }, { key }] }).lean(); }
}
async function reconcile(sheet: any, reference: Date, resolvedDay?: any) {
  const day = resolvedDay || await resolveTimesheetDay(sheet.company, sheet.employee, sheet.attendanceDate, reference, undefined, true);
  const current = timesheetContextSnapshot(day), fingerprint = digest(timesheetWorkFingerprint(current));
  if (timesheetWorkFingerprint(current) === timesheetWorkFingerprint(sheet.contextSnapshot) && sheet.requiredMinutes === day.requirement.requiredMinutes) {
    await Event.updateMany({ company: sheet.company, timesheet: sheet._id, resolvedAt: null }, { $set: { resolvedAt: reference } });
    return 0;
  }
  const event: any = await Event.findOneAndUpdate({ company: sheet.company, timesheet: sheet._id, revision: sheet.revision, fingerprint }, { $setOnInsert: {
    employee: sheet.employee, attendanceDate: sheet.attendanceDate, savedRequiredMinutes: sheet.requiredMinutes, currentRequiredMinutes: day.requirement.requiredMinutes,
    sourceReferences: { policyReferences: current.policyReferences, attendance: current.attendance?._id, attendanceRevision: current.attendance?.revision },
    message: sheet.payrollLockedAt ? "Context changed after payroll lock. HR must review a historical correction; the locked salary source is unchanged." : "Attendance, leave or policy changed. Review this day and return/reopen submitted work for correction before approval.",
  } }, { upsert: true, new: true }).lean();
  const submission: any = sheet.currentSubmission ? await Submission.findOne({ _id: sheet.currentSubmission, company: sheet.company }).select("currentApprovers").lean() : null;
  await upsertTimesheetNotifications({ company: sheet.company, recipients: [sheet.employee], eventType: "timesheet.context_changed", entityType: "timesheet_context", entityId: event._id,
    title: "Timesheet needs review", message: `Your timesheet for ${sheet.attendanceDate} has changed attendance, leave or policy context.`, actionUrl: `/dashboard/calendar?workDate=${sheet.attendanceDate}`, dedupeEventKey: "employee" });
  await upsertTimesheetNotifications({ company: sheet.company, recipients: submission?.currentApprovers || [], eventType: "timesheet.context_changed", entityType: "timesheet_context", entityId: event._id,
    title: "Review changed Timesheet context", message: `The timesheet for ${sheet.attendanceDate} needs correction before approval.`, actionUrl: "/dashboard", dedupeEventKey: "reviewers" });
  if (sheet.payrollLockedAt) {
    const hr = await User.find({ company: sheet.company, role: { $in: ["admin", "hradmin"] }, is_enabled: true, deletedAt: null }).select("_id").limit(100).lean();
    await upsertTimesheetNotifications({ company: sheet.company, recipients: hr.map((user) => user._id), eventType: "timesheet.context_changed", entityType: "timesheet_context", entityId: event._id,
      title: "Locked Timesheet needs review", message: `Context for ${sheet.attendanceDate} changed after payroll lock. Review a historical correction.`, actionUrl: "/dashboard/timesheets", dedupeEventKey: "payroll_review" });
  }
  return 1;
}
const sources: any[] = [Attendance, Leave, Assignment, ScheduleVersion, CalendarVersion, PolicyVersion];
async function automationChunk(job: any) {
  const cursor = job.cursor || { phase: 0 }, phase = Number(cursor.phase || 0), metrics = { employees: 0, notifications: 0, reconciliations: 0 };
  if (phase === 0) {
    const employees: any[] = await User.find({ company: job.company, is_enabled: true, deletedAt: null, role: { $ne: "superadmin" }, ...(cursor.after ? { _id: { $gt: cursor.after } } : {}) }).select("_id company name code joiningDate createdAt employmentEndDate department team officeLocation reportingManager").sort({ _id: 1 }).limit(100).lean();
    if (!employees.length) return { cursor: { phase: 1 }, metrics };
    const dates: string[] = []; for (let date = job.from; date <= job.to; date = addDateDays(date, 1)) dates.push(date);
    const rows = await buildOperationsDays(job.company, employees, dates, undefined, new Date(job.referenceAt), true);
    const reminders = new Map<string, { employee: any; dates: string[]; overdue: number; timezone: string }>();
    for (const row of rows) {
      const day = row._day, sheet = row._sheet, rules = day.rules;
      if (sheet && row.stale) metrics.reconciliations += await reconcile(sheet, new Date(job.referenceAt), day);
      if (!rules || rules.remindersEnabled === false || !day.eligibility.required || day.eligibility.setupIssues.length || ["submitted", "approved"].includes(sheet?.status) || !day.eligibility.deadlineAt) continue;
      const reference = new Date(job.referenceAt), localDate = dateInZone(reference, day.context.timezone);
      if (row.attendanceDate > localDate || reference > day.eligibility.editableUntilAt) continue;
      const due = new Date(day.eligibility.deadlineAt), hours = (due.getTime() - reference.getTime()) / 3600000;
      if (hours > (rules.remindBeforeHours ?? 24)) continue;
      const every = rules.reminderEveryDays ?? 1, bucket = Math.floor(Date.parse(`${localDate}T00:00:00Z`) / 86400000 / every);
      const key = `${row.employee._id}:${day.context.timezone}:${every}:${bucket}`;
      const reminder = reminders.get(key) || { employee: row.employee._id, dates: [] as string[], overdue: 0, timezone: day.context.timezone };
      reminder.dates.push(row.attendanceDate); if (hours < 0) reminder.overdue++;
      reminders.set(key, reminder);
    }
    for (const [key, reminder] of reminders) {
      const first = reminder.dates.sort()[0], count = reminder.dates.length;
      metrics.notifications += await upsertTimesheetNotifications({ company: job.company, recipients: [reminder.employee], eventType: "timesheet.submission_reminder", entityType: "timesheet_digest", entityId: reminder.employee,
        title: "Submit your timesheets", message: `${count} timesheet day${count === 1 ? " is" : "s are"} ${reminder.overdue === count ? "overdue" : "due soon or overdue"}. Review ${first}${count > 1 ? ` and ${count - 1} more date(s)` : ""}.`, actionUrl: `/dashboard/calendar?workDate=${first}`, dedupeEventKey: `submission:${key}`, metadata: { dates: reminder.dates, timezone: reminder.timezone } });
    }
    metrics.employees = employees.length;
    return { cursor: { phase: 0, after: employees[employees.length - 1]._id }, metrics };
  }
  if (phase === sources.length + 1) {
    const pending: any[] = await Submission.find({ company: job.company, status: "submitted", ...(cursor.after ? { _id: { $gt: cursor.after } } : {}) }).select("employee attendanceDate submittedAt approvalDeadlineAt currentApprovers sheetRevision snapshot.contextSnapshot.rules snapshot.timezone").sort({ _id: 1 }).limit(100).lean();
    const managers: any[] = await User.find({ company: job.company, role: { $in: ["admin", "hradmin"] }, is_enabled: true, deletedAt: null }).select("_id").limit(100).lean();
    for (const submission of pending) {
      const rules = submission.snapshot?.contextSnapshot?.rules;
      if (rules?.remindersEnabled === false) continue;
      const due = submission.approvalDeadlineAt || new Date(new Date(submission.submittedAt).getTime() + (rules?.approverEscalationDays ?? 2) * 86400000);
      if (new Date(due) > new Date(job.referenceAt)) continue;
      const localDate = dateInZone(new Date(job.referenceAt), submission.snapshot?.timezone || "UTC");
      metrics.notifications += await upsertTimesheetNotifications({ company: job.company, recipients: submission.currentApprovers, eventType: "timesheet.approval_reminder", entityType: "timesheet_submission", entityId: submission._id,
        title: "Timesheet approval overdue", message: `A timesheet for ${submission.attendanceDate} is awaiting your decision.`, actionUrl: "/dashboard", dedupeEventKey: `approval:${submission.sheetRevision}:${localDate}` });
      metrics.notifications += await upsertTimesheetNotifications({ company: job.company, recipients: managers.map((a) => a._id), eventType: "timesheet.approval_escalation", entityType: "timesheet_submission", entityId: submission._id,
        title: "Overdue Timesheet approval", message: `Approval for ${submission.attendanceDate} needs follow-up.`, actionUrl: "/dashboard/timesheets", dedupeEventKey: `escalation:${submission.sheetRevision}:${localDate}` });
    }
    return pending.length ? { cursor: { phase, after: pending[pending.length - 1]._id }, metrics } : { cursor, metrics, complete: true };
  }
  const sourceModel = sources[phase - 1];
  const source: any = cursor.source ? await sourceModel.findOne({ company: job.company, _id: cursor.source }).lean() : await sourceModel.findOne({ company: job.company, updatedAt: { $gte: job.changedSince, $lte: job.referenceAt }, ...(cursor.after && cursor.afterAt ? { $or: [{ updatedAt: { $gt: new Date(cursor.afterAt) } }, { updatedAt: new Date(cursor.afterAt), _id: { $gt: cursor.after } }] } : {}) }).sort({ updatedAt: 1, _id: 1 }).lean();
  if (!source) return { cursor: cursor.source ? { phase, after: cursor.after, afterAt: cursor.afterAt } : { phase: phase + 1 }, metrics };
  const match: any = { company: job.company, ...(cursor.sheet ? { _id: { $gt: cursor.sheet } } : {}) };
  if (source.employee) match.employee = source.employee;
  const from = source.attendanceDate || source.fromDate || source.effectiveFrom, to = source.attendanceDate || source.toDate || source.effectiveTo;
  if (from) match.attendanceDate = { $gte: typeof from === "string" ? from.slice(0, 10) : new Date(from).toISOString().slice(0, 10), ...(to ? { $lte: typeof to === "string" ? to.slice(0, 10) : new Date(to).toISOString().slice(0, 10) } : {}) };
  const sheets: any[] = await Timesheet.find(match).sort({ _id: 1 }).limit(50).lean();
  for (const sheet of sheets) metrics.reconciliations += await reconcile(sheet, new Date(job.referenceAt));
  return { cursor: sheets.length === 50 ? { phase, source: source._id, after: cursor.after, afterAt: cursor.afterAt, sheet: sheets[sheets.length - 1]._id } : { phase, after: source._id, afterAt: source.updatedAt }, metrics };
}
export async function executeTimesheetAutomation(jobId: any, chunks = 10) {
  const token = randomUUID(), now = new Date();
  const job: any = await Job.findOneAndUpdate({ _id: jobId, active: true, $or: [{ status: "queued" }, { status: "failed", nextAttemptAt: { $lte: now }, failures: { $lt: 5 } }, { status: "running", leaseUntil: { $lt: now } }] }, { $set: { status: "running", lease: token, leaseUntil: new Date(now.getTime() + 600000), error: "" }, $inc: { attempts: 1 } }, { new: true }).lean();
  if (!job) return;
  try {
    if (!await Company.exists({ _id: job.company, is_active: true, deletedAt: null })) {
      await Job.updateOne({ _id: jobId, lease: token }, { $set: { status: "complete", active: false, completedAt: new Date(), lease: null, leaseUntil: null, error: "Company inactive; check skipped" } });
      return;
    }
    for (let step = 0; step < chunks; step++) {
      const result = await automationChunk(job), updates: any = { cursor: result.cursor, leaseUntil: new Date(Date.now() + 600000) };
      job.cursor = result.cursor;
      if (result.complete) Object.assign(updates, { status: "complete", active: false, completedAt: new Date(), lease: null, leaseUntil: null });
      const updated = await Job.updateOne({ _id: jobId, lease: token }, { $set: updates, $inc: Object.fromEntries(Object.entries(result.metrics).map(([key, value]) => [`metrics.${key}`, value])) });
      if (!updated.modifiedCount) return;
      if (result.complete) { await State.updateOne({ company: job.company }, { $max: { reconciledThrough: job.referenceAt } }, { upsert: true }); return; }
    }
    await Job.updateOne({ _id: jobId, lease: token }, { $set: { status: "queued", lease: null, leaseUntil: null } });
  } catch (error: any) {
    await Job.updateOne({ _id: jobId, lease: token }, { $set: { status: "failed", lease: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** job.failures)), error: String(error.message).slice(0, 1000) }, $inc: { failures: 1 } });
    console.error("Timesheet automation failed", id(jobId), error.message);
  }
}
export async function drainTimesheetAutomation(jobId: any, budgetMs = 20000, continueInBackground = true) {
  const until = Date.now() + budgetMs;
  do {
    await executeTimesheetAutomation(jobId, 10);
    if (!await Job.exists({ _id: jobId, active: true, status: "queued", lease: null })) return;
  } while (Date.now() < until);
  if (continueInBackground) timesheetBackgroundTask(() => drainTimesheetAutomation(jobId));
}
export const listTimesheetAutomation = async (req: any, res: any, next: any) => { try { const { company } = timesheetAutomationAdmin(req), { page, limit, skip } = timesheetPagination(req.query, 50); const [data, total] = await Promise.all([Job.find({ company }).select("-lease").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), Job.countDocuments({ company })]); res.json({ success: true, data, pagination: { page, total, totalPages: Math.max(1, Math.ceil(total / limit)) } }); } catch (error) { next(error); } };
export const runTimesheetAutomation = async (req: any, res: any, next: any) => {
  try {
    const { company, actor } = timesheetAutomationAdmin(req);
    if (req.body.retryId) {
      const job: any = await Job.findOneAndUpdate({ _id: objectId(req.body.retryId, "job id"), company, active: true, status: "failed" }, { $set: { failures: 0, nextAttemptAt: new Date() } }, { new: true });
      if (!job) throw generateError("Choose an active failed job", 409);
      timesheetBackgroundTask(() => drainTimesheetAutomation(job._id));
      return res.status(202).json({ success: true, data: job });
    }
    const job = await queueTimesheetAutomation(company, `manual:${randomUUID()}`, actor._id);
    if (!job) throw generateError("Unable to queue the Timesheet check. Retry shortly.", 409);
    timesheetBackgroundTask(() => drainTimesheetAutomation(job._id));
    res.status(202).json({ success: true, data: job });
  } catch (error) { next(error); }
};
export const listTimesheetContextEvents = (own = false) => async (req: any, res: any, next: any) => { try { const ctx = own ? ownContext(req) : await timesheetOperationsContext(req), employee = own ? (ctx as any).employee : objectId(req.params.employeeId, "employee id"), date = dateKey(req.params.date, "work date"); if (!own) await loadTimesheetScopedEmployee(ctx, employee, date!); const { page, limit, skip } = timesheetPagination(req.query, 20); const match = { company: ctx.company, employee, attendanceDate: date }; const [data, total] = await Promise.all([Event.find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), Event.countDocuments(match)]); res.json({ success: true, data, pagination: { page, totalPages: Math.max(1, Math.ceil(total / limit)) } }); } catch (error) { next(error); } };
