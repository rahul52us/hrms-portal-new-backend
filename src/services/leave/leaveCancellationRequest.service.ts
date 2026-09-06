import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import ApprovalInstance from "../../schemas/Approval/ApprovalInstance.schema";
import LeaveCancellationRequest, {
  LEAVE_CANCELLATION_REQUEST_STATUSES,
} from "../../schemas/Leave/LeaveCancellationRequest.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import User from "../../schemas/User/User";
import LeavePolicyVersion from "../../schemas/WorkforcePolicy/LeavePolicyVersion.schema";
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
  getLeaveActor,
  isEmployeeInActorScope,
  resolveLeaveCompanyId,
} from "./leaveAccess.utils";
import { finalizeApprovedLeaveCancellation } from "./leaveRequest.service";

function text(value: unknown) {
  return String(value || "").trim();
}

function objectId(value: unknown, label: string) {
  const normalized = text((value as any)?._id || value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function pagination(query: any) {
  const page = Math.max(1, Number(query?.page || 1));
  const limit = Math.max(1, Math.min(50, Number(query?.limit || 20)));
  return { page, limit, skip: (page - 1) * limit };
}

function cancellationEvent(actor: any, action: string, comment?: string) {
  return {
    action,
    actor: actor._id,
    actorRole: actor.role,
    comment: text(comment) || undefined,
    at: new Date(),
  };
}

function leaveEvent(actor: any, action: string, comment?: string) {
  return cancellationEvent(actor, action, comment);
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
    throw generateError("You cannot view this leave cancellation request", 403);
  }
}

function populateCancellationRequest(query: any) {
  return query
    .populate("employee", "name username code role department team officeLocation reportingManager")
    .populate(
      "leaveRequest",
      "leaveType leaveTypeCodeSnapshot leaveTypeNameSnapshot leaveUnit fromDate toDate requestedUnits chargedUnits reason status"
    )
    .populate("approver", "name username code role designation")
    .populate("currentApprovers", "name username code role designation")
    .populate("decidedBy", "name username code role")
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

async function resolveCancellationWorkflow(company: mongoose.Types.ObjectId, request: any) {
  const originalApproval = request.approvalInstance
    ? await ApprovalInstance.findOne({
        _id: request.approvalInstance,
        company,
        requestModel: "LeaveRequest",
        request: request._id,
      })
        .select("workflow workflowVersion")
        .lean()
    : null;
  let workflowId = text(originalApproval?.workflow);
  if (mongoose.Types.ObjectId.isValid(workflowId)) {
    try {
      const effective = await resolveEffectiveApprovalWorkflowReference({
        company,
        workflowId,
        requestType: "leave_request",
        at: new Date(),
        setupLabel: `${request.leaveTypeCodeSnapshot || "Leave"} cancellation requests`,
      });
      return { workflowId: effective.workflow, workflowVersionId: effective.version };
    } catch (error) {
      if (mongoose.Types.ObjectId.isValid(text(originalApproval?.workflowVersion))) {
        return {
          workflowId: new mongoose.Types.ObjectId(workflowId),
          workflowVersionId: new mongoose.Types.ObjectId(text(originalApproval?.workflowVersion)),
        };
      }
      throw error;
    }
  }
  if (!mongoose.Types.ObjectId.isValid(workflowId)) {
    const policyVersionId = (request.dayBreakdown || [])
      .find((day: any) => Number(day.chargedUnits || 0) > 0 && day.leavePolicyVersion)
      ?.leavePolicyVersion;
    const policyVersion = mongoose.Types.ObjectId.isValid(text(policyVersionId))
      ? await LeavePolicyVersion.findOne({
          _id: policyVersionId,
          company,
          status: "published",
        })
          .select("rules")
          .lean()
      : null;
    const rule: any = policyVersion?.rules?.find(
      (item: any) => String(item.leaveType) === String(request.leaveType)
    );
    workflowId = text(rule?.requestApprovalWorkflow);
  }
  const effective = await resolveEffectiveApprovalWorkflowReference({
    company,
    workflowId,
    requestType: "leave_request",
    at: new Date(),
    setupLabel: `${request.leaveTypeCodeSnapshot || "Leave"} cancellation requests`,
  });
  return { workflowId: effective.workflow, workflowVersionId: effective.version };
}

export async function createLeaveCancellationRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const leaveRequestId = objectId(req.params.requestId, "leave request id");
    const reason = text(req.body?.reason || req.body?.comment);
    if (reason.length < 3) throw generateError("A cancellation reason is required", 422);
    const candidate = await LeaveRequest.findOne({ _id: leaveRequestId, company }).lean();
    if (!candidate) throw generateError("Leave request not found", 404);
    if (candidate.status !== "approved") {
      throw generateError("Only approved leave can have a cancellation request", 409);
    }
    if (String(candidate.employee) !== String(actor._id)) {
      throw generateError("Only the employee can request cancellation of approved leave", 403);
    }
    const existing = await LeaveCancellationRequest.exists({
      company,
      leaveRequest: leaveRequestId,
      status: "submitted",
    });
    if (existing) throw generateError("A cancellation request is already pending for this leave", 409);

    const employee = await User.findOne({
      _id: candidate.employee,
      company,
      deletedAt: { $exists: false },
      is_enabled: { $ne: false },
    })
      .select("_id name username code role department team officeLocation reportingManager")
      .lean();
    if (!employee) throw generateError("Employee not found or disabled", 404);
    const workflow = await resolveCancellationWorkflow(company, candidate);
    let cancellationId: mongoose.Types.ObjectId | null = null;

    await mongoose.connection.transaction(async (session) => {
      const leaveRequest = await LeaveRequest.findOne({
        _id: leaveRequestId,
        company,
        status: "approved",
      }).session(session);
      if (!leaveRequest) throw generateError("Approved leave status changed; refresh and try again", 409);
      const pending = await LeaveCancellationRequest.exists({
        company,
        leaveRequest: leaveRequestId,
        status: "submitted",
      }).session(session);
      if (pending) throw generateError("A cancellation request is already pending for this leave", 409);

      const cancellation = new LeaveCancellationRequest({
        company,
        leaveRequest: leaveRequest._id,
        employee: employee._id,
        departmentNameSnapshot: text(employee.department),
        teamNameSnapshot: text(employee.team),
        officeLocation: employee.officeLocation || null,
        reportingManager: employee.reportingManager || null,
        reason,
        status: "submitted",
        history: [cancellationEvent(actor, "submitted", reason)],
        requestedAt: new Date(),
        createdBy: actor._id,
      });
      cancellationId = cancellation._id as mongoose.Types.ObjectId;
      const approval = await createApprovalInstance({
        company,
        requestType: "leave_request",
        requestModel: "LeaveCancellationRequest",
        requestId: cancellation._id as mongoose.Types.ObjectId,
        employee: {
          ...employee,
          departmentNameSnapshot: text(employee.department),
          teamNameSnapshot: text(employee.team),
        },
        workflowId: workflow.workflowId,
        workflowVersionId: workflow.workflowVersionId,
        actorId: actor._id,
        session,
      });
      syncApprovalState(cancellation, approval);
      leaveRequest.cancellationRequest = cancellation._id as mongoose.Types.ObjectId;
      leaveRequest.cancellationStatus = approval.finalApproved ? "approved" : "submitted";
      leaveRequest.history.push(leaveEvent(actor, "cancellation_requested", reason) as any);
      if (approval.finalApproved) {
        await finalizeApprovedLeaveCancellation({
          request: leaveRequest,
          actorId: actor._id,
          reason,
          session,
        });
        cancellation.status = "approved";
        cancellation.currentApprovers = [] as any;
        cancellation.approver = null;
        cancellation.approverNameSnapshot = "";
        cancellation.decidedAt = new Date();
        cancellation.decidedBy = actor._id;
        cancellation.decisionComment = "Auto-approved by approval workflow";
        cancellation.history.push(
          cancellationEvent(actor, "approved", "Auto-approved by approval workflow") as any
        );
        leaveRequest.status = "cancelled";
        leaveRequest.cancelledAt = new Date();
        leaveRequest.cancelledBy = actor._id;
        leaveRequest.cancellationReason = reason;
        leaveRequest.history.push(
          leaveEvent(actor, "cancelled", "Cancellation request auto-approved") as any
        );
      }
      await cancellation.save({ session });
      await leaveRequest.save({ session });
    });

    const created = await populateCancellationRequest(
      LeaveCancellationRequest.findById(cancellationId)
    );
    return res.status(201).json({
      success: true,
      data: created,
      message: created.status === "approved"
        ? "Leave cancellation auto-approved and balance restored"
        : "Leave cancellation request submitted",
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      return next(generateError("A cancellation request is already pending for this leave", 409));
    }
    next(error);
  }
}

export async function listLeaveCancellationRequestsService(req: any, res: Response, next: NextFunction) {
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
        throw generateError("You do not have permission to view leave cancellation requests", 403);
      }
      Object.assign(match, buildLeaveRequestScope(actor, PERMISSION_KEYS.VIEW_LEAVE_REQUESTS, false));
    } else {
      throw generateError("scope must be mine, approvals, or company", 400);
    }
    const statuses = text(req.query?.status)
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (statuses.some((status) => !LEAVE_CANCELLATION_REQUEST_STATUSES.includes(status as any))) {
      throw generateError("Invalid leave cancellation status", 400);
    }
    if (statuses.length) match.status = { $in: statuses };

    const [items, total] = await Promise.all([
      populateCancellationRequest(
        LeaveCancellationRequest.find(match)
          .sort({ requestedAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
      ),
      LeaveCancellationRequest.countDocuments(match),
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

export async function getLeaveCancellationRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    const request = await populateCancellationRequest(
      LeaveCancellationRequest.findOne({
        _id: objectId(req.params.cancellationRequestId, "leave cancellation request id"),
        company,
      })
    );
    if (!request) throw generateError("Leave cancellation request not found", 404);
    ensureCanView(actor, request);
    return res.status(200).json({ success: true, data: request });
  } catch (error) {
    next(error);
  }
}

export async function approveLeaveCancellationRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const requestId = objectId(req.params.cancellationRequestId, "leave cancellation request id");
    let finalApproved = true;
    let currentStepName: string | null = null;
    await mongoose.connection.transaction(async (session) => {
      const cancellation = await LeaveCancellationRequest.findOne({
        _id: requestId,
        company,
        status: "submitted",
      }).session(session);
      if (!cancellation) throw generateError("Only a submitted cancellation request can be approved", 409);
      const leaveRequest = await LeaveRequest.findOne({
        _id: cancellation.leaveRequest,
        company,
        status: "approved",
      }).session(session);
      if (!leaveRequest) throw generateError("The approved leave is no longer available for cancellation", 409);
      const approval = await approveApprovalInstance({
        company,
        requestModel: "LeaveCancellationRequest",
        requestId,
        actor,
        comment: req.body?.comment,
        session,
      });
      syncApprovalState(cancellation, approval);
      finalApproved = approval.finalApproved;
      currentStepName = approval.currentStepName;
      if (finalApproved) {
        await finalizeApprovedLeaveCancellation({
          request: leaveRequest,
          actorId: actor._id,
          reason: cancellation.reason,
          session,
        });
        cancellation.status = "approved";
        cancellation.currentApprovers = [] as any;
        cancellation.approver = null;
        cancellation.approverNameSnapshot = "";
        cancellation.decidedAt = new Date();
        cancellation.decidedBy = actor._id;
        cancellation.decisionComment = text(req.body?.comment);
        cancellation.history.push(
          cancellationEvent(actor, "approved", req.body?.comment) as any
        );
        leaveRequest.status = "cancelled";
        leaveRequest.cancellationStatus = "approved";
        leaveRequest.cancelledAt = new Date();
        leaveRequest.cancelledBy = actor._id;
        leaveRequest.cancellationReason = cancellation.reason;
        leaveRequest.history.push(leaveEvent(actor, "cancelled", cancellation.reason) as any);
      }
      await cancellation.save({ session });
      await leaveRequest.save({ session });
    });
    const updated = await populateCancellationRequest(LeaveCancellationRequest.findById(requestId));
    return res.status(200).json({
      success: true,
      data: updated,
      message: finalApproved
        ? "Leave cancellation approved and balance restored"
        : `Approval recorded${currentStepName ? `; awaiting ${currentStepName}` : ""}`,
    });
  } catch (error) {
    next(error);
  }
}

