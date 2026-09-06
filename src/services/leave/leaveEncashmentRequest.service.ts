import { NextFunction, Response } from "express";
import mongoose, { ClientSession } from "mongoose";
import { generateError } from "../../config/Error/functions";
import ApprovalInstance from "../../schemas/Approval/ApprovalInstance.schema";
import EmployeeLeaveBalance from "../../schemas/Leave/EmployeeLeaveBalance.schema";
import LeaveBalanceTransaction from "../../schemas/Leave/LeaveBalanceTransaction.schema";
import LeaveEncashmentRequest, {
  LEAVE_ENCASHMENT_PAYOUT_STATUSES,
  LEAVE_ENCASHMENT_REQUEST_STATUSES,
} from "../../schemas/Leave/LeaveEncashmentRequest.schema";
import User from "../../schemas/User/User";
import LeaveType from "../../schemas/WorkforcePolicy/LeaveType.schema";
import { resolveEmployeeDayContext } from "../attendance/employeeDayContext.service";
import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";
import {
  approveApprovalInstance,
  cancelApprovalInstance,
  createApprovalInstance,
  rejectApprovalInstance,
} from "../approval/approvalEngine.service";
import { resolveEffectiveApprovalWorkflowReference } from "../approval/approvalWorkflow.service";
import { PERMISSION_KEYS, hasPermission } from "../permissions/permission.utils";
import {
  buildLeaveRequestScope,
  ensureEmployeeInActorScope,
  getLeaveActor,
  isEmployeeInActorScope,
  resolveLeaveCompanyId,
} from "./leaveAccess.utils";
import { ensureEmployeeLeaveAccruals } from "./leaveAccrual.service";
import {
  LeaveBalanceKey,
  postLeaveBalanceTransaction,
  releasePendingLeaveBalance,
  reserveLeaveBalance,
} from "./leaveBalance.service";
import { resolveLeaveYear } from "./leaveRequestCalculator.utils";

function text(value: unknown) {
  return String(value || "").trim();
}

