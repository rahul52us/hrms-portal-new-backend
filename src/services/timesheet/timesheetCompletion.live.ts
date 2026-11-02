import assert from "node:assert/strict";
import mongoose from "mongoose";
import path from "node:path";
import { spawn } from "node:child_process";
import Attendance from "../../schemas/Attendance/AttendanceRecord.schema";
import AttendanceInput from "../../schemas/Attendance/AttendancePayrollInput.schema";
import AttendancePeriod from "../../schemas/Attendance/AttendancePeriod.schema";
import AttendancePeriodRevision from "../../schemas/Attendance/AttendancePeriodRevision.schema";
import Summary from "../../schemas/Attendance/AttendanceMonthlySummary.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import PayrollEmployee from "../../schemas/Payroll/PayrollEmployeeInput.schema";
import PayrollSnapshot from "../../schemas/Payroll/PayrollEmployeeSnapshot.schema";
import PayrollResult from "../../schemas/Payroll/EmployeePayrollResult.schema";
import Finalized from "../../schemas/Payroll/PayrollFinalizedResult.schema";
import PayrollAudit from "../../schemas/Payroll/PayrollAuditLog.schema";
import PayrollAccess from "../../schemas/Payroll/PayrollAccessLog.schema";
import OneTime from "../../schemas/Payroll/PayrollOneTimeInput.schema";
import Component from "../../schemas/Payroll/SalaryComponent.schema";
import Timesheet from "../../schemas/Timesheet/Timesheet.schema";
import Submission from "../../schemas/Timesheet/TimesheetSubmission.schema";
import Control from "../../schemas/Timesheet/TimesheetDayControl.schema";
import User from "../../schemas/User/User";
import History from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import ProjectAssignment from "../../schemas/project/ProjectAssignment.schema";
import Notification from "../../schemas/Notification/notification.schema";
import { TimesheetAutomationJob as Job, TimesheetAutomationState as State, TimesheetContextEvent as Event } from "../../schemas/Timesheet/TimesheetAutomation.schema";
import { TimesheetPayrollInput as Input, TimesheetPayrollEmployeeInput as EmployeeInput, TimesheetPayrollCorrection as Correction } from "../../schemas/Timesheet/TimesheetPayroll.schema";
import { TimesheetWriteBucket } from "./timesheetWriteGuard";
import { buildPayrollRunDocument } from "../payroll/payrollRun.service";
import { executeTimesheetPayrollLock } from "./timesheetPayroll.service";
import { executeTimesheetAutomation, queueTimesheetAutomation } from "./timesheetAutomation.service";
import { addDateDays, localInstant } from "./timesheet.utils";
import { loadTimesheetRegister } from "./timesheetOperations.service";

export const completionModels: any[] = [AttendanceInput, AttendancePeriodRevision, Summary, PayrollRun, PayrollEmployee, PayrollSnapshot, PayrollResult, Finalized, PayrollAudit, PayrollAccess, OneTime, Component, Job, State, Event, Input, EmployeeInput, Correction, TimesheetWriteBucket];

