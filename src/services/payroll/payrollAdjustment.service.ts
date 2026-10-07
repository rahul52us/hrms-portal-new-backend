import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import PayrollEmployeeInput from "../../schemas/Payroll/PayrollEmployeeInput.schema";
import PayrollFinalizedResult from "../../schemas/Payroll/PayrollFinalizedResult.schema";
import PayrollOneTimeInput, { PayrollOneTimeInputType } from "../../schemas/Payroll/PayrollOneTimeInput.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import SalaryComponent from "../../schemas/Payroll/SalaryComponent.schema";
import {
  buildPayrollOneTimeInputDocument,
  oneTimeInputComponentCategory,
  oneTimeInputRunDelta,
  parsePayrollAmountToMinor,
} from "./payrollOneTimeInput.service";
import {
  ensurePayrollRunManager,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";

const text = (value: unknown) => String(value ?? "").trim();
const id = (value: any) => String(value?._id || value || "");

function objectId(value: unknown, label: string) {
  const normalized = text(value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function requiredVersion(value: unknown, label: string) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw generateError(`${label} is required`, 422);
  return version;
}

function requiredReason(value: unknown) {
  const reason = text(value);
  if (reason.length < 3 || reason.length > 500) {
    throw generateError("Correction reason must contain 3 to 500 characters", 422);
  }
  return reason;
}

export function payrollAdjustmentBlocker(sourceRun: any, sourceResult: any, targetRun: any) {
  if (sourceRun.status !== "finalized") return "Corrections can only be routed from a currently finalized payroll run";
  if (Number(sourceRun.finalizationVersion || 0) !== Number(sourceResult.finalizationVersion || 0)) {
    return "Corrections must use the current finalized payroll version";
  }
  if (targetRun.status !== "draft") return "The target payroll run must be a draft";
  if (targetRun.attendanceInputStatus !== "prepared") return "Import attendance inputs in the target payroll run first";
  if (text(targetRun.periodKey) <= text(sourceRun.periodKey)) return "The target payroll run must be for a later period";
  if (
    text(targetRun.currency).toUpperCase() !== text(sourceRun.currency).toUpperCase() ||
    Number(targetRun.currencyMinorUnits) !== Number(sourceRun.currencyMinorUnits)
  ) {
    return "Source and target payroll runs must use the same currency settings";
  }
  return null;
}

export function buildFinalizedCorrectionInputDocument(options: {
  sourceRun: any;
  sourceResult: any;
  targetRun: any;
  employeeInput: any;
  component: any;
  actorId: mongoose.Types.ObjectId;
  inputType: "arrear" | "recovery";
  amountMinor: number;
  reason: string;
  reference: string;
  idempotencyKey: string;
}) {
  return {
    ...buildPayrollOneTimeInputDocument({
      run: options.targetRun,
      employeeInput: options.employeeInput,
      component: options.component,
      actorId: options.actorId,
      inputType: options.inputType,
      amountMinor: options.amountMinor,
      reason: options.reason,
      reference: options.reference,
      idempotencyKey: options.idempotencyKey,
    }),
    sourceType: "finalized_correction" as const,
    sourcePayrollRun: options.sourceRun._id,
    sourcePeriodKey: options.sourceRun.periodKey,
    sourceFinalizationVersion: options.sourceResult.finalizationVersion,
    sourceFinalizedResult: options.sourceResult._id,
  };
}

function sameCorrectionPayload(existing: any, payload: any) {
  return existing.sourceType === "finalized_correction"
    && id(existing.sourcePayrollRun) === id(payload.sourceRunId)
    && id(existing.sourceFinalizedResult) === id(payload.sourceResultId)
    && Number(existing.sourceFinalizationVersion) === Number(payload.sourceFinalizationVersion)
    && id(existing.employee) === id(payload.employeeId)
    && id(existing.salaryComponent) === id(payload.componentId)
    && existing.inputType === payload.inputType
    && Number(existing.amountMinor) === Number(payload.amountMinor)
    && text(existing.reason) === payload.reason
    && text(existing.reference) === payload.reference;
}

async function populatedRun(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId) {
  return PayrollRun.findOne({ _id: runId, company })
    .populate(
      "createdBy attendanceLockedBy attendanceInputsPreparedBy employeeSnapshotsPreparedBy calculatedBy reviewSubmittedBy reviewDecidedBy finalizedBy reopenedBy",
      "name username code role"
    )
    .lean();
}

async function populatedInput(company: mongoose.Types.ObjectId, inputId: mongoose.Types.ObjectId) {
  return PayrollOneTimeInput.findOne({ _id: inputId, company })
    .populate("createdBy cancelledBy", "name username code role")
    .lean();
}

async function loadSource(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId, resultId: mongoose.Types.ObjectId) {
  const [sourceRun, sourceResult] = await Promise.all([
    PayrollRun.findOne({ _id: runId, company }).lean(),
    PayrollFinalizedResult.findOne({ _id: resultId, company, payrollRun: runId }).lean(),
  ]);
  if (!sourceRun) throw generateError("Source payroll run not found", 404);
  if (!sourceResult) throw generateError("Finalized employee payroll result not found", 404);
  if (sourceRun.status !== "finalized") {
    throw generateError("Corrections can only be routed from a currently finalized payroll run", 409);
  }
  if (Number(sourceRun.finalizationVersion || 0) !== Number(sourceResult.finalizationVersion || 0)) {
    throw generateError("Corrections must use the current finalized payroll version", 409);
  }
  return { sourceRun, sourceResult };
}

export async function getPayrollAdjustmentOptionsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const sourceRunId = objectId(req.params.runId, "source payroll run id");
    const sourceResultId = objectId(req.params.resultId, "finalized payroll result id");
    const { sourceRun, sourceResult } = await loadSource(companyObjectId, sourceRunId, sourceResultId);

    const candidates: any[] = await PayrollRun.find({
      company: companyObjectId,
      periodKey: { $gt: sourceRun.periodKey },
      status: "draft",
      attendanceInputStatus: "prepared",
      currency: sourceRun.currency,
      currencyMinorUnits: sourceRun.currencyMinorUnits,
    })
      .sort({ periodKey: 1, createdAt: 1 })
      .limit(50)
      .select("periodKey cycleStartDate cycleEndDate version calculationStatus currency currencyMinorUnits")
      .lean();
    const candidateIds = candidates.map((run) => run._id);
    const eligibleRunIds = candidateIds.length
      ? await PayrollEmployeeInput.distinct("payrollRun", {
          company: companyObjectId,
          payrollRun: { $in: candidateIds },
          employee: sourceResult.employee,
        })
      : [];
    const eligible = new Set(eligibleRunIds.map(id));
    const targetRuns = candidates.filter((run) => eligible.has(id(run._id)));
    const components = await SalaryComponent.find({
      company: companyObjectId,
      status: "active",
      category: { $in: ["earning", "deduction"] },
    })
      .sort({ category: 1, displayOrder: 1, name: 1 })
      .limit(200)
      .select("name code category taxable")
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        source: {
          payrollRun: sourceRun._id,
          runVersion: sourceRun.version,
          periodKey: sourceRun.periodKey,
          finalizationVersion: sourceResult.finalizationVersion,
          finalizedResult: sourceResult._id,
          employee: sourceResult.employee,
          identity: sourceResult.identity,
          currency: sourceResult.currency,
          currencyMinorUnits: sourceResult.currencyMinorUnits,
        },
        targetRuns,
        components,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function createPayrollAdjustmentService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(
      req,
      req.body?.companyId,
      true,
      "route this finalized payroll correction"
    );
    const actorId = getPayrollActorId(req);
    const sourceRunId = objectId(req.params.runId, "source payroll run id");
    const sourceResultId = objectId(req.params.resultId, "finalized payroll result id");
    const targetRunId = objectId(req.body?.targetPayrollRunId, "target payroll run id");
    const componentId = objectId(req.body?.salaryComponentId, "salary component id");
    const sourceVersion = requiredVersion(req.body?.expectedSourceRunVersion, "Expected source payroll run version");
    const targetVersion = requiredVersion(req.body?.expectedTargetRunVersion, "Expected target payroll run version");
    const inputType = text(req.body?.inputType).toLowerCase() as PayrollOneTimeInputType;
    if (!["arrear", "recovery"].includes(inputType)) {
      throw generateError("Finalized corrections must be routed as an arrear or recovery", 422);
    }
    const reason = requiredReason(req.body?.reason);
    const reference = text(req.body?.reference);
    if (reference.length > 100) throw generateError("Reference cannot exceed 100 characters", 422);
    const idempotencyKey = text(req.body?.idempotencyKey);
    if (idempotencyKey.length < 8 || idempotencyKey.length > 100) {
      throw generateError("Idempotency key must contain 8 to 100 characters", 422);
    }

    let inputId: mongoose.Types.ObjectId | null = null;
    let created = false;
    let normalizedPayload: any = null;

    try {
      await mongoose.connection.transaction(async (session) => {
        const [sourceRun, sourceResult, targetRun]: any[] = await Promise.all([
          PayrollRun.findOne({ _id: sourceRunId, company: companyObjectId }).session(session).lean(),
          PayrollFinalizedResult.findOne({ _id: sourceResultId, company: companyObjectId, payrollRun: sourceRunId }).session(session).lean(),
          PayrollRun.findOne({ _id: targetRunId, company: companyObjectId }).session(session).lean(),
        ]);
        if (!sourceRun) throw generateError("Source payroll run not found", 404);
        if (!sourceResult) throw generateError("Finalized employee payroll result not found", 404);
        if (!targetRun) throw generateError("Target payroll run not found", 404);
        const amountMinor = parsePayrollAmountToMinor(req.body?.amount, Number(targetRun.currencyMinorUnits));
        normalizedPayload = {
          sourceRunId,
          sourceResultId,
          sourceFinalizationVersion: sourceResult.finalizationVersion,
          employeeId: sourceResult.employee,
          componentId,
          inputType,
          amountMinor,
          reason,
          reference,
        };
        const existing: any = await PayrollOneTimeInput.findOne({
          company: companyObjectId,
          payrollRun: targetRunId,
          idempotencyKey,
        }).session(session).lean();
        if (existing) {
          if (!sameCorrectionPayload(existing, normalizedPayload)) {
            throw generateError("Idempotency key was already used for a different payroll input", 409);
          }
          inputId = existing._id;
          return;
        }
        if (Number(sourceRun.version) !== sourceVersion) throw generateError("Source payroll run changed. Refresh and try again", 409);
        if (Number(targetRun.version) !== targetVersion) throw generateError("Target payroll run changed. Refresh and try again", 409);
        const blocker = payrollAdjustmentBlocker(sourceRun, sourceResult, targetRun);
        if (blocker) throw generateError(blocker, 409);

        const [employeeInput, component]: any[] = await Promise.all([
          PayrollEmployeeInput.findOne({
            company: companyObjectId,
            payrollRun: targetRunId,
            employee: sourceResult.employee,
          }).session(session).lean(),
          SalaryComponent.findOne({ _id: componentId, company: companyObjectId, status: "active" }).session(session).lean(),
        ]);
        if (!employeeInput) throw generateError("Employee is not included in the target payroll run", 409);
        if (!component) throw generateError("Active salary component not found", 404);
        const requiredCategory = oneTimeInputComponentCategory(inputType);
        if (component.category !== requiredCategory) {
          throw generateError(`${inputType} corrections require a ${requiredCategory} component`, 422);
        }

        const [input]: any[] = await PayrollOneTimeInput.create([buildFinalizedCorrectionInputDocument({
          sourceRun,
          sourceResult,
          targetRun,
          employeeInput,
          component,
          actorId,
          inputType: inputType as "arrear" | "recovery",
          amountMinor,
          reason,
          reference,
          idempotencyKey,
        })], { session });
        const delta = oneTimeInputRunDelta(inputType, amountMinor);
        const targetUpdate = await PayrollRun.updateOne(
          { _id: targetRunId, company: companyObjectId, status: "draft", version: targetVersion },
          {
            $set: { calculationStatus: Number(targetRun.calculationVersion || 0) > 0 ? "stale" : "pending" },
            $inc: {
              version: 1,
              oneTimeInputCount: 1,
              ...Object.fromEntries(Object.entries(delta).map(([key, value]) => [`oneTimeInputTotals.${key}`, value])),
            },
          },
          { session }
        );
        if (targetUpdate.modifiedCount !== 1) throw generateError("Target payroll run changed while the correction was being added", 409);
        const sourceUpdate = await PayrollRun.updateOne(
          {
            _id: sourceRunId,
            company: companyObjectId,
            status: "finalized",
            version: sourceVersion,
            finalizationVersion: sourceResult.finalizationVersion,
          },
          { $inc: { version: 1 } },
          { session }
        );
        if (sourceUpdate.modifiedCount !== 1) throw generateError("Source payroll run changed while the correction was being routed", 409);

        const auditDetails = {
          sourcePayrollRun: sourceRun._id,
          sourcePeriodKey: sourceRun.periodKey,
          sourceFinalizationVersion: sourceResult.finalizationVersion,
          sourceFinalizedResult: sourceResult._id,
          targetPayrollRun: targetRun._id,
          targetPeriodKey: targetRun.periodKey,
          employee: sourceResult.employee,
          employeeCode: sourceResult.identity?.code,
          inputType,
          salaryComponent: component._id,
          componentCode: component.code,
          amountMinor,
          currency: targetRun.currency,
          reference,
        };
        await writePayrollAudit({
          company: companyObjectId,
          entityType: "payroll_input",
          entityId: input._id,
          action: "finalized_correction_created",
          actor: actorId,
          reason,
          details: auditDetails,
        }, session);
        await writePayrollAudit({
          company: companyObjectId,
          entityType: "payroll_run",
          entityId: sourceRun._id,
          action: "correction_routed_to_future_run",
          actor: actorId,
          reason,
          details: auditDetails,
        }, session);
        inputId = input._id;
        created = true;
      });
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      const existing: any = await PayrollOneTimeInput.findOne({
        company: companyObjectId,
        payrollRun: targetRunId,
        idempotencyKey,
      }).lean();
      if (!existing || !normalizedPayload || !sameCorrectionPayload(existing, normalizedPayload)) throw error;
      inputId = existing._id;
    }

    if (!inputId) throw generateError("Future payroll correction could not be created", 500);
    const [input, sourceRun, targetRun] = await Promise.all([
      populatedInput(companyObjectId, inputId),
      populatedRun(companyObjectId, sourceRunId),
      populatedRun(companyObjectId, targetRunId),
    ]);
    return res.status(created ? 201 : 200).json({
      success: true,
      message: created
        ? "Correction routed to the future payroll run"
        : "This future payroll correction already exists",
      data: { input, sourceRun, targetRun },
    });
  } catch (error) {
    next(error);
  }
}
