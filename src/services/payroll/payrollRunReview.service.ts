import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import EmployeePayrollResult from "../../schemas/Payroll/EmployeePayrollResult.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import PayrollValidationDecision from "../../schemas/Payroll/PayrollValidationDecision.schema";
import {
  ensurePayrollRunApprover,
  ensurePayrollRunManager,
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

function requiredReason(value: unknown, label: string) {
  const reason = text(value);
  if (reason.length < 3 || reason.length > 500) {
    throw generateError(`${label} must contain 3 to 500 characters`, 422);
  }
  return reason;
}

export type PayrollReviewStatistics = {
  resultCount: number;
  errorResultCount: number;
  openWarningCount: number;
};

export function payrollReviewBlockers(run: any, statistics: PayrollReviewStatistics) {
  const blockers: string[] = [];
  if (run.attendanceInputStatus !== "prepared") blockers.push("Attendance inputs have not been imported");
  if (run.employeeSnapshotStatus !== "prepared") blockers.push("Employee snapshots have not been prepared");
  if (run.calculationStatus !== "calculated" || Number(run.calculationVersion || 0) < 1) {
    blockers.push("Payroll must be calculated before it can be submitted for review");
    return blockers;
  }
  if (statistics.resultCount < 1) blockers.push("The current calculation has no employee payroll results");
  if (statistics.resultCount !== Number(run.payrollResultCount || 0)) {
    blockers.push("The current payroll result count does not match the run summary");
  }
  if (statistics.errorResultCount > 0) {
    blockers.push(`${statistics.errorResultCount} employee payroll result(s) contain blocking errors`);
  }
  if (statistics.openWarningCount > 0) {
    blockers.push(`${statistics.openWarningCount} payroll warning(s) still require acknowledgement`);
  }
  if (Number(run.calculationEmployeeSnapshotVersion || 0) !== Number(run.employeeSnapshotVersion || 0)) {
    blockers.push("Employee snapshots changed after the current calculation");
  }
  if (Number(run.calculationOneTimeInputCount || 0) !== Number(run.oneTimeInputCount || 0)) {
    blockers.push("One-time payroll inputs changed after the current calculation");
  }
  return blockers;
}

export function ensureIndependentPayrollReviewer(submittedBy: unknown, reviewer: unknown) {
  if (text(submittedBy) === text(reviewer)) {
    throw generateError("The payroll submitter cannot approve or return their own payroll run", 409);
  }
}

export async function getPayrollReviewStatistics(
  company: mongoose.Types.ObjectId,
  run: any,
  session: mongoose.ClientSession
): Promise<PayrollReviewStatistics> {
  const resultRows = await EmployeePayrollResult.aggregate([
    {
      $match: {
        company,
        payrollRun: run._id,
        calculationVersion: Number(run.calculationVersion || 0),
      },
    },
    {
      $group: {
        _id: null,
        resultCount: { $sum: 1 },
        errorResultCount: { $sum: { $cond: ["$hasErrors", 1, 0] } },
      },
    },
  ]).session(session);

  const warningRows = await EmployeePayrollResult.aggregate([
    {
      $match: {
        company,
        payrollRun: run._id,
        calculationVersion: Number(run.calculationVersion || 0),
      },
    },
    { $unwind: "$issues" },
    { $match: { "issues.severity": "warning" } },
    {
      $lookup: {
        from: PayrollValidationDecision.collection.name,
        let: {
          resultId: "$_id",
          calculationVersion: "$calculationVersion",
          issueCode: "$issues.code",
          issueCategory: "$issues.category",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$employeePayrollResult", "$$resultId"] },
                  { $eq: ["$calculationVersion", "$$calculationVersion"] },
                  { $eq: ["$issueCode", "$$issueCode"] },
                  { $eq: ["$issueCategory", "$$issueCategory"] },
                ],
              },
            },
          },
          { $sort: { createdAt: -1, _id: -1 } },
          { $limit: 1 },
          { $project: { action: 1 } },
        ],
        as: "latestDecision",
      },
    },
    { $set: { latestDecision: { $arrayElemAt: ["$latestDecision", 0] } } },
    { $match: { "latestDecision.action": { $ne: "acknowledge" } } },
    { $count: "openWarningCount" },
  ]).session(session);

  return {
    resultCount: Number(resultRows[0]?.resultCount || 0),
    errorResultCount: Number(resultRows[0]?.errorResultCount || 0),
    openWarningCount: Number(warningRows[0]?.openWarningCount || 0),
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

export async function submitPayrollRunForReviewService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(
      req,
      req.body?.companyId,
      true,
      "submit this payroll run for review"
    );
    const actorId = getPayrollActorId(req);
    const runId = objectId(req.params.runId, "payroll run id");
    const version = expectedVersion(req.body?.expectedVersion);
    const reason = requiredReason(req.body?.reason, "Review submission reason");

    await mongoose.connection.transaction(async (session) => {
      const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).session(session).lean();
      if (!run) throw generateError("Payroll run not found", 404);
      if (run.status !== "draft") throw generateError("Only a draft payroll run can be submitted for review", 409);
      if (Number(run.version) !== version) throw generateError("Payroll run changed. Refresh and try again", 409);

      const statistics = await getPayrollReviewStatistics(companyObjectId, run, session);
      const blockers = payrollReviewBlockers(run, statistics);
      if (blockers.length) {
        throw generateError(`Payroll is not ready for review: ${blockers.join("; ")}`, 409);
      }

      const submittedAt = new Date();
      const update = await PayrollRun.updateOne(
        { _id: run._id, company: companyObjectId, status: "draft", version },
        {
          $set: {
            status: "review",
            reviewSubmittedAt: submittedAt,
            reviewSubmittedBy: actorId,
            reviewSubmissionReason: reason,
            reviewCalculationVersion: run.calculationVersion,
          },
          $unset: {
            reviewDecision: 1,
            reviewDecidedAt: 1,
            reviewDecidedBy: 1,
            reviewDecisionReason: 1,
          },
          $inc: { version: 1 },
        },
        { session }
      );
      if (update.modifiedCount !== 1) throw generateError("Payroll run changed while it was being submitted", 409);

      await writePayrollAudit({
        company: companyObjectId,
        entityType: "payroll_run",
        entityId: run._id,
        action: "submitted_for_review",
        actor: actorId,
        reason,
        details: {
          periodKey: run.periodKey,
          calculationVersion: run.calculationVersion,
          employeeCount: statistics.resultCount,
          sourceRunVersion: version,
        },
      }, session);
    });

    return res.status(200).json({
      success: true,
      message: "Payroll submitted for independent review",
      data: await populatedRun(companyObjectId, runId),
    });
  } catch (error) {
    next(error);
  }
}

