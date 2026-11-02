import mongoose from "mongoose";
import { randomUUID } from "crypto";
import AttendanceInput from "../../schemas/Attendance/AttendancePayrollInput.schema";
import Summary from "../../schemas/Attendance/AttendanceMonthlySummary.schema";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import Timesheet from "../../schemas/Timesheet/Timesheet.schema";
import Control from "../../schemas/Timesheet/TimesheetDayControl.schema";
import Revision from "../../schemas/Timesheet/TimesheetRevision.schema";
import Submission from "../../schemas/Timesheet/TimesheetSubmission.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import PolicyVersion from "../../schemas/WorkforcePolicy/TimesheetPolicyVersion.schema";
import Assignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import { TimesheetPayrollInput as Input, TimesheetPayrollEmployeeInput as EmployeeInput } from "../../schemas/Timesheet/TimesheetPayroll.schema";
import { ensurePayrollRunManager, getPayrollActorId, resolvePayrollCompany, writePayrollAudit } from "../payroll/payroll.utils";
import { generateError } from "../../config/Error/functions";
import { parseAttendancePeriodKey } from "../attendance/attendancePeriod.service";
import { objectId, shortText } from "../project/project.utils";
import { timesheetPagination } from "./timesheetRules.utils";
import { addDateDays } from "./timesheet.utils";
import { buildOperationsDays } from "./timesheetOperationsBatch.service";
import { calculateTimesheetPayrollDay, roundTimesheetDays, timesheetSourceHash } from "./timesheetPayroll.utils";
import { timesheetBackgroundTask } from "./timesheetWriteGuard";