function objectId(value: unknown, label: string) {
  const normalized = text((value as any)?._id || value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function optionalObjectId(value: unknown) {
  const normalized = text((value as any)?._id || value);
  return mongoose.Types.ObjectId.isValid(normalized)
    ? new mongoose.Types.ObjectId(normalized)
    : null;
}

function currentDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function roundUnits(value: number) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function usesIncrement(value: number, increment: number) {
  return Math.abs(value / increment - Math.round(value / increment)) < 0.000001;
}

function pagination(query: any) {
  const page = Math.max(1, Number(query?.page || 1));
  const limit = Math.max(1, Math.min(50, Number(query?.limit || 20)));
  return { page, limit, skip: (page - 1) * limit };
}

function event(actor: any, action: string, comment?: string) {
  return {
    action,
    actor: actor._id,
    actorRole: actor.role,
    comment: text(comment) || undefined,
    at: new Date(),
  };
}

function balanceKey(request: any): LeaveBalanceKey {
  return {
    company: objectId(request.company, "company id"),
    employee: objectId(request.employee, "employee id"),
    leaveType: objectId(request.leaveType, "leave type id"),
    leaveYearKey: request.leaveYearKey,
    leaveYearStart: request.leaveYearStart,
    leaveYearEnd: request.leaveYearEnd,
  };
}

async function loadEmployee(company: mongoose.Types.ObjectId, employeeId: unknown) {
  const employee = await User.findOne({
    _id: objectId(employeeId, "employee id"),
    company,
    deletedAt: { $exists: false },
    is_enabled: { $ne: false },
  })
    .select("_id name username code role department team officeLocation reportingManager joiningDate date_of_joining")
    .lean();
  if (!employee) throw generateError("Employee not found or disabled", 404);
  return employee;
}

function scopeEmployee(request: any) {
  return {
    _id: request.employee?._id || request.employee,
    department: request.departmentNameSnapshot,
    team: request.teamNameSnapshot,
    officeLocation: request.officeLocation,
    reportingManager: request.reportingManager || request.approver,
  };
}

function isApprovalParticipant(actor: any, request: any) {
  if ((request.currentApprovers || []).some((item: any) => String(item?._id || item) === String(actor._id))) {
    return true;
  }
  return Boolean(
    request.approvalInstance?.steps?.some((step: any) =>
      (step.approvers || []).some(
        (approver: any) => String(approver.user?._id || approver.user) === String(actor._id)
      )
    )
  );
}

function ensureCanView(actor: any, request: any) {
  if (String(request.employee?._id || request.employee) === String(actor._id)) return;
  if (isApprovalParticipant(actor, request)) return;
  if (
    !hasPermission(actor, PERMISSION_KEYS.VIEW_LEAVE_REQUESTS) ||
    !isEmployeeInActorScope(actor, scopeEmployee(request), PERMISSION_KEYS.VIEW_LEAVE_REQUESTS)
  ) {
    throw generateError("You cannot view this leave encashment request", 403);
  }
}

function ensureCanSettle(actor: any, request: any) {
  if (
    !hasPermission(actor, PERMISSION_KEYS.MANAGE_LEAVE_BALANCES) ||
    !isEmployeeInActorScope(actor, scopeEmployee(request), PERMISSION_KEYS.MANAGE_LEAVE_BALANCES)
  ) {
    throw generateError("You cannot settle leave encashment for this employee", 403);
  }
}

function populateRequest(query: any) {
  return query
    .populate("employee", "name username code role department team officeLocation reportingManager")
    .populate("leaveType", "name code color unit paid balanceTracked")
    .populate("approver", "name username code role designation")
    .populate("currentApprovers", "name username code role designation")
    .populate("decidedBy", "name username code role")
    .populate("settledBy", "name username code role")
    .populate("cancelledBy", "name username code role")
    .populate("encashmentTransaction")
    .populate("reversalTransaction")
    .populate({
      path: "approvalInstance",
      populate: [
        { path: "steps.approvers.user", select: "name username code role designation" },
        { path: "history.actor", select: "name username code role" },
      ],
    })
    .populate("history.actor", "name username role");
}

function syncApprovalState(request: any, approval: any) {
  request.approvalInstance = approval.instance._id;
  request.currentApprovers = approval.currentApprovers;
  request.approver = approval.currentApprovers[0] || null;
  const current = approval.instance.steps?.find(
    (step: any) => step.order === approval.instance.currentStepOrder
  );
  request.approverNameSnapshot =
    current?.approvers?.find((item: any) => item.status === "pending")?.nameSnapshot || "";
}

async function activeEncashmentUnits(options: {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  leaveType: mongoose.Types.ObjectId;
  leaveYearKey: string;
  session: ClientSession;
}) {
  const result = await LeaveEncashmentRequest.aggregate([
    {
      $match: {
        company: options.company,
        employee: options.employee,
        leaveType: options.leaveType,
        leaveYearKey: options.leaveYearKey,
        status: { $in: ["submitted", "approved"] },
      },
    },
    { $group: { _id: null, units: { $sum: "$requestedUnits" } } },
  ]).session(options.session);
  return roundUnits(Number(result[0]?.units || 0));
}

async function resolveEligibility(options: {
  company: mongoose.Types.ObjectId;
  employee: any;
  at: string;
}) {
  const context = await resolveEmployeeDayContext({
    companyId: options.company,
    employeeId: options.employee._id,
    attendanceDate: options.at,
  });
  const version = context.policies.leavePolicy?.version;
  if (!version) throw generateError("No leave policy is effective for this employee and date", 422);
  await ensureEmployeeLeaveAccruals({
    companyId: options.company,
    employee: options.employee,
    asOf: options.at,
    context,
  });
  const year = resolveLeaveYear(
    options.at,
    Number(version.leaveYearStartMonth || 1),
    Number(version.leaveYearStartDay || 1)
  );
  const rules = (version.rules || []).filter(
    (rule: any) =>
      rule.encashmentEnabled &&
      rule.entitlementMode === "fixed" &&
      rule.balanceTracked !== false &&
      rule.paid !== false
  );
  const typeIds = rules.map((rule: any) => optionalObjectId(rule.leaveType)).filter(Boolean) as mongoose.Types.ObjectId[];
  const [types, balances, usage, pending] = await Promise.all([
    LeaveType.find({ _id: { $in: typeIds }, company: options.company, status: "active" }).lean(),
    EmployeeLeaveBalance.find({
      company: options.company,
      employee: options.employee._id,
      leaveType: { $in: typeIds },
      leaveYearKey: year.leaveYearKey,
    }).lean(),
    LeaveEncashmentRequest.aggregate([
      {
        $match: {
          company: options.company,
          employee: options.employee._id,
          leaveType: { $in: typeIds },
          leaveYearKey: year.leaveYearKey,
          status: { $in: ["submitted", "approved"] },
        },
      },
      { $group: { _id: "$leaveType", units: { $sum: "$requestedUnits" } } },
    ]),
    LeaveEncashmentRequest.find({
      company: options.company,
      employee: options.employee._id,
      leaveType: { $in: typeIds },
      leaveYearKey: year.leaveYearKey,
      status: "submitted",
    })
      .select("_id leaveType requestedUnits requestedAt")
      .lean(),
  ]);
  const typeById = new Map(types.map((item: any) => [String(item._id), item]));
  const balanceByType = new Map(balances.map((item: any) => [String(item.leaveType), item]));
  const usageByType = new Map(usage.map((item: any) => [String(item._id), Number(item.units || 0)]));
  const pendingByType = new Map(pending.map((item: any) => [String(item.leaveType), item]));
  const items = rules.flatMap((rule: any) => {
    const leaveType: any = typeById.get(String(rule.leaveType));
    if (!leaveType) return [];
    const balance: any = balanceByType.get(String(rule.leaveType)) || {
      creditedUnits: 0,
      debitedUnits: 0,
      pendingUnits: 0,
      balanceUnits: 0,
      availableUnits: 0,
    };
    const usedUnits = roundUnits(usageByType.get(String(rule.leaveType)) || 0);
    const annualLimit = roundUnits(Number(rule.maxEncashmentPerYear || 0));
    const remainingAnnualUnits = Math.max(0, roundUnits(annualLimit - usedUnits));
    const availableUnits = Math.max(0, roundUnits(Number(balance.availableUnits || 0)));
    const maximumRequestableUnits = Math.max(0, Math.min(availableUnits, remainingAnnualUnits));
    const increment = leaveType.unit === "hours" ? 0.25 : rule.allowHalfDay ? 0.5 : 1;
    const pendingRequest = pendingByType.get(String(rule.leaveType)) || null;
    return [{
      leaveType,
      rule,
      leaveYear: year,
      balance,
      usedUnits,
      remainingAnnualUnits,
      maximumRequestableUnits,
      increment,
      pendingRequest,
      canRequest: !pendingRequest && maximumRequestableUnits + 0.000001 >= increment,
    }];
  });
  return { context, version, year, items };
}

async function finalizeApproval(request: any, actorId: mongoose.Types.ObjectId, session: ClientSession) {
  const key = balanceKey(request);
  await releasePendingLeaveBalance({ key, units: request.requestedUnits, session });
  const transaction = await postLeaveBalanceTransaction({
    key,
    units: -request.requestedUnits,
    transactionType: "encashment",
    sourceType: "leave_encashment",
    sourceId: request._id,
    effectiveDate: currentDateKey(),
    idempotencyKey: `${request._id}:encashment`,
    reason: `Approved ${request.leaveTypeCodeSnapshot} leave encashment`,
    leavePolicyAssignment: optionalObjectId(request.leavePolicyAssignment),
    leavePolicy: optionalObjectId(request.leavePolicy),
    leavePolicyVersion: optionalObjectId(request.leavePolicyVersion),
    createdBy: actorId,
    session,
  });
  request.encashmentTransaction = transaction._id;
  request.status = "approved";
  request.payoutStatus = "pending";
  request.currentApprovers = [];
  request.approver = null;
  request.approverNameSnapshot = "";
  request.decidedAt = new Date();
  request.decidedBy = actorId;
}

export async function getLeaveEncashmentEligibilityService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    const employee = await loadEmployee(company, req.query?.employeeId || actor._id);
    ensureEmployeeInActorScope(
      actor,
      employee,
      PERMISSION_KEYS.VIEW_LEAVE_REQUESTS,
      "You cannot view leave encashment eligibility for this employee"
    );
    const at = parseAttendanceDate(text(req.query?.at || currentDateKey())).dateKey;
    if (at !== currentDateKey()) {
      throw generateError("Leave encashment eligibility can only be checked for today", 422);
    }
    const resolved = await resolveEligibility({ company, employee, at });
    return res.status(200).json({
      success: true,
      data: { employee, at, leaveYear: resolved.year, items: resolved.items },
    });
  } catch (error) {
    next(error);
  }
}