export async function decidePayrollRunReviewService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunApprover(req);
    const { companyObjectId } = await resolvePayrollCompany(
      req,
      req.body?.companyId,
      true,
      "review this payroll run"
    );
    const actorId = getPayrollActorId(req);
    const runId = objectId(req.params.runId, "payroll run id");
    const version = expectedVersion(req.body?.expectedVersion);
    const action = text(req.body?.action).toLowerCase();
    if (!['approve', 'return'].includes(action)) throw generateError('Review action must be approve or return', 422);
    const reason = requiredReason(req.body?.reason, action === "approve" ? "Approval reason" : "Return reason");

    await mongoose.connection.transaction(async (session) => {
      const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).session(session).lean();
      if (!run) throw generateError("Payroll run not found", 404);
      if (run.status !== "review") throw generateError("Only a payroll run under review can be approved or returned", 409);
      if (Number(run.version) !== version) throw generateError("Payroll run changed. Refresh and try again", 409);
      if (!run.reviewSubmittedBy) throw generateError("Payroll review submission metadata is missing", 409);
      ensureIndependentPayrollReviewer(run.reviewSubmittedBy, actorId);
      if (Number(run.reviewCalculationVersion || 0) !== Number(run.calculationVersion || 0)) {
        throw generateError("Payroll calculation changed after review submission", 409);
      }

      if (action === "approve") {
        const statistics = await getPayrollReviewStatistics(companyObjectId, run, session);
        const blockers = payrollReviewBlockers(run, statistics);
        if (blockers.length) {
          throw generateError(`Payroll can no longer be approved: ${blockers.join("; ")}`, 409);
        }
      }

      const decidedAt = new Date();
      const nextStatus = action === "approve" ? "approved" : "draft";
      const update = await PayrollRun.updateOne(
        { _id: run._id, company: companyObjectId, status: "review", version },
        {
          $set: {
            status: nextStatus,
            reviewDecision: action === "approve" ? "approved" : "returned",
            reviewDecidedAt: decidedAt,
            reviewDecidedBy: actorId,
            reviewDecisionReason: reason,
          },
          $inc: { version: 1 },
        },
        { session }
      );
      if (update.modifiedCount !== 1) throw generateError("Payroll run changed while the review was being recorded", 409);

      await writePayrollAudit({
        company: companyObjectId,
        entityType: "payroll_run",
        entityId: run._id,
        action: action === "approve" ? "review_approved" : "review_returned",
        actor: actorId,
        reason,
        details: {
          periodKey: run.periodKey,
          calculationVersion: run.calculationVersion,
          submittedBy: run.reviewSubmittedBy,
          submittedAt: run.reviewSubmittedAt,
          sourceRunVersion: version,
          nextStatus,
        },
      }, session);
    });

    return res.status(200).json({
      success: true,
      message: action === "approve" ? "Payroll review approved" : "Payroll returned to draft",
      data: await populatedRun(companyObjectId, runId),
    });
  } catch (error) {
    next(error);
  }
}
