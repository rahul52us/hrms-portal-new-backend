import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import EmployeePayrollResult, {
  PAYROLL_RESULT_ISSUE_CATEGORIES,
  PAYROLL_RESULT_ISSUE_SEVERITIES,
} from "../../schemas/Payroll/EmployeePayrollResult.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import PayrollValidationDecision, {
  PAYROLL_VALIDATION_DECISION_ACTIONS,
} from "../../schemas/Payroll/PayrollValidationDecision.schema";
import {
  ensurePayrollRunManager,
  getPayrollActor,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";

const text = (value: unknown) => String(value ?? "").trim();
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pageNumber(value: unknown, fallback: number, maximum: number) {
  const parsed = Number.parseInt(text(value), 10);
  return Math.min(maximum, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

function objectId(value: unknown, label: string) {
  const normalized = text(value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function requiredReason(value: unknown) {
  const reason = text(value);
  if (reason.length < 3 || reason.length > 500) {
    throw generateError("Validation decision reason must contain 3 to 500 characters", 422);
  }
  return reason;
}

export function validationIssueRecommendedAction(categoryInput: unknown, codeInput: unknown) {
  const category = text(categoryInput).toLowerCase();
  const code = text(codeInput).toLowerCase();
  if (code === "approved_overtime_requires_amount") {
    return "Add the approved overtime amount as a one-time earning, recalculate payroll, then review the warning again.";
  }
  if (category === "compensation") {
    return "Correct the employee compensation effective on the cycle end date, refresh employee snapshots, and recalculate payroll.";
  }
  if (["identity", "organization", "bank", "statutory"].includes(category)) {
    return "Correct the employee profile data, refresh employee snapshots, and recalculate payroll.";
  }
  if (category === "attendance") {
    return "Correct the attendance payroll source or adjustment, then recalculate from a valid locked attendance handoff.";
  }
  if (category === "one_time_input") {
    return "Correct or cancel the one-time payroll input and recalculate payroll.";
  }
  return "Correct the underlying payroll input and recalculate payroll.";
}

export function validationDecisionTransition(
  severityInput: unknown,
  currentActionInput: unknown,
  requestedActionInput: unknown
) {
  const severity = text(severityInput).toLowerCase();
  const currentAction = text(currentActionInput).toLowerCase();
  const requestedAction = text(requestedActionInput).toLowerCase();
  if (severity !== "warning") throw generateError("Blocking payroll errors cannot be acknowledged; correct the source and recalculate", 422);
  if (!PAYROLL_VALIDATION_DECISION_ACTIONS.includes(requestedAction as any)) {
    throw generateError("Validation action must be acknowledge or reopen", 422);
  }
  const currentStatus = currentAction === "acknowledge" ? "acknowledged" : "open";
  if (requestedAction === "acknowledge") return { create: currentStatus !== "acknowledged", status: "acknowledged" as const };
  return { create: currentStatus === "acknowledged", status: "open" as const };
}

async function populatedRun(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId | string) {
  return PayrollRun.findOne({ _id: runId, company })
    .populate(
      "createdBy attendanceLockedBy attendanceInputsPreparedBy employeeSnapshotsPreparedBy calculatedBy",
      "name username code role"
    )
    .lean();
}

function decisionLookup() {
  return {
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
        { $sort: { createdAt: -1 as const, _id: -1 as const } },
        { $limit: 1 },
      ],
      as: "latestDecisions",
    },
  };
}

function resolutionFields() {
  return [
    { $set: { latestDecision: { $arrayElemAt: ["$latestDecisions", 0] } } },
    {
      $set: {
        resolutionStatus: {
          $cond: [{ $eq: ["$latestDecision.action", "acknowledge"] }, "acknowledged", "open"],
        },
      },
    },
  ];
}

export async function listPayrollValidationIssuesService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const runId = objectId(req.params.runId, "payroll run id");
    const page = pageNumber(req.query?.page, 1, 100_000);
    const limit = pageNumber(req.query?.limit, 25, 100);
    const severity = text(req.query?.severity || "all").toLowerCase();
    const category = text(req.query?.category || "all").toLowerCase();
    const resolution = text(req.query?.resolution || "all").toLowerCase();
    const search = text(req.query?.search);
    if (severity !== "all" && !PAYROLL_RESULT_ISSUE_SEVERITIES.includes(severity as any)) {
      throw generateError("Invalid payroll validation severity filter", 422);
    }
    if (category !== "all" && !PAYROLL_RESULT_ISSUE_CATEGORIES.includes(category as any)) {
      throw generateError("Invalid payroll validation category filter", 422);
    }
    if (!["all", "open", "acknowledged"].includes(resolution)) {
      throw generateError("Invalid payroll validation resolution filter", 422);
    }
    const run: any = await populatedRun(companyObjectId, runId);
    if (!run) throw generateError("Payroll run not found", 404);
    if (Number(run.calculationVersion || 0) < 1) {
      return res.status(200).json({
        success: true,
        data: {
          run,
          items: [],
          summary: { totalIssues: 0, errorIssues: 0, warningIssues: 0, openWarnings: 0, acknowledgedWarnings: 0, ready: false },
        },
        pagination: { page, limit, total: 0, totalPages: 1 },
      });
    }

    const base: any[] = [
      { $match: { company: companyObjectId, payrollRun: runId, calculationVersion: Number(run.calculationVersion) } },
      { $unwind: "$issues" },
      decisionLookup(),
      ...resolutionFields(),
    ];
    const regex = search ? new RegExp(escapeRegex(search), "i") : null;
    const filteredMatch: any = {
      ...(severity === "all" ? {} : { "issues.severity": severity }),
      ...(category === "all" ? {} : { "issues.category": category }),
      ...(resolution === "all" ? {} : { resolutionStatus: resolution }),
      ...(regex ? {
        $or: [
          { "identity.name": regex },
          { "identity.code": regex },
          { "issues.code": regex },
          { "issues.message": regex },
        ],
      } : {}),
    };
    const [listResult, summaryResult] = await Promise.all([
      EmployeePayrollResult.aggregate([
        ...base,
        { $match: filteredMatch },
        {
          $facet: {
            items: [
              { $sort: { "issues.severity": 1, "identity.code": 1, "issues.category": 1, "issues.code": 1 } },
              { $skip: (page - 1) * limit },
              { $limit: limit },
              {
                $project: {
                  _id: 0,
                  employeePayrollResult: "$_id",
                  employee: 1,
                  identity: 1,
                  organization: 1,
                  issue: "$issues",
                  resolutionStatus: 1,
                  latestDecision: {
                    action: "$latestDecision.action",
                    reason: "$latestDecision.reason",
                    actorName: "$latestDecision.actorNameSnapshot",
                    actorCode: "$latestDecision.actorCodeSnapshot",
                    createdAt: "$latestDecision.createdAt",
                  },
                },
              },
            ],
            count: [{ $count: "value" }],
          },
        },
      ]),
      EmployeePayrollResult.aggregate([
        ...base,
        {
          $group: {
            _id: null,
            totalIssues: { $sum: 1 },
            errorIssues: { $sum: { $cond: [{ $eq: ["$issues.severity", "error"] }, 1, 0] } },
            warningIssues: { $sum: { $cond: [{ $eq: ["$issues.severity", "warning"] }, 1, 0] } },
            openWarnings: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ["$issues.severity", "warning"] }, { $eq: ["$resolutionStatus", "open"] }] },
                  1,
                  0,
                ],
              },
            },
            acknowledgedWarnings: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ["$issues.severity", "warning"] }, { $eq: ["$resolutionStatus", "acknowledged"] }] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
    ]);
    const rawItems = listResult[0]?.items || [];
    const items = rawItems.map((item: any) => ({
      ...item,
      recommendedAction: validationIssueRecommendedAction(item.issue?.category, item.issue?.code),
      canDecide: item.issue?.severity === "warning" && run.status === "draft" && run.calculationStatus === "calculated",
    }));
    const total = Number(listResult[0]?.count?.[0]?.value || 0);
    const summary = {
      totalIssues: Number(summaryResult[0]?.totalIssues || 0),
      errorIssues: Number(summaryResult[0]?.errorIssues || 0),
      warningIssues: Number(summaryResult[0]?.warningIssues || 0),
      openWarnings: Number(summaryResult[0]?.openWarnings || 0),
      acknowledgedWarnings: Number(summaryResult[0]?.acknowledgedWarnings || 0),
      ready: run.calculationStatus === "calculated"
        && Number(summaryResult[0]?.errorIssues || 0) === 0
        && Number(summaryResult[0]?.openWarnings || 0) === 0,
    };
    return res.status(200).json({
      success: true,
      data: { run, items, summary },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}

export async function decidePayrollValidationIssueService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(
      req,
      req.body?.companyId,
      true,
      "review payroll validation warnings"
    );
    const actor = getPayrollActor(req);
    const actorId = getPayrollActorId(req);
    const runId = objectId(req.params.runId, "payroll run id");
    const resultId = objectId(req.params.resultId, "employee payroll result id");
    const issueCode = decodeURIComponent(text(req.params.issueCode));
    const issueCategory = text(req.body?.issueCategory).toLowerCase();
    const action = text(req.body?.action).toLowerCase();
    const reason = requiredReason(req.body?.reason);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw generateError("Expected payroll run version is required", 422);
    let created = false;

    await mongoose.connection.transaction(async (session) => {
      const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).session(session).lean();
      if (!run) throw generateError("Payroll run not found", 404);
      if (run.status !== "draft") throw generateError("Validation warnings can only be reviewed on a draft payroll run", 409);
      if (run.calculationStatus !== "calculated") throw generateError("Recalculate payroll before reviewing validation warnings", 409);
      const result: any = await EmployeePayrollResult.findOne({
        _id: resultId,
        company: companyObjectId,
        payrollRun: runId,
        calculationVersion: run.calculationVersion,
      }).session(session).lean();
      if (!result) throw generateError("Current employee payroll result not found", 404);
      const issue = (result.issues || []).find(
        (item: any) => text(item.code) === issueCode && text(item.category) === issueCategory
      );
      if (!issue) throw generateError("Payroll validation issue not found in the current calculation", 404);
      const latest: any = await PayrollValidationDecision.findOne({
        company: companyObjectId,
        payrollRun: runId,
        calculationVersion: run.calculationVersion,
        employeePayrollResult: result._id,
        issueCode,
        issueCategory,
      }).sort({ createdAt: -1, _id: -1 }).session(session).lean();
      const transition = validationDecisionTransition(issue.severity, latest?.action, action);
      if (!transition.create) return;
      if (Number(run.version) !== expectedVersion) throw generateError("Payroll run changed. Refresh and try again", 409);
      const [decision]: any[] = await PayrollValidationDecision.create([{
        company: companyObjectId,
        payrollRun: run._id,
        calculationVersion: run.calculationVersion,
        employeePayrollResult: result._id,
        employee: result.employee,
        issueCode,
        issueCategory,
        issueSeverity: issue.severity,
        action,
        reason,
        actor: actorId,
        actorNameSnapshot: text(actor?.name || actor?.username || actor?.code) || "Payroll reviewer",
        actorCodeSnapshot: text(actor?.code),
      }], { session });
      const update = await PayrollRun.updateOne(
        { _id: run._id, company: companyObjectId, status: "draft", calculationStatus: "calculated", version: expectedVersion },
        { $inc: { version: 1 } },
        { session }
      );
      if (update.modifiedCount !== 1) throw generateError("Payroll run changed while the warning was being reviewed", 409);
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "payroll_run",
        entityId: run._id,
        action: action === "acknowledge" ? "validation_warning_acknowledged" : "validation_warning_reopened",
        actor: actorId,
        reason,
        details: {
          calculationVersion: run.calculationVersion,
          employeePayrollResult: result._id,
          employee: result.employee,
          employeeCode: result.identity?.code,
          issueCode,
          issueCategory,
          decision: decision._id,
        },
      }, session);
      created = true;
    });

    const run = await populatedRun(companyObjectId, runId);
    return res.status(created ? 201 : 200).json({
      success: true,
      message: created
        ? action === "acknowledge" ? "Payroll warning acknowledged" : "Payroll warning reopened"
        : action === "acknowledge" ? "Payroll warning was already acknowledged" : "Payroll warning was already open",
      data: run,
    });
  } catch (error) {
    next(error);
  }
}
