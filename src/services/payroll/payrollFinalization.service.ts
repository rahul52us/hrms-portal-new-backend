import { createHash } from "node:crypto";
import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import EmployeePayrollResult from "../../schemas/Payroll/EmployeePayrollResult.schema";
import PayrollFinalizedResult from "../../schemas/Payroll/PayrollFinalizedResult.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import PayrollValidationDecision from "../../schemas/Payroll/PayrollValidationDecision.schema";
import { PAYROLL_RESULT_TOTAL_FIELDS } from "./payrollCalculation.service";
import {
  ensurePayrollRunFinalizer,
  ensurePayrollRunManager,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";
import { getPayrollReviewStatistics, payrollReviewBlockers } from "./payrollRunReview.service";

const text = (value: unknown) => String(value ?? "").trim();
const id = (value: any) => String(value?._id || value || "");

function objectId(value: unknown, label: string) {
  const normalized = text(value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function requiredReason(value: unknown) {
  const reason = text(value);
  if (reason.length < 3 || reason.length > 500) {
    throw generateError("Finalization reason must contain 3 to 500 characters", 422);
  }
  return reason;
}

function expectedVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw generateError("Expected payroll run version is required", 422);
  }
  return version;
}

function pageNumber(value: unknown, fallback: number, maximum: number) {
  const parsed = Number.parseInt(text(value), 10);
  return Math.min(maximum, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

function canonical(value: any): any {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toHexString === "function") return value.toHexString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.keys(value).sort().reduce<Record<string, any>>((result, key) => {
      result[key] = canonical(value[key]);
      return result;
    }, {});
  }
  return value;
}

export function finalizedPayrollSnapshotHash(value: any) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function decisionKey(resultId: unknown, category: unknown, code: unknown) {
  return `${id(resultId)}:${text(category)}:${text(code)}`;
}

export function buildFinalizedPayrollDocuments(options: {
  run: any;
  results: any[];
  decisions: any[];
  actorId: mongoose.Types.ObjectId;
  finalizedAt: Date;
  finalizationVersion: number;
}) {
  const latestDecisions = new Map<string, any>();
  for (const decision of options.decisions) {
    latestDecisions.set(
      decisionKey(decision.employeePayrollResult, decision.issueCategory, decision.issueCode),
      decision
    );
  }

  return options.results.map((result) => {
    const validationDecisions = (result.issues || [])
      .filter((issue: any) => issue.severity === "warning")
      .map((issue: any) => latestDecisions.get(decisionKey(result._id, issue.category, issue.code)))
      .filter(Boolean)
      .map((decision: any) => ({
        payrollValidationDecision: decision._id,
        issueCode: decision.issueCode,
        issueCategory: decision.issueCategory,
        action: decision.action,
        reason: decision.reason,
        actor: decision.actor,
        actorNameSnapshot: decision.actorNameSnapshot,
        actorCodeSnapshot: decision.actorCodeSnapshot || "",
        decidedAt: decision.createdAt,
      }));
    const snapshot = {
      company: options.run.company,
      payrollRun: options.run._id,
      periodKey: options.run.periodKey,
      finalizationVersion: options.finalizationVersion,
      sourceEmployeePayrollResult: result._id,
      sourceCalculationVersion: result.calculationVersion,
      calculationSourceRunVersion: result.sourceRunVersion,
      employeeSnapshotVersion: result.employeeSnapshotVersion,
      employee: result.employee,
      identity: result.identity,
      organization: result.organization,
      payrollDays: result.payrollDays,
      recurringComponents: result.recurringComponents || [],
      oneTimeInputs: result.oneTimeInputs || [],
      statutoryContributions: result.statutoryContributions || [],
      totals: result.totals,
      issues: result.issues || [],
      validationDecisions,
      currency: options.run.currency,
      currencyMinorUnits: options.run.currencyMinorUnits,
      calculatedAt: result.calculatedAt,
      calculatedBy: result.calculatedBy,
      finalizedAt: options.finalizedAt,
      finalizedBy: options.actorId,
    };
    return { ...snapshot, snapshotHash: finalizedPayrollSnapshotHash(snapshot) };
  });
}

export function reconcileFinalizedPayrollDocuments(documents: any[], expectedCount: number, expectedTotals: any) {
  if (documents.length !== expectedCount) {
    throw new Error("Finalized payroll employee count does not match the approved run");
  }
  const totals = Object.fromEntries(PAYROLL_RESULT_TOTAL_FIELDS.map((field) => [field, 0])) as Record<string, number>;
  for (const document of documents) {
    for (const field of PAYROLL_RESULT_TOTAL_FIELDS) {
      const amount = Number(document.totals?.[field] ?? 0);
      if (!Number.isSafeInteger(amount)) throw new Error(`Finalized payroll ${field} is not a safe integer`);
      const next = totals[field] + amount;
      if (!Number.isSafeInteger(next)) throw new Error(`Finalized payroll ${field} exceeds the supported range`);
      totals[field] = next;
    }
  }
  for (const field of PAYROLL_RESULT_TOTAL_FIELDS) {
    if (totals[field] !== Number(expectedTotals?.[field] || 0)) {
      throw new Error(`Finalized payroll ${field} does not reconcile with the approved run`);
    }
  }
  return totals;
}

async function populatedRun(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId) {
  return PayrollRun.findOne({ _id: runId, company })
    .populate(
      "createdBy attendanceLockedBy attendanceInputsPreparedBy employeeSnapshotsPreparedBy calculatedBy reviewSubmittedBy reviewDecidedBy finalizedBy reopenedBy",
      "name username code role"
    )
    .lean();
}

export async function finalizePayrollRunService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunFinalizer(req);
    const { companyObjectId } = await resolvePayrollCompany(
      req,
      req.body?.companyId,
      true,
      "finalize this payroll run"
    );
    const actorId = getPayrollActorId(req);
    const runId = objectId(req.params.runId, "payroll run id");
    const version = expectedVersion(req.body?.expectedVersion);
    const reason = requiredReason(req.body?.reason);
    let alreadyFinalized = false;

    await mongoose.connection.transaction(async (session) => {
      const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).session(session).lean();
      if (!run) throw generateError("Payroll run not found", 404);
      if (run.status === "finalized") {
        alreadyFinalized = true;
        return;
      }
      if (run.status !== "approved" || run.reviewDecision !== "approved") {
        throw generateError("Payroll must complete independent approval before finalization", 409);
      }
      if (Number(run.version) !== version) throw generateError("Payroll run changed. Refresh and try again", 409);
      if (Number(run.reviewCalculationVersion || 0) !== Number(run.calculationVersion || 0)) {
        throw generateError("The approved calculation version does not match the current payroll calculation", 409);
      }

      const statistics = await getPayrollReviewStatistics(companyObjectId, run, session);
      const blockers = payrollReviewBlockers(run, statistics);
      if (blockers.length) throw generateError(`Payroll cannot be finalized: ${blockers.join("; ")}`, 409);

      const results: any[] = await EmployeePayrollResult.find({
        company: companyObjectId,
        payrollRun: run._id,
        calculationVersion: run.calculationVersion,
      }).sort({ "identity.code": 1, _id: 1 }).session(session).lean();
      const decisions: any[] = await PayrollValidationDecision.find({
        company: companyObjectId,
        payrollRun: run._id,
        calculationVersion: run.calculationVersion,
      }).sort({ createdAt: 1, _id: 1 }).session(session).lean();
      const finalizationVersion = Number(run.finalizationVersion || 0) + 1;
      const finalizedAt = new Date();
      const documents = buildFinalizedPayrollDocuments({
        run,
        results,
        decisions,
        actorId,
        finalizedAt,
        finalizationVersion,
      });
      const totals = reconcileFinalizedPayrollDocuments(
        documents,
        Number(run.payrollResultCount || 0),
        run.payrollResultTotals || {}
      );

      for (let index = 0; index < documents.length; index += 500) {
        await PayrollFinalizedResult.insertMany(documents.slice(index, index + 500), { session, ordered: true });
      }

      const update = await PayrollRun.updateOne(
        { _id: run._id, company: companyObjectId, status: "approved", version },
        {
          $set: {
            status: "finalized",
            finalizationVersion,
            finalizedResultCount: documents.length,
            finalizedTotals: totals,
            finalizedAt,
            finalizedBy: actorId,
            finalizationReason: reason,
          },
          $inc: { version: 1 },
        },
        { session }
      );
      if (update.modifiedCount !== 1) throw generateError("Payroll run changed while it was being finalized", 409);

      await writePayrollAudit({
        company: companyObjectId,
        entityType: "payroll_run",
        entityId: run._id,
        action: "finalized",
        actor: actorId,
        reason,
        details: {
          periodKey: run.periodKey,
          finalizationVersion,
          calculationVersion: run.calculationVersion,
          employeeCount: documents.length,
          totals,
          sourceRunVersion: version,
        },
      }, session);
    });

    return res.status(200).json({
      success: true,
      message: alreadyFinalized ? "Payroll run is already finalized" : "Payroll finalized with immutable employee results",
      data: await populatedRun(companyObjectId, runId),
    });
  } catch (error) {
    next(error);
  }
}

export async function listFinalizedPayrollResultsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const runId = objectId(req.params.runId, "payroll run id");
    const page = pageNumber(req.query?.page, 1, 100_000);
    const limit = pageNumber(req.query?.limit, 25, 100);
    const search = text(req.query?.search);
    const run: any = await populatedRun(companyObjectId, runId);
    if (!run) throw generateError("Payroll run not found", 404);
    const requestedFinalizationVersion = req.query?.finalizationVersion === undefined
      ? Number(run.finalizationVersion || 0)
      : Number(req.query.finalizationVersion);
    if (!Number.isInteger(requestedFinalizationVersion) || requestedFinalizationVersion < 1 || requestedFinalizationVersion > Number(run.finalizationVersion || 0)) {
      throw generateError("Invalid payroll finalization version", 422);
    }
    const regex = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
    const match: any = {
      company: companyObjectId,
      payrollRun: runId,
      finalizationVersion: requestedFinalizationVersion,
      ...(regex ? {
        $or: [
          { "identity.name": regex },
          { "identity.code": regex },
          { "organization.designation": regex },
          { "organization.departmentName": regex },
          { "organization.teamName": regex },
          { "organization.officeLocationName": regex },
        ],
      } : {}),
    };
    const [items, total] = await Promise.all([
      PayrollFinalizedResult.find(match)
        .sort({ "identity.code": 1, "identity.name": 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PayrollFinalizedResult.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: { run, finalizationVersion: requestedFinalizationVersion, items },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}
