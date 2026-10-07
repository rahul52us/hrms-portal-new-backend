import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import {
  ensurePayrollRunReopener,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";

const text = (value: unknown) => String(value ?? "").trim();

function objectId(value: unknown, label: string) {
  const normalized = text(value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function expectedVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw generateError("Expected payroll run version is required", 422);
  }
  return version;
}

function requiredReason(value: unknown) {
  const reason = text(value);
  if (reason.length < 3 || reason.length > 500) {
    throw generateError("Reopen reason must contain 3 to 500 characters", 422);
  }
  return reason;
}

export function payrollReopenBlocker(run: any) {
  if (run.status !== "finalized") return "Only a finalized payroll run can be reopened";
  if (!Number.isInteger(Number(run.finalizationVersion)) || Number(run.finalizationVersion) < 1) {
    return "Finalized payroll snapshot metadata is missing";
  }
  if (text(run.payoutStatus || "not_started").toLowerCase() !== "not_started") {
    return "Payroll cannot be reopened after payout processing has started";
  }
  return null;
}

export function buildPayrollReopenUpdate(options: {
  actorId: mongoose.Types.ObjectId;
  reason: string;
  reopenedAt: Date;
  finalizationVersion: number;
}) {
  return {
    $set: {
      status: "draft",
      payoutStatus: "not_started",
      reopenedAt: options.reopenedAt,
      reopenedBy: options.actorId,
      reopenReason: options.reason,
      reopenedFromFinalizationVersion: options.finalizationVersion,
      reviewCalculationVersion: 0,
    },
    $unset: {
      reviewSubmittedAt: 1,
      reviewSubmittedBy: 1,
      reviewSubmissionReason: 1,
      reviewDecision: 1,
      reviewDecidedAt: 1,
      reviewDecidedBy: 1,
      reviewDecisionReason: 1,
    },
    $inc: { version: 1 },
  };
}

async function populatedRun(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId) {
  return PayrollRun.findOne({ _id: runId, company })
    .populate(
      "createdBy attendanceLockedBy attendanceInputsPreparedBy employeeSnapshotsPreparedBy calculatedBy reviewSubmittedBy reviewDecidedBy finalizedBy reopenedBy",
      "name username code role"
    )
    .lean();
}

export async function reopenPayrollRunService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunReopener(req);
    const { companyObjectId } = await resolvePayrollCompany(
      req,
      req.body?.companyId,
      true,
      "reopen this payroll run"
    );
    const actorId = getPayrollActorId(req);
    const runId = objectId(req.params.runId, "payroll run id");
    const version = expectedVersion(req.body?.expectedVersion);
    const reason = requiredReason(req.body?.reason);
    let alreadyReopened = false;

    await mongoose.connection.transaction(async (session) => {
      const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).session(session).lean();
      if (!run) throw generateError("Payroll run not found", 404);

      const finalizationVersion = Number(run.finalizationVersion || 0);
      if (
        run.status === "draft" &&
        finalizationVersion > 0 &&
        Number(run.reopenedFromFinalizationVersion || 0) === finalizationVersion
      ) {
        alreadyReopened = true;
        return;
      }

      const blocker = payrollReopenBlocker(run);
      if (blocker) throw generateError(blocker, 409);
      if (Number(run.version) !== version) throw generateError("Payroll run changed. Refresh and try again", 409);

      const reopenedAt = new Date();
      const update = await PayrollRun.updateOne(
        {
          _id: run._id,
          company: companyObjectId,
          status: "finalized",
          version,
          $or: [{ payoutStatus: "not_started" }, { payoutStatus: { $exists: false } }],
        },
        buildPayrollReopenUpdate({ actorId, reason, reopenedAt, finalizationVersion }),
        { session }
      );
      if (update.modifiedCount !== 1) {
        throw generateError("Payroll run changed or payout processing started while it was being reopened", 409);
      }

      await writePayrollAudit({
        company: companyObjectId,
        entityType: "payroll_run",
        entityId: run._id,
        action: "reopened_before_payout",
        actor: actorId,
        reason,
        details: {
          periodKey: run.periodKey,
          finalizationVersion,
          calculationVersion: run.calculationVersion,
          finalizedResultCount: run.finalizedResultCount,
          sourceRunVersion: version,
          nextStatus: "draft",
        },
      }, session);
    });

    return res.status(200).json({
      success: true,
      message: alreadyReopened
        ? "Payroll run is already reopened"
        : "Payroll reopened for correction; the prior finalized version remains immutable",
      data: await populatedRun(companyObjectId, runId),
    });
  } catch (error) {
    next(error);
  }
}