export async function createLeaveEncashmentRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const employee = await loadEmployee(company, req.body?.employeeId || actor._id);
    if (String(employee._id) !== String(actor._id)) {
      ensureEmployeeInActorScope(
        actor,
        employee,
        PERMISSION_KEYS.MANAGE_LEAVE_BALANCES,
        "You cannot submit leave encashment for this employee"
      );
    }
    const leaveTypeId = objectId(req.body?.leaveTypeId, "leave type id");
    const requestedUnits = roundUnits(Number(req.body?.requestedUnits));
    const reason = text(req.body?.reason);
    if (!Number.isFinite(requestedUnits) || requestedUnits <= 0) {
      throw generateError("Requested encashment units must be greater than zero", 422);
    }
    if (reason.length < 3) throw generateError("An encashment reason is required", 422);
    const at = currentDateKey();
    const resolved = await resolveEligibility({ company, employee, at });
    const eligible: any = resolved.items.find(
      (item: any) => String(item.leaveType._id) === String(leaveTypeId)
    );
    if (!eligible) throw generateError("This leave type is not eligible for encashment", 422);
    if (!usesIncrement(requestedUnits, eligible.increment)) {
      throw generateError(
        `Encashment must use ${eligible.increment} ${eligible.leaveType.unit} increments`,
        422
      );
    }
    if (eligible.pendingRequest) {
      throw generateError("An encashment request is already pending for this leave type and leave year", 409);
    }
    if (requestedUnits > eligible.maximumRequestableUnits + 0.000001) {
      throw generateError(
        `You can encash at most ${eligible.maximumRequestableUnits} ${eligible.leaveType.unit} right now`,
        422
      );
    }
    const workflowId = text(eligible.rule.encashmentApprovalWorkflow);
    if (!mongoose.Types.ObjectId.isValid(workflowId)) {
      throw generateError(
        `Encashment approval workflow setup is incomplete for ${eligible.leaveType.code}`,
        409
      );
    }
    const workflow = await resolveEffectiveApprovalWorkflowReference({
      company,
      workflowId,
      requestType: "leave_encashment_request",
      at: new Date(),
      setupLabel: `${eligible.leaveType.code} leave encashment requests`,
    });
    const references = resolved.context.policyReferences.leavePolicy;
    const request = new LeaveEncashmentRequest({
      company,
      employee: employee._id,
      leaveType: leaveTypeId,
      leaveTypeCodeSnapshot: eligible.leaveType.code,
      leaveTypeNameSnapshot: eligible.leaveType.name,
      leaveUnit: eligible.leaveType.unit,
      ...resolved.year,
      requestedUnits,
      maxEncashmentPerYearSnapshot: eligible.rule.maxEncashmentPerYear,
      availableBalanceSnapshot: eligible.balance.availableUnits || 0,
      leavePolicyAssignment: optionalObjectId(references?.assignmentId),
      leavePolicy: optionalObjectId(references?.resourceId),
      leavePolicyVersion: optionalObjectId(references?.versionId),
      leavePolicyVersionNumber: Number(references?.versionNumber || 0) || null,
      departmentNameSnapshot: text(employee.department),
      teamNameSnapshot: text(employee.team),
      officeLocation: optionalObjectId(employee.officeLocation),
      reportingManager: optionalObjectId(employee.reportingManager),
      reason,
      status: "submitted",
      payoutStatus: "not_ready",
      history: [event(actor, "submitted", String(employee._id) === String(actor._id) ? undefined : "Submitted on behalf of employee")],
      requestedAt: new Date(),
      createdBy: actor._id,
    });

    await mongoose.connection.transaction(async (session) => {
      const duplicate = await LeaveEncashmentRequest.exists({
        company,
        employee: employee._id,
        leaveType: leaveTypeId,
        leaveYearKey: resolved.year.leaveYearKey,
        status: "submitted",
      }).session(session);
      if (duplicate) {
        throw generateError("An encashment request is already pending for this leave type and leave year", 409);
      }
      const usedUnits = await activeEncashmentUnits({
        company,
        employee: employee._id as mongoose.Types.ObjectId,
        leaveType: leaveTypeId,
        leaveYearKey: resolved.year.leaveYearKey,
        session,
      });
      if (usedUnits + requestedUnits > Number(eligible.rule.maxEncashmentPerYear) + 0.000001) {
        throw generateError("The annual encashment limit changed; refresh and try again", 409);
      }
      await reserveLeaveBalance({
        key: balanceKey(request),
        units: requestedUnits,
        maxNegativeBalance: 0,
        session,
      });
      const approval = await createApprovalInstance({
        company,
        requestType: "leave_encashment_request",
        requestModel: "LeaveEncashmentRequest",
        requestId: request._id as mongoose.Types.ObjectId,
        employee,
        workflowId: workflow.workflow,
        workflowVersionId: workflow.version,
        actorId: actor._id,
        session,
      });
      syncApprovalState(request, approval);
      if (approval.finalApproved) {
        await finalizeApproval(request, actor._id, session);
        request.decisionComment = "Auto-approved by approval workflow";
        request.history.push(event(actor, "approved", request.decisionComment) as any);
      }
      await request.save({ session });
    });

    const created = await populateRequest(LeaveEncashmentRequest.findById(request._id));
    return res.status(201).json({
      success: true,
      data: created,
      message: created.status === "approved"
        ? "Leave encashment auto-approved and sent for payout"
        : "Leave encashment request submitted",
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      return next(generateError("An encashment request is already pending for this leave type and leave year", 409));
    }
    next(error);
  }
}

