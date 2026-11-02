import mongoose from "mongoose";
import Timesheet from "../../schemas/Timesheet/Timesheet.schema";
import Control from "../../schemas/Timesheet/TimesheetDayControl.schema";
import Revision from "../../schemas/Timesheet/TimesheetRevision.schema";
import Submission from "../../schemas/Timesheet/TimesheetSubmission.schema";
import Summary from "../../schemas/Attendance/AttendanceMonthlySummary.schema";
import AttendanceAdjustment from "../../schemas/Attendance/AttendancePayrollAdjustment.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import PayrollResult from "../../schemas/Payroll/PayrollFinalizedResult.schema";
import PayrollEmployee from "../../schemas/Payroll/PayrollEmployeeInput.schema";
import OneTime from "../../schemas/Payroll/PayrollOneTimeInput.schema";
import Component from "../../schemas/Payroll/SalaryComponent.schema";
import Audit from "../../schemas/Timesheet/TimesheetAuditLog.schema";
import User from "../../schemas/User/User";
import { TimesheetPayrollInput as Input, TimesheetPayrollEmployeeInput as EmployeeInput, TimesheetPayrollCorrection as Correction } from "../../schemas/Timesheet/TimesheetPayroll.schema";
import { objectId, dateKey, shortText } from "../project/project.utils";
import { generateError } from "../../config/Error/functions";
import { cancelApprovalInstance } from "../approval/approvalEngine.service";
import { buildFinalizedCorrectionInputDocument, payrollAdjustmentBlocker } from "../payroll/payrollAdjustment.service";
import { oneTimeInputRunDelta } from "../payroll/payrollOneTimeInput.service";
import { prorateMinorAmount } from "../payroll/payrollCalculation.service";
import { writePayrollAudit } from "../payroll/payroll.utils";
import { writePayrollAccessLog } from "../payroll/payrollAccess.service";
import { escapeRegex } from "../workforcePolicy/workforcePolicy.utils";
import { timesheetPayrollContext } from "./timesheetPayroll.service";
import { timesheetPagination } from "./timesheetRules.utils";
import { addDateDays, dateInZone, localInstant } from "./timesheet.utils";
import { resolveTimesheetDay } from "./timesheetContext.service";
import { calculateTimesheetPayrollDay, roundTimesheetDays, timesheetSourceHash } from "./timesheetPayroll.utils";
import { controlSnapshot } from "./timesheetDayControl.utils";
import { upsertTimesheetNotifications } from "./timesheetAutomation.service";
import { ownContext } from "./timesheet.service";
import { loadTimesheetScopedEmployee, timesheetOperationsContext } from "./timesheetOperationsAccess.service";
import { buildOperationsDays } from "./timesheetOperationsBatch.service";

