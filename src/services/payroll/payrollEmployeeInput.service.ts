import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceMonthlySummary from "../../schemas/Attendance/AttendanceMonthlySummary.schema";
import AttendancePayrollAdjustment from "../../schemas/Attendance/AttendancePayrollAdjustment.schema";
import PayrollEmployeeInput, {
  PAYROLL_EMPLOYEE_CURRENT_FIELDS,
  PAYROLL_EMPLOYEE_RESOLVED_FIELDS,
} from "../../schemas/Payroll/PayrollEmployeeInput.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import {
  ensurePayrollRunManager,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";

const roundUnits = (value: unknown) => Math.round((Number(value) || 0) * 100) / 100;
const idString = (value: any) => String(value?._id || value || "");
const text = (value: unknown) => String(value ?? "").trim();

function pageNumber(value: unknown, fallback: number, maximum: number) {
  const parsed = Number.parseInt(text(value), 10);
  return Math.min(maximum, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numericSnapshot(source: any, fields: readonly string[]) {
  return fields.reduce<Record<string, number>>((result, field) => {
    result[field] = roundUnits(source?.[field]);
    return result;
  }, {});
}

export function buildPayrollEmployeeInputs(options: {
  run: any;
  summaries: any[];
  adjustments: any[];
  actorId: mongoose.Types.ObjectId;
  preparedAt?: Date;
}) {
  const preparedAt = options.preparedAt || new Date();
  const summariesByEmployee = new Map(
    options.summaries.map((summary) => [idString(summary.employee), summary])
  );
  const adjustmentsByEmployee = new Map<string, any[]>();
  for (const adjustment of options.adjustments) {
    const key = idString(adjustment.employee);
    adjustmentsByEmployee.set(key, [...(adjustmentsByEmployee.get(key) || []), adjustment]);
  }
  const employeeIds = new Set([...summariesByEmployee.keys(), ...adjustmentsByEmployee.keys()]);
  const totals = numericSnapshot({}, PAYROLL_EMPLOYEE_RESOLVED_FIELDS);

  const documents = [...employeeIds].map((employeeId) => {
    const summary: any = summariesByEmployee.get(employeeId);
    const adjustments = adjustmentsByEmployee.get(employeeId) || [];
    const identitySource = summary || adjustments[adjustments.length - 1] || {};
    const currentAttendance = numericSnapshot(summary, PAYROLL_EMPLOYEE_CURRENT_FIELDS);
    const attendanceAdjustments = PAYROLL_EMPLOYEE_RESOLVED_FIELDS.reduce<Record<string, number>>(
      (result, field) => {
        result[field] = roundUnits(
          adjustments.reduce((total, adjustment) => total + Number(adjustment.deltas?.[field] || 0), 0)
        );
        return result;
      },
      {}
    );
    const payrollAttendance = PAYROLL_EMPLOYEE_RESOLVED_FIELDS.reduce<Record<string, number>>(
      (result, field) => {
        result[field] = roundUnits(Number(currentAttendance[field] || 0) + Number(attendanceAdjustments[field] || 0));
        totals[field] = roundUnits(Number(totals[field] || 0) + result[field]);
        return result;
      },
      {}
    );
    const inputIssues: string[] = [];
    if (!summary) inputIssues.push("missing_monthly_summary");
    if (payrollAttendance.paidDays < 0) inputIssues.push("negative_paid_days");
    if (payrollAttendance.unpaidDays < 0) inputIssues.push("negative_unpaid_days");
    if (payrollAttendance.approvedOvertimeMinutes < 0) inputIssues.push("negative_approved_overtime");

    return {
      company: options.run.company,
      payrollRun: options.run._id,
      periodKey: options.run.periodKey,
      employee: identitySource.employee,
      employeeNameSnapshot: text(identitySource.employeeNameSnapshot) || "Employee",
      employeeCodeSnapshot: text(identitySource.employeeCodeSnapshot) || employeeId,
      designationSnapshot: text(summary?.designationSnapshot),
      department: summary?.department || null,
      departmentNameSnapshot: text(summary?.departmentNameSnapshot),
      teamId: summary?.teamId || null,
      teamNameSnapshot: text(summary?.teamNameSnapshot),
      officeLocation: summary?.officeLocation || null,
      officeLocationNameSnapshot: text(summary?.officeLocationNameSnapshot),
      reportingManager: summary?.reportingManager || null,
      reportingManagerNameSnapshot: text(summary?.reportingManagerNameSnapshot),
      attendancePayrollInput: options.run.attendancePayrollInput,
      attendanceMonthlySummary: summary?._id || null,
      attendancePayrollAdjustments: adjustments.map((adjustment) => adjustment._id),
      attendancePeriodVersion: Number(options.run.attendancePeriodVersion),
      currentAttendance,
      attendanceAdjustments,
      payrollAttendance,
      adjustmentSourcePeriods: [...new Set(adjustments.map((adjustment) => text(adjustment.sourcePeriodKey)).filter(Boolean))],
      attendanceAdjustmentCount: adjustments.length,
      inputIssues,
      hasIssues: inputIssues.length > 0,
      preparedAt,
      preparedBy: options.actorId,
    };
  });

  return {
    documents,
    totals,
    issueCount: documents.filter((document) => document.hasIssues).length,
  };
}

export function validatePayrollEmployeeInputReconciliation(options: {
  run: any;
  summaries: any[];
  adjustments: any[];
  totals: Record<string, number>;
}) {
  if (options.summaries.length !== Number(options.run.attendanceSummaryCount || 0)) {
    throw generateError("Locked attendance summary count does not match the payroll run snapshot", 409);
  }
  if (options.adjustments.length !== Number(options.run.attendanceAdjustmentCount || 0)) {
    throw generateError("Locked attendance adjustment count does not match the payroll run snapshot", 409);
  }
  const expected = options.run.attendanceTotals?.payroll || {};
  const mismatch = PAYROLL_EMPLOYEE_RESOLVED_FIELDS.find(
    (field) => roundUnits(options.totals[field]) !== roundUnits(expected[field])
  );
  if (mismatch) {
    throw generateError(
      `Employee attendance inputs do not reconcile with the locked ${mismatch} total`,
      409
    );
  }
}

async function populatedRun(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId | string) {
  return PayrollRun.findOne({ _id: runId, company })
    .populate("createdBy attendanceLockedBy attendanceInputsPreparedBy reviewSubmittedBy reviewDecidedBy finalizedBy reopenedBy", "name username code role")
    .lean();
}

export async function preparePayrollEmployeeInputsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(
      req,
      req.body?.companyId,
      true,
      "prepare payroll attendance inputs for this company"
    );
    const actorId = getPayrollActorId(req);
    const runId = text(req.params.runId);
    if (!mongoose.Types.ObjectId.isValid(runId)) throw generateError("Invalid payroll run id", 400);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw generateError("Expected payroll run version is required", 422);
    }
    let prepared = false;

    await mongoose.connection.transaction(async (session) => {
      const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).session(session).lean();
      if (!run) throw generateError("Payroll run not found", 404);
      if (run.attendanceInputStatus === "prepared") return;
      if (run.status !== "draft") throw generateError("Attendance inputs can only be prepared for a draft payroll run", 409);
      if (Number(run.version) !== expectedVersion) {
        throw generateError("Payroll run changed. Refresh and try again", 409);
      }

      const summaries: any[] = await AttendanceMonthlySummary.find({
        company: companyObjectId,
        attendancePeriod: run.attendancePeriod,
        periodKey: run.periodKey,
        attendancePeriodVersion: run.attendancePeriodVersion,
      })
        .select("-daily")
        .sort({ employeeCodeSnapshot: 1 })
        .session(session)
        .lean();
      const adjustments: any[] = await AttendancePayrollAdjustment.find({
        company: companyObjectId,
        includedInPayrollInput: run.attendancePayrollInput,
        status: "included",
      })
        .sort({ employeeCodeSnapshot: 1, sourcePeriodKey: 1 })
        .session(session)
        .lean();
      const built = buildPayrollEmployeeInputs({ run, summaries, adjustments, actorId });
      validatePayrollEmployeeInputReconciliation({ run, summaries, adjustments, totals: built.totals });

      for (let index = 0; index < built.documents.length; index += 500) {
        await PayrollEmployeeInput.insertMany(built.documents.slice(index, index + 500), {
          session,
          ordered: true,
        });
      }
      const preparedAt = built.documents[0]?.preparedAt || new Date();
      const update = await PayrollRun.updateOne(
        {
          _id: run._id,
          company: companyObjectId,
          status: "draft",
          attendanceInputStatus: { $in: ["pending", null] },
          version: expectedVersion,
        },
        {
          $set: {
            attendanceInputStatus: "prepared",
            employeeInputCount: built.documents.length,
            employeeInputIssueCount: built.issueCount,
            attendanceInputTotals: built.totals,
            attendanceInputsPreparedAt: preparedAt,
            attendanceInputsPreparedBy: actorId,
          },
          $inc: { version: 1 },
        },
        { session }
      );
      if (update.modifiedCount !== 1) {
        throw generateError("Payroll run changed while attendance inputs were being prepared", 409);
      }
      await writePayrollAudit(
        {
          company: companyObjectId,
          entityType: "payroll_run",
          entityId: run._id,
          action: "attendance_inputs_prepared",
          actor: actorId,
          details: {
            periodKey: run.periodKey,
            attendancePayrollInput: run.attendancePayrollInput,
            attendancePayrollInputVersion: run.attendancePayrollInputVersion,
            employeeInputCount: built.documents.length,
            issueCount: built.issueCount,
            totals: built.totals,
          },
        },
        session
      );
      prepared = true;
    });

    const run = await populatedRun(companyObjectId, runId);
    return res.status(prepared ? 201 : 200).json({
      success: true,
      message: prepared ? "Payroll attendance inputs imported" : "Payroll attendance inputs were already imported",
      data: run,
    });
  } catch (error) {
    next(error);
  }
}

export async function listPayrollEmployeeInputsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const runId = text(req.params.runId);
    if (!mongoose.Types.ObjectId.isValid(runId)) throw generateError("Invalid payroll run id", 400);
    const page = pageNumber(req.query?.page, 1, 100_000);
    const limit = pageNumber(req.query?.limit, 25, 100);
    const search = text(req.query?.search);
    const issues = text(req.query?.issues || "all").toLowerCase();
    if (!["all", "with_issues", "clean"].includes(issues)) {
      throw generateError("Invalid payroll input issue filter", 422);
    }
    const run = await populatedRun(companyObjectId, runId);
    if (!run) throw generateError("Payroll run not found", 404);
    const searchRegex = search ? new RegExp(escapeRegex(search), "i") : null;
    const match: any = {
      company: companyObjectId,
      payrollRun: new mongoose.Types.ObjectId(runId),
      ...(issues === "all" ? {} : { hasIssues: issues === "with_issues" }),
      ...(searchRegex
        ? { $or: [{ employeeNameSnapshot: searchRegex }, { employeeCodeSnapshot: searchRegex }] }
        : {}),
    };
    const [items, total] = await Promise.all([
      PayrollEmployeeInput.find(match)
        .sort({ employeeCodeSnapshot: 1, employeeNameSnapshot: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PayrollEmployeeInput.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: { run, items },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}