const id = (value: any) => String(value?._id || value || "");
export async function timesheetPayrollContext(req: any, write = false) {
  ensurePayrollRunManager(req);
  const { companyObjectId, company } = await resolvePayrollCompany(req, req.body?.companyId || req.query?.companyId, write, "manage Timesheet payroll inputs");
  return { company: companyObjectId, companyConfig: company, actor: getPayrollActorId(req) };
}
export async function buildTimesheetPayrollEmployees(source: any, summaries: any[], now = new Date(), session?: mongoose.ClientSession) {
  const query = User.find({ company: source.company, _id: { $in: summaries.map((s) => s.employee) } }).select("_id company name code joiningDate employmentEndDate createdAt deletedAt department team officeLocation reportingManager");
  if (session) query.session(session);
  const employees = await query.lean(), dates: string[] = [];
  for (let date = source.cycleStartDate; date <= source.cycleEndDate; date = addDateDays(date, 1)) dates.push(date);
  if (dates.length > 62) throw generateError("A Timesheet payroll cycle cannot exceed 62 days", 422);
  const rows = await buildOperationsDays(source.company, employees, dates, undefined, now, true, session);
  return summaries.map((summary) => {
    if (!employees.some((e: any) => id(e) === id(summary.employee))) throw generateError(`Historical employee ${summary.employeeCodeSnapshot} is missing`, 409);
    const daily = summary.daily.map((attendance: any) => {
      const row = rows.find((r) => id(r.employee) === id(summary.employee) && r.attendanceDate === attendance.attendanceDate);
      if (!row) throw generateError(`Employee history is outside employment for ${summary.employeeCodeSnapshot} on ${attendance.attendanceDate}`, 409);
      return { ...calculateTimesheetPayrollDay(row._day, row._sheet, attendance, now), _row: row };
    });
    return { employee: summary.employee, employeeNameSnapshot: summary.employeeNameSnapshot, employeeCodeSnapshot: summary.employeeCodeSnapshot, daily,
      additionalLopDays: roundTimesheetDays(daily.reduce((sum: number, d: any) => sum + d.additionalLopDays, 0)), blockers: daily.flatMap((d: any) => d.blockers.map((message: string) => `${d.attendanceDate}: ${message}`)) };
  });
}
function cleanEmployee(employee: any) {
  const { blockers, ...rest } = employee;
  return { ...rest, daily: rest.daily.map(({ _row, ...day }: any) => day) };
}
async function sourceFor(company: any, period: string, session?: mongoose.ClientSession) {
  const query = AttendanceInput.findOne({ company, periodKey: parseAttendancePeriodKey(period).periodKey, status: "locked" });
  if (session) query.session(session);
  const source: any = await query.lean();
  if (!source) throw generateError("Lock the matching attendance cycle before preparing Timesheet payroll inputs", 409);
  return source;
}
export const getTimesheetPayrollCycles = async (req: any, res: any, next: any) => {
  try {
    const ctx = await timesheetPayrollContext(req), { page, limit, skip } = timesheetPagination(req.query, 50);
    const [sources, total] = await Promise.all([AttendanceInput.find({ company: ctx.company }).select("periodKey cycleStartDate cycleEndDate version summaryCount lockedAt").sort({ periodKey: -1 }).skip(skip).limit(limit).lean(), AttendanceInput.countDocuments({ company: ctx.company })]);
    const inputs = await Input.find({ company: ctx.company, attendancePayrollInput: { $in: sources.map((s) => s._id) }, active: true }).select("-lease").lean();
    res.json({ success: true, data: sources.map((source) => ({ ...source, timesheetInput: inputs.find((i) => id(i.attendancePayrollInput) === id(source)) || null })), pagination: { page, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const getTimesheetPayrollPreview = async (req: any, res: any, next: any) => {
  try {
    const ctx = await timesheetPayrollContext(req), source = await sourceFor(ctx.company, req.params.period), { page, limit, skip } = timesheetPagination(req.query, 25);
    const input: any = await Input.findOne({ company: ctx.company, attendancePayrollInput: source._id, active: true }).select("-lease").lean();
    if (input?.consumedBy) {
      const consumer: any = await PayrollRun.findOne({ _id: input.consumedBy, company: ctx.company }).select("status").lean();
      input.consumedPayrollStatus = consumer?.status || null;
    }
    if (input?.status === "locked") {
      const data = await EmployeeInput.find({ company: ctx.company, input: input._id }).sort({ employee: 1 }).skip(skip).limit(limit).lean();
      return res.json({ success: true, input, source, data, pagination: { page, total: input.employeeCount, totalPages: Math.max(1, Math.ceil(input.employeeCount / limit)) }, summaryScope: "cycle" });
    }
    const match = { company: ctx.company, attendancePeriod: source.attendancePeriod, attendancePeriodVersion: source.attendancePeriodVersion };
    const [summaries, total] = await Promise.all([Summary.find(match).sort({ employee: 1 }).skip(skip).limit(limit).lean(), Summary.countDocuments(match)]);
    const built = await buildTimesheetPayrollEmployees(source, summaries);
    res.json({ success: true, input, source, data: built.map((employee) => ({ ...cleanEmployee(employee), blockers: employee.blockers })), pagination: { page, total, totalPages: Math.max(1, Math.ceil(total / limit)) }, summaryScope: "page" });
  } catch (error) { next(error); }
};

export async function executeTimesheetPayrollLock(inputId: any, batches = 10) {
  const token = randomUUID(), now = new Date();
  const input: any = await Input.findOneAndUpdate({ _id: inputId, active: true, $or: [{ status: "locking", leaseUntil: null }, { status: "locking", leaseUntil: { $lt: now } }, { status: "failed", failures: { $lt: 5 }, nextAttemptAt: { $lte: now } }] }, { $set: { status: "locking", lease: token, leaseUntil: new Date(now.getTime() + 600000), error: "" } }, { new: true }).lean();
  if (!input) return;
  try {
    if (!await Company.exists({ _id: input.company, is_active: true, deletedAt: null })) throw generateError("Company is inactive; restore access before resuming Timesheet payroll locking", 409);
    for (let batch = 0; batch < batches; batch++) {
      let complete = false;
      await mongoose.connection.transaction(async (session) => {
        const current: any = await Input.findOne({ _id: inputId, company: input.company, lease: token, status: "locking" }).session(session).lean();
        if (!current) throw generateError("Timesheet locking was interrupted", 409);
        const source = await sourceFor(input.company, input.periodKey, session);
        const summaries: any[] = await Summary.find({ company: input.company, attendancePeriod: source.attendancePeriod, attendancePeriodVersion: source.attendancePeriodVersion, ...(current.cursor ? { employee: { $gt: current.cursor } } : {}) }).sort({ employee: 1 }).limit(10).session(session).lean();
        if (!summaries.length) {
          if (current.employeeCount !== source.summaryCount) throw generateError("Timesheet employee count does not reconcile with locked attendance", 409);
          await Input.updateOne({ _id: inputId, lease: token }, { $set: { status: "locked", lockedAt: new Date(), lease: null, leaseUntil: null }, $inc: { revision: 1 } }, { session });
          await writePayrollAudit({ company: input.company, actor: input.actor, entityType: "timesheet_payroll", entityId: inputId, action: "timesheet_input_locked", reason: input.reason, details: { periodKey: input.periodKey, employeeCount: current.employeeCount, additionalLopDays: current.additionalLopDays } }, session);
          complete = true; return;
        }
        const built = await buildTimesheetPayrollEmployees(source, summaries, new Date(), session);
        for (const employee of built) {
          if (employee.blockers.length) throw generateError(`${employee.employeeCodeSnapshot}: ${employee.blockers.slice(0, 3).join("; ")}`, 409);
          const lockedAt = new Date(), financial = employee.daily.filter((d: any) => d.financial), controls: any[] = [], sheets: any[] = [], revisions: any[] = [], submissions: any[] = [];
          for (const evidence of financial) {
            const match = { company: input.company, employee: employee.employee, attendanceDate: evidence.attendanceDate };
            controls.push({ updateOne: { filter: { ...match, revision: evidence.controlRevision, payrollLockedAt: null }, update: { $set: { payrollLockedAt: lockedAt, payrollInput: inputId }, $inc: { writeVersion: 1 } }, upsert: true } });
            const sheet = evidence._row._sheet;
            if (sheet) {
              const snapshot = { ...sheet, revision: sheet.revision + 1, payrollLockedAt: lockedAt, payrollInput: inputId, updatedBy: input.actor };
              sheets.push({ updateOne: { filter: { _id: sheet._id, company: input.company, revision: sheet.revision, payrollLockedAt: null }, update: { $set: { payrollLockedAt: lockedAt, payrollInput: inputId, updatedBy: input.actor }, $inc: { revision: 1 } } } });
              revisions.push({ ...match, timesheet: sheet._id, revision: snapshot.revision, requestId: `payroll-lock-${inputId}`, requestHash: evidence.sourceHash, actor: input.actor, action: "payroll_lock", actionEvidence: { input: inputId, reason: input.reason }, snapshot });
              evidence.sheetRevision = snapshot.revision;
              const { _row, sourceHash, ...updatedEvidence } = evidence;
              evidence.sourceHash = timesheetSourceHash(updatedEvidence);
              if (sheet.currentSubmission) submissions.push({ updateOne: { filter: { _id: sheet.currentSubmission, company: input.company }, update: { $set: { sheetRevision: snapshot.revision } } } });
            }
          }
          if (controls.length) { const result = await Control.bulkWrite(controls, { session }); if (result.matchedCount + result.upsertedCount !== controls.length) throw generateError("Timesheet controls changed during locking", 409); }
          if (sheets.length) { const result = await Timesheet.bulkWrite(sheets, { session }); if (result.matchedCount !== sheets.length) throw generateError("Timesheet changed during locking", 409); await Revision.insertMany(revisions, { session }); }
          if (submissions.length) await Submission.bulkWrite(submissions, { session });
          const cleaned = cleanEmployee(employee);
          await EmployeeInput.create([{ company: input.company, input: inputId, ...cleaned, sourceHash: timesheetSourceHash(cleaned) }], { session });
        }
        await Input.updateOne({ _id: inputId, lease: token, revision: current.revision }, { $set: { cursor: summaries[summaries.length - 1].employee, leaseUntil: new Date(Date.now() + 600000) }, $inc: { revision: 1, employeeCount: built.length, additionalLopDays: roundTimesheetDays(built.reduce((sum, row) => sum + row.additionalLopDays, 0)) } }, { session });
      });
      if (complete) return;
    }
    await Input.updateOne({ _id: inputId, lease: token }, { $set: { lease: null, leaseUntil: null } });
  } catch (error: any) {
    await Input.updateOne({ _id: inputId, lease: token }, { $set: { status: "failed", lease: null, leaseUntil: null, error: String(error.message).slice(0, 1000), nextAttemptAt: new Date(Date.now() + 60000) }, $inc: { failures: 1, revision: 1 } });
    console.error("Timesheet payroll locking failed", id(inputId), error.message);
  }
}
export async function drainTimesheetPayrollLock(inputId: any, budgetMs = 20000, continueInBackground = true) {
  const until = Date.now() + budgetMs;
  let pending = false;
  do {
    await executeTimesheetPayrollLock(inputId, 10);
    pending = Boolean(await Input.exists({ _id: inputId, active: true, status: "locking", lease: null }));
    if (!pending) return;
  } while (Date.now() < until);
  if (continueInBackground) timesheetBackgroundTask(() => drainTimesheetPayrollLock(inputId));
}
export const lockTimesheetPayroll = async (req: any, res: any, next: any) => {
  try {
    const ctx = await timesheetPayrollContext(req, true), source = await sourceFor(ctx.company, req.params.period);
    const requestId = shortText(req.body.requestId, "Request id", 8, 100), reason = shortText(req.body.reason, "Lock reason", 3, 500);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 422);
    const requestHash = timesheetSourceHash({ period: source.periodKey, requestId, reason, actor: id(ctx.actor) });
    let input: any = await Input.findOne({ company: ctx.company, requestId }).lean();
    if (input && input.requestHash !== requestHash) throw generateError("Request id was already used for a different intent", 409);
    if (!input) {
      const active = await Input.exists({ company: ctx.company, periodKey: source.periodKey, active: true });
      if (active) throw generateError("This cycle already has a Timesheet input; review or resume it", 409);
      const previous: any = await Input.findOne({ company: ctx.company, periodKey: source.periodKey }).sort({ version: -1 }).lean();
      input = await Input.create({ company: ctx.company, attendancePayrollInput: source._id, periodKey: source.periodKey, startDate: source.cycleStartDate, endDate: source.cycleEndDate, version: (previous?.version || 0) + 1, actor: ctx.actor, reason, requestId, requestHash });
    }
    timesheetBackgroundTask(() => drainTimesheetPayrollLock(input._id));
    res.status(202).json({ success: true, data: input });
  } catch (error: any) { next(error.code === 11000 ? generateError("Another Timesheet lock request won the race. Reload this cycle.", 409) : error); }
};
export const changeTimesheetPayrollLock = async (req: any, res: any, next: any) => {
  try {
    const ctx = await timesheetPayrollContext(req, true), inputId = objectId(req.params.inputId, "Timesheet input id");
    const input: any = await Input.findOne({ _id: inputId, company: ctx.company }).lean();
    if (!input) throw generateError("Timesheet payroll input not found", 404);
    if (input.revision !== req.body.revision || !input.active) throw generateError("Input changed. Reload before changing its state.", 409);
    const action = req.body.action;
    if (action === "resume") {
      if (input.consumedBy) throw generateError("This input is already consumed by payroll", 409);
      if (input.status !== "failed") throw generateError("Only a failed lock can be resumed", 409);
      await Input.updateOne({ _id: inputId, revision: input.revision }, { $set: { status: "locking", failures: 0, error: "", nextAttemptAt: null }, $inc: { revision: 1 } });
      timesheetBackgroundTask(() => drainTimesheetPayrollLock(inputId));
    } else if (action === "cancel") {
      const reason = shortText(req.body.reason, "Cancellation reason", 3, 500);
      await mongoose.connection.transaction(async (session) => {
        if (input.consumedBy) {
          const run: any = await PayrollRun.findOne({ _id: input.consumedBy, company: ctx.company, status: "draft" }).session(session).lean();
          if (!run) throw generateError("Return payroll to Draft before rebuilding a handoff; finalized payroll needs a historical correction", 409);
          const updated = await PayrollRun.updateOne({ _id: run._id, version: run.version, status: "draft" }, { $set: { timesheetPayrollInput: null, timesheetAdditionalLopDays: 0, calculationStatus: run.calculationVersion ? "stale" : "pending" }, $inc: { version: 1 } }, { session });
          if (!updated.modifiedCount) throw generateError("Payroll changed during cancellation", 409);
        }
        const claimed = await Input.updateOne({ _id: inputId, revision: input.revision }, { $set: { status: "cancelling", consumedBy: null, lease: null, leaseUntil: null, cancellationReason: reason, cancelledBy: ctx.actor }, $inc: { revision: 1 } }, { session });
        if (!claimed.modifiedCount) throw generateError("Input changed. Reload before cancelling.", 409);
        await writePayrollAudit({ company: ctx.company, actor: ctx.actor, entityType: "timesheet_payroll", entityId: inputId, action: "timesheet_input_cancelled", reason, details: { consumedBy: input.consumedBy } }, session);
      });
      await finishTimesheetPayrollCancellation(inputId);
    } else throw generateError("Choose resume or cancel", 422);
    res.json({ success: true, data: await Input.findById(inputId).select("-lease").lean() });
  } catch (error) { next(error); }
};

export async function finishTimesheetPayrollCancellation(inputId: any) {
  const input: any = await Input.findOne({ _id: inputId, status: "cancelling", active: true }).lean();
  if (!input) return;
  await Control.updateMany({ company: input.company, payrollInput: inputId }, { $set: { payrollLockedAt: null, payrollInput: null }, $inc: { writeVersion: 1 } });
  await Timesheet.updateMany({ company: input.company, payrollInput: inputId }, { $set: { payrollLockedAt: null, payrollInput: null } });
  await Input.updateOne({ _id: inputId, status: "cancelling" }, { $set: { status: "cancelled", active: false, cancelledAt: new Date() } });
}

export async function claimTimesheetPayrollHandoff(run: any, actor: any, session: mongoose.ClientSession) {
  const input: any = await Input.findOne({ company: run.company, attendancePayrollInput: run.attendancePayrollInput, active: true }).session(session).lean();
  if (input) {
    if (input.status !== "locked") throw generateError("Complete Timesheet payroll locking before importing payroll inputs", 409);
    const claimed = await Input.updateOne({ _id: input._id, status: "locked", $or: [{ consumedBy: null }, { consumedBy: run._id }] }, { $set: { consumedBy: run._id } }, { session });
    if (!claimed.matchedCount) throw generateError("Timesheet handoff is already consumed by another payroll run", 409);
    const employees = await EmployeeInput.find({ company: run.company, input: input._id }).session(session).lean();
    if (employees.length !== input.employeeCount) throw generateError("Timesheet employee evidence is incomplete. Rebuild the handoff before calculating payroll.", 409);
    return { input, employees };
  }
  const policies: any[] = await PolicyVersion.find({ company: run.company, status: "published", effectiveFrom: { $lte: new Date(`${run.cycleEndDate}T00:00:00Z`) }, "rules.payrollMode": { $in: ["block", "shortfall"] } }).select("policy").session(session).lean();
  if (policies.length && await Assignment.exists({ company: run.company, resourceType: "timesheet_policy", resource: { $in: policies.map((p) => p.policy) }, effectiveFrom: { $lte: new Date(`${run.cycleEndDate}T00:00:00Z`) }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date(`${run.cycleStartDate}T00:00:00Z`) } }] }).session(session)) throw generateError("Lock the matching Timesheet payroll cycle before importing payroll inputs", 409);
  return null;
}
