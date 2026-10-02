import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendancePayrollInput from "../../schemas/Attendance/AttendancePayrollInput.schema";
import Company from "../../schemas/company/Company";
import PayrollRun, { PAYROLL_RUN_STATUSES } from "../../schemas/Payroll/PayrollRun.schema";
import { parseAttendancePeriodKey } from "../attendance/attendancePeriod.service";
import {
  ensurePayrollRunManager,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";

function text(value: unknown) {
  return String(value ?? "").trim();
}

function requiredReason(value: unknown) {
  const reason = text(value);
  if (reason.length < 3 || reason.length > 500) {
    throw generateError("Payroll preparation reason must contain 3 to 500 characters", 422);
  }
  return reason;
}

function pageNumber(value: unknown, fallback: number, maximum: number) {
  const parsed = Number.parseInt(text(value), 10);
  return Math.min(maximum, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

export function buildPayrollRunDocument(options: {
  company: any;
  input: any;
  actorId: mongoose.Types.ObjectId;
  reason: string;
}) {
  const settings = options.company?.payrollSettings || {};
  return {
    company: options.company._id,
    companyNameSnapshot: text(options.company.company_name),
    companyCodeSnapshot: text(options.company.companyCode).toUpperCase(),
    periodKey: options.input.periodKey,
    cycleStartDate: options.input.cycleStartDate,
    cycleEndDate: options.input.cycleEndDate,
    attendancePayrollInput: options.input._id,
    attendancePayrollInputVersion: Number(options.input.version),
    attendancePeriod: options.input.attendancePeriod,
    attendancePeriodVersion: Number(options.input.attendancePeriodVersion),
    attendanceCutoffDay: Number(options.input.attendanceCutoffDay),
    attendanceSummaryCount: Number(options.input.summaryCount || 0),
    attendanceAdjustmentCount: Number(options.input.adjustmentCount || 0),
    attendanceTotals: options.input.totals || {},
    attendanceLockedAt: options.input.lockedAt,
    attendanceLockedBy: options.input.lockedBy,
    attendanceInputStatus: "pending" as const,
    employeeInputCount: 0,
    employeeInputIssueCount: 0,
    attendanceInputTotals: {},
    oneTimeInputCount: 0,
    oneTimeInputTotals: {
      earningsMinor: 0,
      deductionsMinor: 0,
      reimbursementsMinor: 0,
      arrearsMinor: 0,
      recoveriesMinor: 0,
      netImpactMinor: 0,
    },
    employeeSnapshotStatus: "pending" as const,
    employeeSnapshotVersion: 0,
    employeeSnapshotCount: 0,
    employeeSnapshotIssueCount: 0,
    employeeSnapshotErrorCount: 0,
    employeeSnapshotWarningCount: 0,
    employeeSnapshotCompensationTotals: {},
    calculationStatus: "pending" as const,
    calculationVersion: 0,
    calculationEmployeeSnapshotVersion: 0,
    calculationOneTimeInputCount: 0,
    payrollResultCount: 0,
    payrollResultIssueCount: 0,
    payrollResultErrorCount: 0,
    payrollResultWarningCount: 0,
    payrollResultTotals: {},
    currency: text(settings.currency || "INR").toUpperCase(),
    currencyMinorUnits: Number(settings.currencyMinorUnits ?? 2),
    payFrequency: "monthly" as const,
    payDay: Number(settings.payDay || 31),
    roundingMode: text(settings.roundingMode || "nearest").toLowerCase(),
    status: "draft" as const,
    preparationReason: options.reason,
    version: 1,
    createdBy: options.actorId,
  };
}

async function populatedRun(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId | string) {
  return PayrollRun.findOne({ _id: runId, company })
    .populate("createdBy attendanceLockedBy attendanceInputsPreparedBy", "name username code role")
    .lean();
}

export async function listPayrollRunsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const page = pageNumber(req.query?.page, 1, 100_000);
    const limit = pageNumber(req.query?.limit, 20, 100);
    const status = text(req.query?.status || "all").toLowerCase();
    const periodKey = text(req.query?.periodKey);
    if (status !== "all" && !PAYROLL_RUN_STATUSES.includes(status as any)) {
      throw generateError("Invalid payroll run status filter", 422);
    }
    if (periodKey) parseAttendancePeriodKey(periodKey);

    const match: any = {
      company: companyObjectId,
      ...(status === "all" ? {} : { status }),
      ...(periodKey ? { periodKey } : {}),
    };
    const [runs, total] = await Promise.all([
      PayrollRun.find(match)
        .sort({ periodKey: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("createdBy attendanceLockedBy", "name username code role")
        .lean(),
      PayrollRun.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: runs,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}

export async function getPayrollRunSourceService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const periodKey = parseAttendancePeriodKey(req.params.periodKey).periodKey;
    const [input, existingRun] = await Promise.all([
      AttendancePayrollInput.findOne({ company: companyObjectId, periodKey, status: "locked" })
        .populate("lockedBy", "name username code role")
        .lean(),
      PayrollRun.findOne({ company: companyObjectId, periodKey })
        .select("_id periodKey status version createdAt")
        .lean(),
    ]);
    const blocker = existingRun
      ? "A payroll run already exists for this period"
      : input
        ? null
        : "Lock the attendance payroll input for this period before creating a payroll run";
    return res.status(200).json({
      success: true,
      data: { periodKey, canCreate: Boolean(input && !existingRun), blocker, input, existingRun },
    });
  } catch (error) {
    next(error);
  }
}

export async function getPayrollRunService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const runId = text(req.params.runId);
    if (!mongoose.Types.ObjectId.isValid(runId)) throw generateError("Invalid payroll run id", 400);
    const run = await populatedRun(companyObjectId, runId);
    if (!run) throw generateError("Payroll run not found", 404);
    return res.status(200).json({ success: true, data: run });
  } catch (error) {
    next(error);
  }
}

export async function createPayrollRunService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(
      req,
      req.body?.companyId,
      true,
      "create payroll runs for this company"
    );
    const actorId = getPayrollActorId(req);
    const periodKey = parseAttendancePeriodKey(req.body?.periodKey).periodKey;
    const reason = requiredReason(req.body?.preparationReason);
    let runId: mongoose.Types.ObjectId | null = null;
    let created = false;

    try {
      await mongoose.connection.transaction(async (session) => {
        const existing: any = await PayrollRun.findOne({ company: companyObjectId, periodKey })
          .session(session)
          .lean();
        if (existing) {
          runId = existing._id;
          return;
        }
        const input: any = await AttendancePayrollInput.findOne({
          company: companyObjectId,
          periodKey,
          status: "locked",
        }).session(session).lean();
        if (!input) {
          throw generateError("Lock the attendance payroll input for this period before creating a payroll run", 409);
        }
        const company: any = await Company.findById(companyObjectId)
          .select("company_name companyCode payrollSettings")
          .session(session)
          .lean();
        if (!company) throw generateError("Company not found", 404);
        const [run]: any[] = await PayrollRun.create(
          [buildPayrollRunDocument({ company, input, actorId, reason })],
          { session }
        );
        await writePayrollAudit({
          company: companyObjectId,
          entityType: "payroll_run",
          entityId: run._id,
          action: "created",
          actor: actorId,
          reason,
          details: {
            periodKey,
            attendancePayrollInput: input._id,
            attendancePayrollInputVersion: input.version,
            attendancePeriodVersion: input.attendancePeriodVersion,
          },
        }, session);
        runId = run._id;
        created = true;
      });
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      const existing: any = await PayrollRun.findOne({ company: companyObjectId, periodKey }).select("_id").lean();
      if (!existing) throw error;
      runId = existing._id;
    }

    if (!runId) throw generateError("Payroll run could not be created", 500);
    const run = await populatedRun(companyObjectId, runId);
    return res.status(created ? 201 : 200).json({
      success: true,
      message: created ? `Draft payroll run created for ${periodKey}` : `Payroll run for ${periodKey} already exists`,
      data: run,
    });
  } catch (error) {
    next(error);
  }
}