const id = (value: any) => String(value?._id || value || "");
async function correctionSource(company: any, inputId: any, employee: any, date: string, session?: mongoose.ClientSession) {
  const input: any = await Input.findOne({ _id: inputId, company, status: "locked" }).session(session || null).lean();
  if (!input?.consumedBy) throw generateError("Corrections require a Timesheet input consumed by finalized payroll", 409);
  const run: any = await PayrollRun.findOne({ _id: input.consumedBy, company, status: "finalized" }).session(session || null).lean();
  if (!run) throw generateError("Before payroll finalization, cancel and rebuild the Timesheet handoff instead", 409);
  const locked: any = await EmployeeInput.findOne({ company, input: inputId, employee }).session(session || null).lean();
  const original = locked?.daily.find((d: any) => d.attendanceDate === date);
  if (!original?.financial) throw generateError("This date has no financial Timesheet lock", 409);
  return { input, run, original };
}
export const openTimesheetCorrection = async (req: any, res: any, next: any) => {
  try {
    const ctx = await timesheetPayrollContext(req, true), inputId = objectId(req.params.inputId, "Timesheet input"), employee = objectId(req.body.employeeId, "employee"), date = dateKey(req.body.date, "work date")!;
    if (id(employee) === id(ctx.actor)) throw generateError("Another authorized HR/payroll user must open your correction", 403);
    const reason = shortText(req.body.reason, "Correction reason", 3, 500), requestId = shortText(req.body.requestId, "Request id", 8, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 422);
    const requestHash = timesheetSourceHash({ inputId: id(inputId), employee: id(employee), date, reason, actor: id(ctx.actor) });
    let result: any;
    await mongoose.connection.transaction(async (session) => {
      const prior: any = await Correction.findOne({ company: ctx.company, requestId }).session(session).lean();
      if (prior) { if (prior.requestHash !== requestHash) throw generateError("Request id reused for another correction", 409); result = prior; return; }
      const source = await correctionSource(ctx.company, inputId, employee, date, session);
      const previous: any = await Correction.findOne({ company: ctx.company, sourceInput: inputId, employee, attendanceDate: date, status: "settled" }).sort({ settledAt: -1 }).session(session).lean();
      const original = previous?.revised || source.original, correctionId = new mongoose.Types.ObjectId(), at = new Date();
      const control: any = await Control.findOne({ company: ctx.company, employee, attendanceDate: date, payrollInput: inputId }).session(session).lean();
      if (!control?.payrollLockedAt) throw generateError("The day is already open for correction or is not locked to this input", 409);
      const day = await resolveTimesheetDay(ctx.company, employee, date, at, undefined, true, control);
      if (!day.context.timezone) throw generateError("Restore the historical work schedule before opening a correction", 409);
      const until = localInstant(addDateDays(dateInZone(at, day.context.timezone), 7), "23:59", day.context.timezone);
      const extension = { until, timezone: day.context.timezone, eventId: correctionId, reason, actor: ctx.actor, actorNameSnapshot: req.bodyData?.name || req.user?.name || "HR", at };
      const changed = await Control.updateOne({ _id: control._id, writeVersion: control.writeVersion, payrollLockedAt: control.payrollLockedAt }, { $set: { payrollLockedAt: null, extension }, $inc: { writeVersion: 1, revision: 1 } }, { session });
      if (!changed.modifiedCount) throw generateError("Timesheet controls changed. Reload before opening correction.", 409);
      const sheet: any = await Timesheet.findOne({ company: ctx.company, employee, attendanceDate: date }).session(session).lean();
      if (sheet) {
        const submission: any = sheet.currentSubmission ? await Submission.findOne({ _id: sheet.currentSubmission, company: ctx.company }).session(session) : null;
        if (submission?.status === "approved") {
          await cancelApprovalInstance({ company: ctx.company, requestModel: "TimesheetSubmission", requestId: submission._id, actor: req.bodyData || req.user, comment: reason, session });
          submission.status = "reopened"; submission.currentApprovers = []; submission.sheetRevision = sheet.revision + 1;
          submission.history.push({ action: "historical_correction_opened", actor: ctx.actor, actorNameSnapshot: extension.actorNameSnapshot, comment: reason, at }); await submission.save({ session });
        }
        const snapshot = { ...sheet, status: "draft", payrollLockedAt: null, revision: sheet.revision + 1, updatedBy: ctx.actor };
        await Timesheet.updateOne({ _id: sheet._id, revision: sheet.revision }, { $set: { status: "draft", payrollLockedAt: null, updatedBy: ctx.actor }, $inc: { revision: 1 } }, { session });
        await Revision.create([{ company: ctx.company, employee, attendanceDate: date, timesheet: sheet._id, revision: snapshot.revision, requestId, requestHash, actor: ctx.actor, action: "historical_correction_opened", actionEvidence: { correction: correctionId, reason }, snapshot }], { session });
      }
      [result] = await Correction.create([{ _id: correctionId, company: ctx.company, sourceInput: inputId, employee, attendanceDate: date, requestId, requestHash, reason, actor: ctx.actor, original }], { session });
      const after = { ...controlSnapshot(control), payrollLockedAt: null, revision: control.revision + 1, extension };
      await Audit.create([{ company: ctx.company, employee, attendanceDate: date, control: control._id, revision: after.revision, action: "extend_deadline", requestId: `correction-${correctionId}`, requestHash, reason, actor: ctx.actor, actorNameSnapshot: extension.actorNameSnapshot, before: controlSnapshot(control), after, contextSnapshot: { correction: correctionId, sourceInput: inputId } }], { session });
      await upsertTimesheetNotifications({ company: ctx.company, recipients: [employee], actor: ctx.actor, eventType: "timesheet.correction_opened", entityType: "timesheet_correction", entityId: correctionId, title: "Timesheet correction opened", message: `HR reopened ${date} for correction and fresh approval. Original payroll remains unchanged.`, actionUrl: `/dashboard/calendar?workDate=${date}` }, session);
    });
    res.json({ success: true, data: result });
  } catch (error: any) { next(error.code === 11000 ? generateError("This day already has an open correction", 409) : error); }
};