export async function listLeaveEncashmentRequestsService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    const { page, limit, skip } = pagination(req.query);
    const scope = text(req.query?.scope || "mine").toLowerCase();
    const match: any = { company };
    if (scope === "mine") {
      match.employee = actor._id;
    } else if (scope === "approvals") {
      match.currentApprovers = actor._id;
    } else if (scope === "company") {
      if (!hasPermission(actor, PERMISSION_KEYS.VIEW_LEAVE_REQUESTS)) {
        throw generateError("You do not have permission to view leave encashment requests", 403);
      }
      Object.assign(match, buildLeaveRequestScope(actor, PERMISSION_KEYS.VIEW_LEAVE_REQUESTS, false));
    } else {
      throw generateError("scope must be mine, approvals, or company", 400);
    }
    const statuses = text(req.query?.status)
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (statuses.some((status) => !LEAVE_ENCASHMENT_REQUEST_STATUSES.includes(status as any))) {
      throw generateError("Invalid leave encashment status", 400);
    }
    if (statuses.length) match.status = { $in: statuses };
    const payoutStatuses = text(req.query?.payoutStatus)
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (payoutStatuses.some((status) => !LEAVE_ENCASHMENT_PAYOUT_STATUSES.includes(status as any))) {
      throw generateError("Invalid leave encashment payout status", 400);
    }
    if (payoutStatuses.length) match.payoutStatus = { $in: payoutStatuses };

    const [items, total] = await Promise.all([
      populateRequest(
        LeaveEncashmentRequest.find(match)
          .sort({ requestedAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
      ),
      LeaveEncashmentRequest.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: items,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}

export async function getLeaveEncashmentRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    const request = await populateRequest(
      LeaveEncashmentRequest.findOne({
        _id: objectId(req.params.encashmentRequestId, "leave encashment request id"),
        company,
      })
    );
    if (!request) throw generateError("Leave encashment request not found", 404);
    ensureCanView(actor, request);
    return res.status(200).json({ success: true, data: request });
  } catch (error) {
    next(error);
  }
}

export async function approveLeaveEncashmentRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const requestId = objectId(req.params.encashmentRequestId, "leave encashment request id");
    let finalApproved = false;
    let currentStepName: string | null = null;
    await mongoose.connection.transaction(async (session) => {
      const request = await LeaveEncashmentRequest.findOne({
        _id: requestId,
        company,
        status: "submitted",
      }).session(session);
      if (!request) throw generateError("Only a submitted encashment request can be approved", 409);
      const approval = await approveApprovalInstance({
        company,
        requestModel: "LeaveEncashmentRequest",
        requestId,
        actor,
        comment: req.body?.comment,
        session,
      });
      syncApprovalState(request, approval);
      finalApproved = approval.finalApproved;
      currentStepName = approval.currentStepName;
      if (finalApproved) {
        await finalizeApproval(request, actor._id, session);
        request.decisionComment = text(req.body?.comment);
        request.history.push(event(actor, "approved", req.body?.comment) as any);
      }
      await request.save({ session });
    });
    const updated = await populateRequest(LeaveEncashmentRequest.findById(requestId));
    return res.status(200).json({
      success: true,
      data: updated,
      message: finalApproved
        ? "Leave encashment approved and sent for payout"
        : `Approval recorded${currentStepName ? `; awaiting ${currentStepName}` : ""}`,
    });
  } catch (error) {
    next(error);
  }
}

export async function rejectLeaveEncashmentRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const requestId = objectId(req.params.encashmentRequestId, "leave encashment request id");
    const comment = text(req.body?.comment);
    if (comment.length < 3) throw generateError("A rejection reason is required", 422);
    await mongoose.connection.transaction(async (session) => {
      const request = await LeaveEncashmentRequest.findOne({
        _id: requestId,
        company,
        status: "submitted",
      }).session(session);
      if (!request) throw generateError("Only a submitted encashment request can be rejected", 409);
      await rejectApprovalInstance({
        company,
        requestModel: "LeaveEncashmentRequest",
        requestId,
        actor,
        comment,
        session,
      });
      await releasePendingLeaveBalance({ key: balanceKey(request), units: request.requestedUnits, session });
      request.status = "rejected";
      request.payoutStatus = "not_ready";
      request.currentApprovers = [] as any;
      request.approver = null;
      request.approverNameSnapshot = "";
      request.decidedAt = new Date();
      request.decidedBy = actor._id;
      request.decisionComment = comment;
      request.history.push(event(actor, "rejected", comment) as any);
      await request.save({ session });
    });
    const updated = await populateRequest(LeaveEncashmentRequest.findById(requestId));
    return res.status(200).json({ success: true, data: updated, message: "Leave encashment request rejected" });
  } catch (error) {
    next(error);
  }
}

export async function withdrawLeaveEncashmentRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const requestId = objectId(req.params.encashmentRequestId, "leave encashment request id");
    const comment = text(req.body?.comment) || "Encashment request withdrawn by employee";
    await mongoose.connection.transaction(async (session) => {
      const request = await LeaveEncashmentRequest.findOne({
        _id: requestId,
        company,
        status: "submitted",
      }).session(session);
      if (!request) throw generateError("Only a submitted encashment request can be withdrawn", 409);
      if (String(request.employee) !== String(actor._id)) {
        throw generateError("Only the employee can withdraw this encashment request", 403);
      }
      await cancelApprovalInstance({
        company,
        requestModel: "LeaveEncashmentRequest",
        requestId,
        actor,
        comment,
        session,
      });
      await releasePendingLeaveBalance({ key: balanceKey(request), units: request.requestedUnits, session });
      request.status = "withdrawn";
      request.payoutStatus = "not_ready";
      request.currentApprovers = [] as any;
      request.approver = null;
      request.approverNameSnapshot = "";
      request.decidedAt = new Date();
      request.decidedBy = actor._id;
      request.decisionComment = comment;
      request.history.push(event(actor, "withdrawn", comment) as any);
      await request.save({ session });
    });
    const updated = await populateRequest(LeaveEncashmentRequest.findById(requestId));
    return res.status(200).json({ success: true, data: updated, message: "Leave encashment request withdrawn" });
  } catch (error) {
    next(error);
  }
}