export async function verifyTimesheetCompletion(ctx: any) {
  const { company, admin, employee, otherEmployee: worker, outsider, day, from, timezone, project, workType, call, policies, policyId, daily, token, base } = ctx;
  const id = () => new mongoose.Types.ObjectId(), periodKey = day.slice(0, 7), now = new Date();
  const policy = (await call(admin, policies, "POST", { name: "Payroll Timesheets", code: "PAY_TS", effectiveFrom: from, rules: { required: true, payrollMode: "shortfall", deadlineDaysAfterShift: 0, maxBackdateDays: 0, remindersEnabled: true } }, 201)).data;
  await call(admin, `${policies}/${policy.policy._id}/versions/${policy.version._id}/publish`, "POST", { revision: 1 });
  await call(admin, "/api/workforce-policies/assignments", "POST", { resourceType: "timesheet_policy", resourceId: policy.policy._id, scopeType: "employee", scopeId: worker, effectiveFrom: from, changeReason: "Payroll completion fixture" }, 201);
  await ProjectAssignment.create({ company, project, employee: worker, employeeNameSnapshot: "Timesheet employee 2", effectiveFrom: from, changeReason: "Payroll fixture", createdBy: admin });
  const record = await Attendance.create({ company, employee: worker, attendanceDate: day, timezone, state: "calculated", status: "present", workMode: "remote", revisionNumber: 1, workedMinutes: 480, punchSessions: [{ punchIn: localInstant(day, "09:30", timezone), punchOut: localInstant(day, "18:30", timezone), source: "import" }] });
  const attendancePeriod = id(), source = await AttendanceInput.create({ company, attendancePeriod, periodKey, cycleStartDate: day, cycleEndDate: day, attendanceCutoffDay: Number(day.slice(-2)), version: 1, attendancePeriodVersion: 1, summaryCount: 1, adjustmentCount: 0, totals: { payroll: { paidDays: 1, unpaidDays: 0 } }, reason: "Isolated one-day payroll fixture", lockedAt: now, lockedBy: admin });
  await AttendancePeriod.create({ _id: attendancePeriod, company, periodKey, startDate: day, endDate: day, attendanceCutoffDay: Number(day.slice(-2)), version: 1, status: "locked", lockedAt: now, lockedBy: admin, createdBy: admin, updatedBy: admin });
  const numbers = ["calendarDays", "expectedDays", "paidDays", "unpaidDays", "presentDays", "halfDays", "absentDays", "paidLeaveDays", "unpaidLeaveDays", "holidayDays", "weeklyOffDays", "wfhDays", "incompleteDays", "pendingDays", "workedMinutes", "rawOvertimeMinutes", "approvedOvertimeMinutes", "lateMinutes", "earlyExitMinutes", "lateDays", "earlyExitDays", "missingPunchDays", "overtimeDays", "regularizationDays", "exceptionCount", "sourceRecordCount"];
  const summary = await Summary.create({ ...Object.fromEntries(numbers.map((key) => [key, 0])), company, attendancePeriod, periodKey, attendancePeriodVersion: 1, employee: worker, employeeNameSnapshot: "Timesheet employee 2", employeeCodeSnapshot: `TS-${worker}`, calendarDays: 1, expectedDays: 1, paidDays: 1, presentDays: 1, sourceRecordCount: 1, createdBy: admin, daily: [{ attendanceDate: day, attendanceRecord: record._id, attendanceRevisionNumber: 1, status: "present", dayType: "working_day", workMode: "remote", workedMinutes: 480, lateMinutes: 0, earlyExitMinutes: 0, overtimeMinutes: 0, approvedOvertimeMinutes: 0, paidUnits: 1, unpaidUnits: 0, leaveUnits: 0, paidLeave: false, exceptions: [] }] });
  await call(worker, `/api/timesheets/payroll/cycles/${periodKey}`, "GET", undefined, 403);
  await call(outsider, `/api/timesheets/payroll/cycles/${periodKey}`, "GET", undefined, 403);
  const preview = await call(admin, `/api/timesheets/payroll/cycles/${periodKey}?limit=1`);
  assert.equal(preview.data[0].additionalLopDays, 1); assert.deepEqual(preview.data[0].blockers, []);
  await call(worker, `${policies}/preview`, "POST", { effectiveFrom: day, rules: { payrollMode: "shortfall" } }, 403);
  const proposed = await call(admin, `${policies}/preview`, "POST", { policyId: String(policy.policy._id), effectiveFrom: day, scopeType: "employee", scopeId: String(worker), rules: { required: true, payrollMode: "shortfall" }, limit: 1, search: "Timesheet employee 2" });
  assert.equal(proposed.data.length, 1); assert.equal(proposed.data[0].applies, true); assert.equal(proposed.data[0].requiredMinutes, 480); assert.equal(proposed.conflict, true);
  await call(admin, `${policies}/preview`, "POST", { effectiveFrom: day, rules: null }, 400);
  async function lock(requestId: string) {
    const queued = (await call(admin, `/api/timesheets/payroll/cycles/${periodKey}/lock`, "POST", { reason: "Review completed for testing", requestId }, 202)).data;
    for (let i = 0; i < 100; i++) {
      await executeTimesheetPayrollLock(queued._id, 10);
      const input: any = await Input.findById(queued._id).lean();
      if (input.status === "locked") return input;
      if (input.status === "failed") assert.fail(`Timesheet lock failed: ${input.error}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("Timesheet locking timed out");
  }
  const firstInput = await lock("completion-first-lock");
  assert.equal(firstInput.employeeCount, 1); assert.equal(firstInput.additionalLopDays, 1);
  assert.equal((await call(admin, `/api/timesheets/payroll/cycles/${periodKey}/lock`, "POST", { reason: "Review completed for testing", requestId: "completion-first-lock" }, 202)).data._id, String(firstInput._id));
  assert.equal((await call(worker, daily)).data.eligibility.canSave, false);
  const run = await PayrollRun.create(buildPayrollRunDocument({ company: { _id: company, company_name: "Timesheet payroll test", companyCode: "TS" }, input: source, actorId: admin, reason: "Fixture calculation" }));
  await call(admin, `/api/payroll/runs/${run._id}/prepare-attendance-inputs`, "POST", { expectedVersion: run.version }, 201);
  const componentId = id(), payrollEmployee: any = await PayrollEmployee.findOne({ payrollRun: run._id }).lean();
  await PayrollSnapshot.collection.insertOne({ company, payrollRun: run._id, periodKey, snapshotVersion: 1, employee: worker, payrollEmployeeInput: payrollEmployee._id, identity: { name: "Timesheet employee 2", code: `TS-${worker}` }, organization: {}, issues: [], compensation: { assigned: true, currency: "INR", componentAmounts: [{ salaryComponent: componentId, componentCode: "BASIC", componentName: "Basic salary", category: "earning", monthlyAmountMinor: 3000000, annualAmountMinor: 36000000, taxable: true, statutoryWageBases: [], prorateOnUnpaidDays: true }] } });
  await PayrollRun.updateOne({ _id: run._id }, { $set: { employeeSnapshotStatus: "prepared", employeeSnapshotVersion: 1, employeeSnapshotCount: 1 } });
  async function calculate() { const current: any = await PayrollRun.findById(run._id).lean(); await call(admin, `/api/payroll/runs/${run._id}/calculate`, "POST", { expectedVersion: current.version, reason: "Timesheet payroll regression" }, 201); return PayrollResult.findOne({ payrollRun: run._id }).sort({ calculationVersion: -1 }).lean() as any; }
  const missing = await calculate(); assert.equal(missing.totals.netPayMinor, 0); assert.equal(missing.payrollDays.timesheetLopDays, 1);
  assert.equal((await Summary.findById(summary._id).lean())!.paidDays, 1, "Attendance remains unchanged");
  const currentFirst: any = await Input.findById(firstInput._id).lean();
  await call(admin, `/api/timesheets/payroll/inputs/${firstInput._id}/state`, "POST", { revision: currentFirst.revision, action: "cancel", reason: "Employee correction before finalization" });
  assert.equal((await PayrollRun.findById(run._id).lean())!.calculationStatus, "stale");
  const control: any = await Control.findOne({ company, employee: worker, attendanceDate: day }).lean();
  await call(admin, `/api/timesheets/operations/employees/${worker}/day/${day}/controls`, "POST", { action: "extend_deadline", revision: control.revision, requestId: "completion-extend-day", reason: "Allow employee correction", untilDate: addDateDays(day, 20), untilTime: "23:59" });
  async function saveAndApprove(end: string, label: string) {
    const before = (await call(worker, daily)).data.timesheet;
    const saved = (await call(worker, daily, "PUT", { revision: before?.revision || 0, requestId: `${label}-save`, entries: [{ projectId: String(project), workTypeId: String(workType), startDate: day, endDate: day, startTime: "09:30", endTime: end, notes: "Payroll correction verification" }] })).data;
    const submitted = (await call(worker, `${daily}/submit`, "POST", { revision: saved.revision, requestId: `${label}-submit`, acknowledgeShortfall: true })).data;
    if (label === "completion-half") assert.ok((await call(admin, `/api/timesheets/payroll/cycles/${periodKey}`)).data[0].blockers.some((message: string) => message.includes("approval is pending")));
    const approved = (await call(admin, `/api/timesheets/submissions/${submitted.currentSubmission}/approve`, "POST", { revision: submitted.revision, requestId: `${label}-approve` })).data;
    assert.equal(approved.status, "approved"); return approved;
  }
  await saveAndApprove("13:30", "completion-half");
  // The fixture clock advances beyond the granted edit window before a second lock.
  await Control.collection.updateOne({ _id: control._id }, { $set: { "extension.until": new Date(Date.now() - 60000) } });
  const locked = await lock("completion-second-lock"); assert.equal(locked.additionalLopDays, 0.5);
  const calculated = await calculate(); assert.equal(calculated.totals.netPayMinor, 1500000); assert.equal(calculated.payrollDays.attendanceLopDays, 0);
  const currentRun: any = await PayrollRun.findById(run._id).lean();
  const checker = id();
  await User.collection.insertOne({ _id: checker, company, role: "hradmin", name: "Timesheet payroll checker", code: `TS-${checker}`, username: `checker-${checker}@example.test`, password: "fixture-only", is_enabled: true, joiningDate: new Date(`${from}T00:00:00Z`), createdAt: new Date(`${from}T00:00:00Z`) });
  await call(admin, `/api/payroll/runs/${run._id}/submit-review`, "POST", { expectedVersion: currentRun.version, reason: "Timesheet payroll integration review" });
  const reviewRun: any = await PayrollRun.findById(run._id).lean();
  await call(admin, `/api/payroll/runs/${run._id}/review-decision`, "POST", { expectedVersion: reviewRun.version, reason: "Maker cannot approve own payroll", action: "approve" }, 409);
  await call(checker, `/api/payroll/runs/${run._id}/review-decision`, "POST", { expectedVersion: reviewRun.version, reason: "Independent reviewer verified Timesheet source", action: "approve" });
  const approvedRun: any = await PayrollRun.findById(run._id).lean();
  await call(admin, `/api/payroll/runs/${run._id}/finalize`, "POST", { expectedVersion: approvedRun.version, reason: "Finalize verified Timesheet payroll" });
  const finalized = (await Finalized.findOne({ payrollRun: run._id }).lean())!;
  const frozen = JSON.stringify(await Finalized.findById(finalized._id).lean()), attendanceFrozen = JSON.stringify(await Summary.findById(summary._id).lean()), sourceFrozen = JSON.stringify(await EmployeeInput.findOne({ input: locked._id }).lean());
  const lockedForCancel: any = await Input.findById(locked._id).lean();
  await call(admin, `/api/timesheets/payroll/inputs/${locked._id}/state`, "POST", { action: "cancel", revision: lockedForCancel.revision, reason: "Finalized payroll cannot rebuild source" }, 409);
  await call(admin, `/api/attendance/periods/${periodKey}/reopen`, "POST", { expectedVersion: 1, reason: "Historical attendance review preserves frozen sources" });
  const correctionPayload = { employeeId: String(worker), date: day, reason: "Approved additional work after payroll", requestId: "completion-correction-open" };
  await call(worker, `/api/timesheets/payroll/inputs/${locked._id}/corrections`, "POST", correctionPayload, 403);
  const correction = (await call(admin, `/api/timesheets/payroll/inputs/${locked._id}/corrections`, "POST", correctionPayload)).data;
  assert.equal((await call(admin, `/api/timesheets/payroll/inputs/${locked._id}/corrections`, "POST", correctionPayload)).data._id, correction._id);
  await call(admin, `/api/timesheets/payroll/corrections/${correction._id}/settle`, "POST", {}, 409);
  await saveAndApprove("17:30", "completion-full");
  const earlierMonth = addDateDays(`${periodKey}-28`, 5).slice(0, 7), nextMonth = addDateDays(`${earlierMonth}-28`, 5).slice(0, 7);
  const target = await PayrollRun.create({ ...buildPayrollRunDocument({ company: { _id: company, company_name: "Timesheet payroll test", companyCode: "TS" }, input: { ...source.toObject(), _id: id(), attendancePeriod: id(), periodKey: nextMonth, cycleStartDate: `${nextMonth}-01`, cycleEndDate: `${nextMonth}-28` }, actorId: admin, reason: "Later adjustment fixture" }), attendanceInputStatus: "prepared", employeeInputCount: 1 });
  await PayrollEmployee.collection.insertOne({ ...payrollEmployee, _id: id(), payrollRun: target._id, periodKey: nextMonth });
  const earning = await Component.create({ company, name: "Timesheet arrears", code: "TS_ARREARS", category: "earning", taxable: true, prorateOnUnpaidDays: false, createdBy: admin, updatedBy: admin });
  const corrected = (await call(admin, `/api/timesheets/payroll/corrections/${correction._id}`)).data;
  assert.equal(corrected.signedLopDelta, -0.5); assert.equal(corrected.netDeltaMinor, 1500000); assert.deepEqual(corrected.revised.blockers, []);
  assert.equal((await call(admin, `/api/timesheets/payroll/corrections/${correction._id}?componentSearch=TS_ARREARS`)).data.components.length, 1);
  const settlePayload = { runId: String(target._id), componentId: String(earning._id), expectedVersion: target.version };
  const settled = (await call(admin, `/api/timesheets/payroll/corrections/${correction._id}/settle`, "POST", settlePayload)).data;
  assert.equal(settled.status, "settled"); assert.equal(settled.amountMinor, 1500000);
  assert.equal((await call(admin, `/api/timesheets/payroll/corrections/${correction._id}/settle`, "POST", settlePayload)).data.payrollOneTimeInput, settled.payrollOneTimeInput);
  assert.equal(await OneTime.countDocuments({ company, sourceType: "timesheet_correction", status: "active" }), 1);
  const targetAfter: any = await PayrollRun.findById(target._id).lean();
  await call(admin, `/api/payroll/runs/${target._id}/one-time-inputs/${settled.payrollOneTimeInput}/cancel`, "POST", { expectedVersion: targetAfter.version, reason: "Test settlement rerouting" });
  const reopenedSettlement: any = await Correction.findById(correction._id).lean();
  assert.equal(reopenedSettlement.status, "open");
  const rerouteRun: any = await PayrollRun.findById(target._id).lean();
  await call(admin, `/api/timesheets/payroll/corrections/${correction._id}/settle`, "POST", { ...settlePayload, expectedVersion: rerouteRun.version });
  assert.equal(await OneTime.countDocuments({ company, sourceType: "timesheet_correction", status: "active" }), 1);
  assert.equal(await OneTime.countDocuments({ company, sourceType: "timesheet_correction", status: "cancelled" }), 1);
  const secondCorrection = (await call(admin, `/api/timesheets/payroll/inputs/${locked._id}/corrections`, "POST", { ...correctionPayload, requestId: "completion-recovery-open", reason: "Review revised work allocation" })).data;
  await saveAndApprove("13:30", "completion-recovery");
  const recoveryPreview = (await call(admin, `/api/timesheets/payroll/corrections/${secondCorrection._id}`)).data;
  assert.equal(recoveryPreview.signedLopDelta, 0.5); assert.equal(recoveryPreview.netDeltaMinor, -1500000, "Later correction compares against the previously settled basis, not the original deduction again");
  assert.equal(recoveryPreview.earliestTargetPeriod, nextMonth);
  const recoveryComponent = await Component.create({ company, name: "Timesheet recovery", code: "TS_RECOVERY", category: "deduction", taxable: false, prorateOnUnpaidDays: false, createdBy: admin, updatedBy: admin });
  const earlierTarget = await PayrollRun.create({ ...buildPayrollRunDocument({ company: { _id: company, company_name: "Timesheet payroll test", companyCode: "TS" }, input: { ...source.toObject(), _id: id(), attendancePeriod: id(), periodKey: earlierMonth, cycleStartDate: `${earlierMonth}-01`, cycleEndDate: `${earlierMonth}-28` }, actorId: admin, reason: "Earlier target denial fixture" }), attendanceInputStatus: "prepared", employeeInputCount: 1 });
  await PayrollEmployee.collection.insertOne({ ...payrollEmployee, _id: id(), payrollRun: earlierTarget._id, periodKey: earlierMonth });
  await call(admin, `/api/timesheets/payroll/corrections/${secondCorrection._id}/settle`, "POST", { runId: String(earlierTarget._id), componentId: String(recoveryComponent._id), expectedVersion: earlierTarget.version }, 409);
  const targetForRecovery: any = await PayrollRun.findById(target._id).lean();
  await call(admin, `/api/timesheets/payroll/corrections/${secondCorrection._id}/settle`, "POST", { runId: String(target._id), componentId: String(recoveryComponent._id), expectedVersion: targetForRecovery.version });
  const originalCorrection: any = await Correction.findById(correction._id).lean(), targetForCancellation: any = await PayrollRun.findById(target._id).lean();
  await call(admin, `/api/payroll/runs/${target._id}/one-time-inputs/${originalCorrection.payrollOneTimeInput}/cancel`, "POST", { expectedVersion: targetForCancellation.version, reason: "Must not invalidate dependent recovery" }, 409);
  const adjustedTarget: any = await PayrollRun.findById(target._id).lean();
  assert.equal(adjustedTarget.oneTimeInputTotals.netImpactMinor, 0, "Refund followed by recovery reconciles to zero, without duplicate salary effects");
  assert.equal(JSON.stringify(await Finalized.findById(finalized._id).lean()), frozen);
  assert.equal(JSON.stringify(await Summary.findById(summary._id).lean()), attendanceFrozen);
  assert.equal(JSON.stringify(await EmployeeInput.findOne({ input: locked._id }).lean()), sourceFrozen);
  const ownHistory = (await call(worker, `${daily}/payroll-history`)).data;
  assert.equal(ownHistory.corrections[0].status, "settled"); assert.equal(ownHistory.corrections[0].amountMinor, undefined, "Employee context history does not expose payroll money");
  assert.equal((await call(outsider, `${daily}/payroll-history`)).data.sources.length, 0);
  await call(worker, `/api/timesheets/operations/employees/${employee}/day/${day}/context-events`, "GET", undefined, 403);
  await call(worker, "/api/timesheets/automation", "POST", {}, 403);
  await TimesheetWriteBucket.updateOne({ company, actor: worker, bucket: Math.floor(Date.now() / 60000) }, { $set: { count: 120, expiresAt: new Date(Date.now() + 120000) } }, { upsert: true });
  await call(worker, "/api/timesheets/automation", "POST", {}, 429);
  await call(worker, daily, "PUT", { oversized: "x".repeat(262144) }, 413);
  await TimesheetWriteBucket.updateMany({ company, actor: worker }, { $set: { count: 0 } });
  // Force historical context drift and an overdue pending submission in isolated fixtures.
  await Attendance.updateOne({ _id: record._id }, { $inc: { revisionNumber: 1 } });
  const currentEmployee = (await call(employee, daily)).data.timesheet;
  const pending = (await call(employee, `${daily}/submit`, "POST", { revision: currentEmployee.revision, requestId: "completion-pending-manager" })).data;
  await Submission.collection.updateOne({ _id: new mongoose.Types.ObjectId(pending.currentSubmission) }, { $set: { approvalDeadlineAt: new Date(Date.now() - 60000) } });
  const reminderVersion = (await call(admin, `${policies}/${policy.policy._id}/versions`, "POST", { effectiveFrom: addDateDays(day, 1), changeReason: "Reminder fixture on a later work date", rules: { deadlineDaysAfterShift: 0, maxBackdateDays: 31 } }, 201)).data;
  await call(admin, `${policies}/${policy.policy._id}/versions/${reminderVersion._id}/publish`, "POST", { revision: reminderVersion.revision });
  async function drain(key: string) { const job: any = await queueTimesheetAutomation(company, key, admin); for (let i = 0; i < 100; i++) { await executeTimesheetAutomation(job._id, 50); const latest: any = await Job.findById(job._id).lean(); if (latest.status === "complete") return latest; if (latest.status === "failed") assert.fail(latest.error); await new Promise((resolve) => setTimeout(resolve, 30)); } assert.fail("Automation timed out"); }
  await drain("completion-automation-first");
  assert.ok(await Event.exists({ company, employee: worker, attendanceDate: day }));
  assert.ok(await Notification.exists({ company, eventType: "timesheet.approval_reminder" }));
  assert.ok(await Notification.exists({ company, eventType: "timesheet.approval_escalation" }));
  assert.ok(await Notification.exists({ company, eventType: "timesheet.submission_reminder", recipient: worker }));
  assert.equal(await Notification.countDocuments({ company, eventType: "timesheet.submission_reminder", recipient: worker }), 1, "Multiple missing dates are consolidated into one employee reminder");
  assert.ok(await Notification.exists({ company, eventType: "timesheet.context_changed", recipient: admin }));
  const alerts = await Notification.countDocuments({ company, eventType: /^timesheet\.(context_changed|approval_reminder|approval_escalation)$/ });
  await drain("completion-automation-retry");
  assert.equal(await Notification.countDocuments({ company, eventType: /^timesheet\.(context_changed|approval_reminder|approval_escalation)$/ }), alerts, "Repeated jobs deduplicate alerts");
  assert.ok((await call(worker, `${daily}/context-events`)).data.length);
  if (process.argv.includes("--completion-ui")) {
    const child = spawn(process.execPath, [path.resolve(process.cwd(), "../scripts/verify-timesheet-completion-ui.cjs")], { windowsHide: true, stdio: "inherit", env: { ...process.env, TIMESHEET_TEST_API_URL: base, TIMESHEET_TEST_ADMIN_TOKEN: token(admin), TIMESHEET_TEST_EMPLOYEE_TOKEN: token(worker), TIMESHEET_TEST_DAY: day, TIMESHEET_TEST_PERIOD: periodKey } });
    const code = await new Promise((resolve) => child.on("exit", resolve)); assert.equal(code, 0, "Timesheet completion UI failed");
  }
  console.log("Timesheet completion live passed: missing/half/full work, idempotent cycle locking, Draft rebuild, real payroll calculation, frozen finalization, reopen/reapprove/refund, no double settlement, tenant/employee denials, context reconciliation, manager escalation and alert deduplication");
}

export async function verifyTimesheetScale(ctx: any) {
  const { company, admin, day, from, project } = ctx;
  const employees = Array.from({ length: 10000 }, (_, index) => ({ _id: new mongoose.Types.ObjectId(), company, name: `Scale employee ${index}`, code: `SCALE-${index}`, username: `scale-${company}-${index}@example.test`, password: "isolated-fixture", role: "user", is_enabled: true, joiningDate: new Date(`${from}T00:00:00Z`), createdAt: new Date(`${from}T00:00:00Z`), reportingManager: admin }));
  for (let index = 0; index < employees.length; index += 500) {
    const batch = employees.slice(index, index + 500);
    await User.collection.insertMany(batch);
    await History.collection.insertMany(batch.map((employee) => ({ company, employee: employee._id, effectiveFrom: new Date(`${from}T00:00:00Z`), effectiveTo: null, reportingManager: admin })));
    await ProjectAssignment.collection.insertMany(batch.map((employee) => ({ company, employee: employee._id, project, employeeNameSnapshot: employee.name, status: "assigned", effectiveFrom: from, effectiveTo: null, createdBy: admin })));
  }
  let queries = 0, maxBatch = 0;
  mongoose.set("debug", (_collection, _method, query: any) => { queries++; if (query?.employee?.$in) maxBatch = Math.max(maxBatch, query.employee.$in.length); });
  const started = Date.now();
  try {
    const result = await loadTimesheetRegister({ company, actor: { _id: admin, role: "hradmin", permissions: { view_timesheets: true } }, scope: "organization", dates: [day], filters: { status: "all", search: "" } }, 2, 25);
    assert.ok(result.pagination.total >= 10000); assert.equal(result.data.length, 25);
    assert.ok(maxBatch <= 250); assert.ok(queries < 700, `Unexpected per-employee policy queries: ${queries}`);
  } finally { mongoose.set("debug", false); }
  const explain: any = await User.find({ company, role: { $ne: "superadmin" } }).sort({ _id: 1 }).limit(250).explain("executionStats");
  assert.ok(JSON.stringify(explain.queryPlanner.winningPlan).includes("IXSCAN"), "Company roster keyset must use an index");
  const job: any = await queueTimesheetAutomation(company, "scale-batched-automation", admin);
  await executeTimesheetAutomation(job._id, 1);
  const first: any = await Job.findById(job._id).lean(); assert.equal(first.status, "queued"); assert.equal(first.metrics.employees, 100);
  await executeTimesheetAutomation(job._id, 1);
  const resumed: any = await Job.findById(job._id).lean(); assert.equal(resumed.metrics.employees, 200); assert.notEqual(String(first.cursor.after), String(resumed.cursor.after));
  console.log(`Real MongoDB 10,000-employee Timesheet register passed: ${queries} database commands, max ${maxBatch} employees per policy batch, ${Date.now() - started}ms including two resumable reminder batches; indexed keyset verified. Local fixture, not a deployment SLA.`);
}