export async function previewTimesheetCorrection(correction: any, session?: mongoose.ClientSession) {
  const { input, run, original } = await correctionSource(correction.company, correction.sourceInput, correction.employee, correction.attendanceDate, session);
  const employee: any = await User.findOne({ _id: correction.employee, company: correction.company }).session(session || null).lean();
  const rows = employee ? await buildOperationsDays(correction.company, [employee], [correction.attendanceDate], undefined, new Date(), true, session) : [];
  if (!rows[0]) throw generateError("Restore the historical employee assignment before reviewing the correction", 409);
  const day = rows[0]._day, sheet = rows[0]._sheet;
  const originalSummary: any = await Summary.findOne({ company: correction.company, employee: correction.employee, attendancePeriod: run.attendancePeriod, attendancePeriodVersion: run.attendancePeriodVersion }).session(session || null).lean();
  let attendance = originalSummary?.daily.find((d: any) => d.attendanceDate === correction.attendanceDate);
  if (!attendance) throw generateError("Original attendance evidence is missing", 409);
  const attendanceChanged = day.record?.revisionNumber !== attendance.attendanceRevisionNumber;
  if (attendanceChanged) {
    const corrected: any = await Summary.findOne({ company: correction.company, employee: correction.employee, periodKey: run.periodKey, daily: { $elemMatch: { attendanceDate: correction.attendanceDate, attendanceRevisionNumber: day.record?.revisionNumber } } }).sort({ attendancePeriodVersion: -1 }).session(session || null).lean();
    attendance = corrected?.daily.find((d: any) => d.attendanceDate === correction.attendanceDate);
    if (!attendance) throw generateError("Process the corrected attendance cycle and route its payroll adjustment before settlement", 409);
  }
  const revised = calculateTimesheetPayrollDay(day, sheet, attendance, new Date(), true);
  if (day.requirement.requiredMinutes && sheet?.status !== "approved") revised.blockers.push("Corrected work must receive final approval before settlement");
  const delta = roundTimesheetDays(revised.additionalLopDays - correction.original.additionalLopDays);
  const finalized: any = await PayrollResult.findOne({ company: correction.company, payrollRun: run._id, employee: correction.employee, finalizationVersion: run.finalizationVersion }).session(session || null).lean();
  if (!finalized) throw generateError("Finalized salary evidence is missing", 409);
  const prior: any[] = await Correction.aggregate([
    { $match: { company: correction.company, sourceInput: input._id, employee: correction.employee, status: "settled", _id: { $ne: correction._id } } },
    { $lookup: { from: PayrollRun.collection.name, localField: "payrollRun", foreignField: "_id", as: "target" } },
    { $group: { _id: null, signedLopDelta: { $sum: "$signedLopDelta" }, latestTargetPeriod: { $max: { $arrayElemAt: ["$target.periodKey", 0] } } } },
  ]).session(session || null);
  const earliestTargetPeriod = prior[0]?.latestTargetPeriod || null;
  const totalDays = Number(finalized.payrollDays.totalDays), oldPaid = Number(finalized.payrollDays.paidDays) - Number(prior[0]?.signedLopDelta || 0), newPaid = Math.max(0, Math.min(totalDays, oldPaid - delta));
  const lines = (finalized.recurringComponents || []).filter((component: any) => component.prorateOnUnpaidDays && ["earning", "deduction"].includes(component.category)).map((component: any) => {
    const before = prorateMinorAmount(component.scheduledAmountMinor, Math.round(oldPaid * 1000000), Math.round(totalDays * 1000000), run.roundingMode);
    const after = prorateMinorAmount(component.scheduledAmountMinor, Math.round(newPaid * 1000000), Math.round(totalDays * 1000000), run.roundingMode);
    return { component: component.componentCode, category: component.category, before, after, netDeltaMinor: (after - before) * (component.category === "earning" ? 1 : -1) };
  });
  const netDeltaMinor = lines.reduce((sum: number, line: any) => sum + line.netDeltaMinor, 0);
  return { revised, delta, netDeltaMinor, lines, sourceRun: run, sourceResult: finalized, attendanceChanged, original, input, day, sheet, earliestTargetPeriod };
}
export const getTimesheetCorrectionPreview = async (req: any, res: any, next: any) => {
  try {
    const ctx = await timesheetPayrollContext(req), correction: any = await Correction.findOne({ company: ctx.company, _id: objectId(req.params.correctionId, "correction") }).lean();
    if (!correction) throw generateError("Correction not found", 404);
    await writePayrollAccessLog({ req, company: ctx.company, actor: ctx.actor, action: "operations_viewed", resourceType: "payroll_operations", resourceId: `timesheet-correction:${correction._id}`, employee: correction.employee, metadata: { status: correction.status }, retentionDays: Number((ctx.companyConfig as any)?.payrollSettings?.accessLogRetentionDays || 365) });
    if (correction.status === "settled") {
      const source: any = await PayrollRun.findOne({ company: ctx.company, _id: correction.payrollRun }).select("currency currencyMinorUnits").lean();
      return res.json({ success: true, data: { correction, revised: correction.revised, signedLopDelta: correction.signedLopDelta, netDeltaMinor: correction.amountMinor, lines: correction.settlementEvidence?.lines || [], currency: correction.settlementEvidence?.currency || source?.currency || "INR", currencyMinorUnits: correction.settlementEvidence?.currencyMinorUnits ?? source?.currencyMinorUnits ?? 2, runs: [], components: [] } });
    }
    const preview = await previewTimesheetCorrection(correction);
    const runs = await PayrollRun.find({ company: ctx.company, status: "draft", attendanceInputStatus: "prepared", periodKey: { $gt: preview.sourceRun.periodKey, ...(preview.earliestTargetPeriod ? { $gte: preview.earliestTargetPeriod } : {}) }, currency: preview.sourceRun.currency, currencyMinorUnits: preview.sourceRun.currencyMinorUnits }).select("periodKey version").sort({ periodKey: 1 }).limit(50).lean();
    const category = preview.netDeltaMinor >= 0 ? "earning" : "deduction";
    const expression = req.query.componentSearch ? new RegExp(escapeRegex(shortText(req.query.componentSearch, "Component search", 1, 100)), "i") : null;
    const components = await Component.find({ company: ctx.company, status: "active", category, ...(expression ? { $or: [{ name: expression }, { code: expression }] } : {}) }).select("name code category taxable statutoryWageBases").sort({ name: 1, _id: 1 }).limit(100).lean();
    res.json({ success: true, data: { correction, revised: preview.revised, signedLopDelta: preview.delta, netDeltaMinor: preview.netDeltaMinor, lines: preview.lines, currency: preview.sourceRun.currency, currencyMinorUnits: preview.sourceRun.currencyMinorUnits, runs, components, earliestTargetPeriod: preview.earliestTargetPeriod } });
  } catch (error) { next(error); }
};
export const settleTimesheetCorrection = async (req: any, res: any, next: any) => {
  try {
    const ctx = await timesheetPayrollContext(req, true), correctionId = objectId(req.params.correctionId, "correction");
    let result: any;
    await mongoose.connection.transaction(async (session) => {
      const correction: any = await Correction.findOne({ company: ctx.company, _id: correctionId }).session(session);
      if (!correction) throw generateError("Correction not found", 404);
      if (correction.status === "settled") { result = correction; return; }
      if (correction.settlementAttempts >= 50) throw generateError("Settlement retry limit reached; contact payroll administration", 409);
      const preview = await previewTimesheetCorrection(correction, session);
      if (preview.revised.blockers.length) throw generateError(preview.revised.blockers.join("; "), 409);
      const control: any = await Control.findOneAndUpdate({ company: ctx.company, employee: correction.employee, attendanceDate: correction.attendanceDate, ...(correction.routingCancelled ? { payrollInput: correction.sourceInput } : { payrollLockedAt: null }) }, { $set: { payrollLockedAt: new Date() }, $inc: { writeVersion: 1 } }, { new: true, session });
      if (!control) throw generateError("Correction day changed or is already locked", 409);
      const sheet: any = await Timesheet.findOne({ company: ctx.company, employee: correction.employee, attendanceDate: correction.attendanceDate }).session(session).lean();
      if (sheet && sheet.revision !== preview.sheet?.revision) throw generateError("Work changed after the settlement preview", 409);
      if (sheet) {
        const snapshot = { ...sheet, revision: sheet.revision + 1, payrollLockedAt: control.payrollLockedAt };
        await Timesheet.updateOne({ _id: sheet._id, revision: sheet.revision }, { $set: { payrollLockedAt: control.payrollLockedAt }, $inc: { revision: 1 } }, { session });
        if (sheet.currentSubmission) await Submission.updateOne({ _id: sheet.currentSubmission, company: ctx.company }, { $set: { sheetRevision: snapshot.revision } }, { session });
        await Revision.create([{ company: ctx.company, employee: correction.employee, attendanceDate: correction.attendanceDate, timesheet: sheet._id, revision: snapshot.revision, actor: ctx.actor, action: "historical_correction_settled", requestId: `settle-${correctionId}-${correction.settlementAttempts + 1}`, requestHash: timesheetSourceHash(preview.revised), actionEvidence: { correction: correctionId }, snapshot }], { session });
      }
      let oneTime: any = null, target: any = null;
      if (preview.netDeltaMinor !== 0) {
        target = await PayrollRun.findOne({ _id: objectId(req.body.runId, "target payroll run"), company: ctx.company }).session(session).lean();
        if (!target || target.version !== req.body.expectedVersion) throw generateError("Target payroll run changed", 409);
        const blocker = payrollAdjustmentBlocker(preview.sourceRun, preview.sourceResult, target);
        if (blocker) throw generateError(blocker, 409);
        if (preview.earliestTargetPeriod && target.periodKey < preview.earliestTargetPeriod) throw generateError("Choose a payroll period no earlier than this employee's previous Timesheet settlements for the source cycle", 409);
        if (preview.attendanceChanged) {
          const adjustments: any[] = await AttendanceAdjustment.find({ company: ctx.company, employee: correction.employee, sourcePeriodKey: preview.sourceRun.periodKey, status: { $in: ["pending", "included"] } }).session(session).lean();
          if (!adjustments.length || adjustments.some((a) => a.status !== "included" || id(a.includedInPayrollInput) !== id(target.attendancePayrollInput))) throw generateError("Include the related attendance correction in this same target payroll cycle first", 409);
        }
        const inputType = preview.netDeltaMinor > 0 ? "arrear" : "recovery";
        const component: any = await Component.findOne({ _id: objectId(req.body.componentId, "settlement component"), company: ctx.company, status: "active", category: inputType === "arrear" ? "earning" : "deduction" }).session(session).lean();
        const employeeInput: any = await PayrollEmployee.findOne({ company: ctx.company, payrollRun: target._id, employee: correction.employee }).session(session).lean();
        if (!component || !employeeInput) throw generateError("Choose a matching active component and a target run containing the employee", 422);
        [oneTime] = await OneTime.create([{ ...buildFinalizedCorrectionInputDocument({ sourceRun: preview.sourceRun, sourceResult: preview.sourceResult, targetRun: target, employeeInput, component, actorId: ctx.actor, inputType, amountMinor: Math.abs(preview.netDeltaMinor), reason: correction.reason, reference: `Timesheet ${correction.attendanceDate}`, idempotencyKey: `timesheet-${correctionId}-${correction.settlementAttempts + 1}` }), sourceType: "timesheet_correction" }], { session });
        const deltas = oneTimeInputRunDelta(inputType, Math.abs(preview.netDeltaMinor));
        const changed = await PayrollRun.updateOne({ _id: target._id, version: target.version, status: "draft" }, { $set: { calculationStatus: target.calculationVersion ? "stale" : "pending" }, $inc: { version: 1, oneTimeInputCount: 1, ...Object.fromEntries(Object.entries(deltas).map(([key, value]) => [`oneTimeInputTotals.${key}`, value])) } }, { session });
        if (!changed.modifiedCount) throw generateError("Payroll run changed during settlement", 409);
      }
      correction.status = "settled"; correction.settlementAttempts += 1; correction.routingCancelled = false; correction.revised = preview.revised; correction.signedLopDelta = preview.delta; correction.amountMinor = preview.netDeltaMinor; correction.settlementEvidence = { lines: preview.lines, currency: preview.sourceRun.currency, currencyMinorUnits: preview.sourceRun.currencyMinorUnits, sourceFinalizedResult: preview.sourceResult._id, sourceFinalizationVersion: preview.sourceResult.finalizationVersion, attendanceChanged: preview.attendanceChanged }; correction.payrollRun = target?._id || null; correction.payrollOneTimeInput = oneTime?._id || null; correction.settledAt = new Date(); correction.settledBy = ctx.actor;
      const sourceUpdated = await PayrollRun.updateOne({ _id: preview.sourceRun._id, company: ctx.company, status: "finalized", version: preview.sourceRun.version, finalizationVersion: preview.sourceResult.finalizationVersion }, { $inc: { version: 1 } }, { session });
      if (!sourceUpdated.modifiedCount) throw generateError("Source payroll changed during settlement", 409);
      await correction.save({ session }); result = correction;
      await writePayrollAudit({ company: ctx.company, entityType: "timesheet_payroll", entityId: correctionId, action: "timesheet_correction_settled", actor: ctx.actor, reason: correction.reason, details: { original: correction.original, revised: preview.revised, signedLopDelta: preview.delta, amountMinor: preview.netDeltaMinor, targetRun: target?._id } }, session);
      await upsertTimesheetNotifications({ company: ctx.company, recipients: [correction.employee], actor: ctx.actor, eventType: "timesheet.correction_settled", entityType: "timesheet_correction", entityId: correctionId, title: "Timesheet correction reviewed", message: `The correction for ${correction.attendanceDate} was reviewed${target ? ` for payroll ${target.periodKey}` : " without a salary adjustment"}.`, actionUrl: `/dashboard/calendar?workDate=${correction.attendanceDate}` }, session);
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};
export const listTimesheetCorrections = async (req: any, res: any, next: any) => { try { const ctx = await timesheetPayrollContext(req), { page, limit, skip } = timesheetPagination(req.query, 50), match = { company: ctx.company }; const [data, total] = await Promise.all([Correction.find(match).populate("employee", "name code").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), Correction.countDocuments(match)]); res.json({ success: true, data, pagination: { page, totalPages: Math.max(1, Math.ceil(total / limit)) } }); } catch (error) { next(error); } };
export const getTimesheetPayrollDayHistory = (own = false) => async (req: any, res: any, next: any) => { try { const ctx = own ? ownContext(req) : await timesheetOperationsContext(req), employee = own ? (ctx as any).employee : objectId(req.params.employeeId, "employee"), date = dateKey(req.params.date, "work date")!; if (!own) await loadTimesheetScopedEmployee(ctx, employee, date); const rows: any[] = await EmployeeInput.find({ company: ctx.company, employee, "daily.attendanceDate": date }).select("input daily additionalLopDays").sort({ createdAt: -1 }).limit(10).lean(); const headers: any[] = await Input.find({ company: ctx.company, _id: { $in: rows.map((row) => row.input) } }).select("status version active periodKey").lean(); const corrections = await Correction.find({ company: ctx.company, employee, attendanceDate: date }).select("reason status original revised signedLopDelta createdAt settledAt").sort({ createdAt: -1 }).limit(20).lean(); res.json({ success: true, data: { sources: rows.map((row) => { const header = headers.find((h) => id(h) === id(row.input)); return { input: row.input, inputStatus: header?.status || "unknown", inputVersion: header?.version, periodKey: header?.periodKey, active: header?.active === true, day: row.daily.find((d: any) => d.attendanceDate === date) }; }), corrections } }); } catch (error) { next(error); } };