export async function settleLeaveEncashmentRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const requestId = objectId(req.params.encashmentRequestId, "leave encashment request id");
    const amount = Number(req.body?.amount);
    const currency = text(req.body?.currency || "INR").toUpperCase();
    const payoutDate = parseAttendanceDate(text(req.body?.payoutDate || currentDateKey())).dateKey;
    if (!Number.isFinite(amount) || amount <= 0) throw generateError("Payout amount must be greater than zero", 422);
    if (!/^[A-Z]{3}$/.test(currency)) throw generateError("Payout currency must be a 3-letter code", 422);
    if (payoutDate > currentDateKey()) throw generateError("A paid encashment cannot use a future payout date", 422);
    await mongoose.connection.transaction(async (session) => {
      const request = await LeaveEncashmentRequest.findOne({
        _id: requestId,
        company,
        status: "approved",
        payoutStatus: "pending",
      }).session(session);
      if (!request) throw generateError("Only an approved unpaid encashment can be marked paid", 409);
      ensureCanSettle(actor, request);
      request.payoutStatus = "paid";
      request.payoutAmount = Math.round((amount + Number.EPSILON) * 100) / 100;
      request.payoutCurrency = currency;
      request.payoutDate = payoutDate;
      request.payoutReference = text(req.body?.reference);
      request.payoutNotes = text(req.body?.notes);
      request.settledAt = new Date();
      request.settledBy = actor._id;
      request.history.push(event(actor, "marked_paid", request.payoutReference || request.payoutNotes) as any);
      await request.save({ session });
    });
    const updated = await populateRequest(LeaveEncashmentRequest.findById(requestId));
    return res.status(200).json({ success: true, data: updated, message: "Leave encashment marked paid" });
  } catch (error) {
    next(error);
  }
}

export async function cancelApprovedLeaveEncashmentRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const requestId = objectId(req.params.encashmentRequestId, "leave encashment request id");
    const reason = text(req.body?.reason || req.body?.comment);
    if (reason.length < 3) throw generateError("A cancellation reason is required", 422);
    await mongoose.connection.transaction(async (session) => {
      const request = await LeaveEncashmentRequest.findOne({
        _id: requestId,
        company,
        status: "approved",
        payoutStatus: "pending",
      }).session(session);
      if (!request) throw generateError("Only an approved unpaid encashment can be cancelled", 409);
      ensureCanSettle(actor, request);
      const original = request.encashmentTransaction
        ? await LeaveBalanceTransaction.findOne({
            _id: request.encashmentTransaction,
            company,
            sourceType: "leave_encashment",
            sourceId: request._id,
            transactionType: "encashment",
          }).session(session)
        : await LeaveBalanceTransaction.findOne({
            company,
            idempotencyKey: `${request._id}:encashment`,
          }).session(session);
      if (!original) throw generateError("The encashment ledger debit is missing; rebuild or repair the balance first", 409);
      const reversal = await postLeaveBalanceTransaction({
        key: balanceKey(request),
        units: request.requestedUnits,
        transactionType: "encashment_reversal",
        sourceType: "leave_encashment",
        sourceId: request._id,
        effectiveDate: currentDateKey(),
        idempotencyKey: `${request._id}:encashment:reversal`,
        reason,
        leavePolicyAssignment: optionalObjectId(request.leavePolicyAssignment),
        leavePolicy: optionalObjectId(request.leavePolicy),
        leavePolicyVersion: optionalObjectId(request.leavePolicyVersion),
        reversalOf: original._id as mongoose.Types.ObjectId,
        createdBy: actor._id,
        session,
      });
      request.status = "cancelled";
      request.payoutStatus = "cancelled";
      request.reversalTransaction = reversal._id;
      request.cancelledAt = new Date();
      request.cancelledBy = actor._id;
      request.cancellationReason = reason;
      request.history.push(event(actor, "cancelled", reason) as any);
      await request.save({ session });
    });
    const updated = await populateRequest(LeaveEncashmentRequest.findById(requestId));
    return res.status(200).json({
      success: true,
      data: updated,
      message: "Unpaid leave encashment cancelled and balance restored",
    });
  } catch (error) {
    next(error);
  }
}