export async function rejectLeaveCancellationRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const requestId = objectId(req.params.cancellationRequestId, "leave cancellation request id");
    const comment = text(req.body?.comment);
    if (comment.length < 3) throw generateError("A rejection reason is required", 422);
    await mongoose.connection.transaction(async (session) => {
      const cancellation = await LeaveCancellationRequest.findOne({
        _id: requestId,
        company,
        status: "submitted",
      }).session(session);
      if (!cancellation) throw generateError("Only a submitted cancellation request can be rejected", 409);
      const leaveRequest = await LeaveRequest.findOne({
        _id: cancellation.leaveRequest,
        company,
        status: "approved",
      }).session(session);
      if (!leaveRequest) throw generateError("The approved leave is no longer active", 409);
      await rejectApprovalInstance({
        company,
        requestModel: "LeaveCancellationRequest",
        requestId,
        actor,
        comment,
        session,
      });
      cancellation.status = "rejected";
      cancellation.currentApprovers = [] as any;
      cancellation.approver = null;
      cancellation.approverNameSnapshot = "";
      cancellation.decidedAt = new Date();
      cancellation.decidedBy = actor._id;
      cancellation.decisionComment = comment;
      cancellation.history.push(cancellationEvent(actor, "rejected", comment) as any);
      leaveRequest.cancellationStatus = "rejected";
      leaveRequest.history.push(leaveEvent(actor, "cancellation_rejected", comment) as any);
      await cancellation.save({ session });
      await leaveRequest.save({ session });
    });
    const updated = await populateCancellationRequest(LeaveCancellationRequest.findById(requestId));
    return res.status(200).json({
      success: true,
      data: updated,
      message: "Leave cancellation request rejected; approved leave remains active",
    });
  } catch (error) {
    next(error);
  }
}

export async function withdrawLeaveCancellationRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const requestId = objectId(req.params.cancellationRequestId, "leave cancellation request id");
    const comment = text(req.body?.comment) || "Cancellation request withdrawn by employee";
    await mongoose.connection.transaction(async (session) => {
      const cancellation = await LeaveCancellationRequest.findOne({
        _id: requestId,
        company,
        status: "submitted",
      }).session(session);
      if (!cancellation) throw generateError("Only a submitted cancellation request can be withdrawn", 409);
      if (String(cancellation.employee) !== String(actor._id)) {
        throw generateError("Only the employee can withdraw this cancellation request", 403);
      }
      const leaveRequest = await LeaveRequest.findOne({
        _id: cancellation.leaveRequest,
        company,
        status: "approved",
      }).session(session);
      if (!leaveRequest) throw generateError("The approved leave is no longer active", 409);
      await cancelApprovalInstance({
        company,
        requestModel: "LeaveCancellationRequest",
        requestId,
        actor,
        comment,
        session,
      });
      cancellation.status = "withdrawn";
      cancellation.currentApprovers = [] as any;
      cancellation.approver = null;
      cancellation.approverNameSnapshot = "";
      cancellation.decidedAt = new Date();
      cancellation.decidedBy = actor._id;
      cancellation.decisionComment = comment;
      cancellation.history.push(cancellationEvent(actor, "withdrawn", comment) as any);
      leaveRequest.cancellationStatus = "withdrawn";
      leaveRequest.history.push(leaveEvent(actor, "cancellation_withdrawn", comment) as any);
      await cancellation.save({ session });
      await leaveRequest.save({ session });
    });
    const updated = await populateCancellationRequest(LeaveCancellationRequest.findById(requestId));
    return res.status(200).json({
      success: true,
      data: updated,
      message: "Leave cancellation request withdrawn; approved leave remains active",
    });
  } catch (error) {
    next(error);
  }
}
