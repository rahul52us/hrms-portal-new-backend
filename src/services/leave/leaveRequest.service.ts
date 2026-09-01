import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import EmployeeLeaveBalance from "../../schemas/Leave/EmployeeLeaveBalance.schema";
import LeaveBalanceTransaction from "../../schemas/Leave/LeaveBalanceTransaction.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import LeaveRequestDateLock from "../../schemas/Leave/LeaveRequestDateLock.schema";
import EmployeeDayRequestLock from "../../schemas/Request/EmployeeDayRequestLock.schema";
import LeaveAttachment from "../../schemas/Leave/LeaveAttachment.schema";
import User from "../../schemas/User/User";
import LeaveType from "../../schemas/WorkforcePolicy/LeaveType.schema";
import LeavePolicyVersion from "../../schemas/WorkforcePolicy/LeavePolicyVersion.schema";
import { resolveEmployeeDayContext } from "../attendance/employeeDayContext.service";
import { PERMISSION_KEYS, hasPermission } from "../permissions/permission.utils";
import {
  buildLeaveRequestScope,
  ensureEmployeeInActorScope,
  getLeaveActor,
  isEmployeeInActorScope,
  resolveLeaveCompanyId,
} from "./leaveAccess.utils";
import {
  LeaveBalanceKey,
  postLeaveBalanceTransaction,
  rebuildLeaveBalanceProjection,
  releasePendingLeaveBalance,
  reserveLeaveBalance,
} from "./leaveBalance.service";
import {
  applyApprovedLeaveToAttendance,
  removeCancelledLeaveFromAttendance,
} from "./leaveAttendance.service";
import { calculateEmployeeLeaveRequest } from "./leaveRequestCalculator.service";
import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";
import { resolveLeaveYear } from "./leaveRequestCalculator.utils";
import { uploadFile } from "../../repository/uploadDoc.repository";
import {
  ensureEmployeeLeaveAccruals,
  runCompanyLeaveAccrualCatchUp,
} from "./leaveAccrual.service";
import {
  consumeReservedCompOffCredits,
  expireCompOffCredits,
  releaseReservedCompOffCredits,
  reserveCompOffCredits,
  reverseConsumedCompOffCredits,
} from "../compOff/compOffCredit.service";
import {
  approveApprovalInstance,
  cancelApprovalInstance,
  createApprovalInstance,
  rejectApprovalInstance,
} from "../approval/approvalEngine.service";
import { resolveEffectiveApprovalWorkflowReference } from "../approval/approvalWorkflow.service";

function text(value: unknown) {
  return String(value || "").trim();
}

function objectId(value: unknown, label: string) {
  const normalized = text((value as any)?._id || value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) {
    throw generateError(`Invalid ${label}`, 400);
  }
  return new mongoose.Types.ObjectId(normalized);
}

function optionalObjectId(value: unknown) {
  const normalized = text((value as any)?._id || value);
  return mongoose.Types.ObjectId.isValid(normalized)
    ? new mongoose.Types.ObjectId(normalized)
    : null;
}

function currentDateKey() {
  return new Date().toISOString().slice(0, 10);
}

async function resolveAttachments(
  value: unknown,
  company: mongoose.Types.ObjectId,
  actorId: mongoose.Types.ObjectId
) {
  if (!Array.isArray(value)) return [];
  if (value.length > 5) throw generateError("A leave request can include at most 5 attachments", 422);
  const ids = value.map((item: any) => objectId(item?._id || item?.attachment || item, "leave attachment id"));
  if (new Set(ids.map(String)).size !== ids.length) {
    throw generateError("A leave attachment can be included only once", 422);
  }
  const records = await LeaveAttachment.find({
    _id: { $in: ids },
    company,
    uploadedBy: actorId,
    linkedRequest: null,
  }).lean();
  if (records.length !== ids.length) {
    throw generateError("One or more leave attachments are invalid, already used, or belong to another user", 422);
  }
  const byId = new Map(records.map((record) => [String(record._id), record]));
  return ids.map((attachment) => {
    const record = byId.get(String(attachment))!;
    return {
      attachment,
      name: record.name,
      url: record.url,
      type: record.type,
      size: record.size,
    };
  });
}

function pagination(query: any) {
  const page = Math.max(1, Number(query?.page || 1));
  const limit = Math.max(1, Math.min(50, Number(query?.limit || 20)));
  return { page, limit, skip: (page - 1) * limit };
}

async function loadEmployee(company: mongoose.Types.ObjectId, employeeId: unknown) {
  const employee = await User.findOne({
    _id: objectId(employeeId, "employee id"),
    company,
    deletedAt: { $exists: false },
  })
    .select(
      "_id company name username code role department team officeLocation reportingManager joiningDate confirmationDate employmentEndDate is_enabled"
    )
    .lean();
  if (!employee) throw generateError("Employee not found in this company", 404);
  return employee;
}

function requestScopeEmployee(request: any) {
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
      (step.approvers || []).some((approver: any) => String(approver.user?._id || approver.user) === String(actor._id))
    )
  );
}

function ensureCanViewRequest(actor: any, request: any) {
  if (isApprovalParticipant(actor, request)) return;
  if (
    !isEmployeeInActorScope(
      actor,
      requestScopeEmployee(request),
      PERMISSION_KEYS.VIEW_LEAVE_REQUESTS
    )
  ) {
    throw generateError("You cannot view this leave request", 403);
  }
}

function ensureCanApproveRequest(actor: any, request: any) {
  if (String(request.employee?._id || request.employee) === String(actor._id)) {
    throw generateError("You cannot approve your own leave request", 403);
  }
  if (String(request.approver?._id || request.approver || "") === String(actor._id)) return;
  if (
    !hasPermission(actor, PERMISSION_KEYS.APPROVE_LEAVE_REQUESTS) ||
    !isEmployeeInActorScope(
      actor,
      requestScopeEmployee(request),
      PERMISSION_KEYS.APPROVE_LEAVE_REQUESTS
    )
  ) {
    throw generateError("You cannot approve leave for this employee", 403);
  }
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

function balanceKey(options: {
  company: any;
  employee: any;
  leaveType: any;
  leaveYearKey: string;
  leaveYearStart: string;
  leaveYearEnd: string;
}): LeaveBalanceKey {
  return {
    company: objectId(options.company, "company id"),
    employee: objectId(options.employee, "employee id"),
    leaveType: objectId(options.leaveType, "leave type id"),
    leaveYearKey: options.leaveYearKey,
    leaveYearStart: options.leaveYearStart,
    leaveYearEnd: options.leaveYearEnd,
  };
}

function requestBalanceSegments(request: any) {
  const segments = new Map<string, any>();
  for (const day of request.dayBreakdown || []) {
    const units = Number(day.chargedUnits || 0);
    if (units <= 0) continue;
    const existing = segments.get(day.leaveYearKey);
    segments.set(day.leaveYearKey, {
      leaveYearKey: day.leaveYearKey,
      leaveYearStart: day.leaveYearStart,
      leaveYearEnd: day.leaveYearEnd,
      chargedUnits: Number(((existing?.chargedUnits || 0) + units).toFixed(4)),
      firstAttendanceDate: existing?.firstAttendanceDate || day.attendanceDate,
      lastAttendanceDate: day.attendanceDate,
      entitlementMode: day.entitlementMode || request.entitlementModeSnapshot || "fixed",
      leavePolicyAssignment: day.leavePolicyAssignment,
      leavePolicy: day.leavePolicy,
      leavePolicyVersion: day.leavePolicyVersion,
    });
  }
  return Array.from(segments.values());
}

function populateRequest(query: any) {
  return query
    .populate("employee", "name username code role department team officeLocation designation reportingManager")
    .populate("leaveType", "name code color unit paid balanceTracked")
    .populate("approver", "name username code role designation")
    .populate("currentApprovers", "name username code role designation")
    .populate({
      path: "approvalInstance",
      populate: [
        { path: "steps.approvers.user", select: "name username code role designation" },
        { path: "history.actor", select: "name username code role" },
      ],
    })
    .populate("history.actor", "name username role");
}

async function resolveLeaveApprovalWorkflow(company: mongoose.Types.ObjectId, calculation: any, leaveTypeId: any) {
  const versionIds = Array.from(
    new Set(
      (calculation.dayBreakdown || [])
        .filter((day: any) => Number(day.chargedUnits || 0) > 0)
        .map((day: any) => text(day.leavePolicyVersion))
        .filter(mongoose.Types.ObjectId.isValid)
    )
  ).map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!versionIds.length) {
    throw generateError("Approval workflow setup is incomplete because no leave policy version was resolved", 409);
  }

  const versions = await LeavePolicyVersion.find({
    _id: { $in: versionIds },
    company,
    status: "published",
  })
    .select("_id rules")
    .lean();
  if (versions.length !== versionIds.length) {
    throw generateError("One or more leave policy versions are unavailable", 409);
  }

  const references = versions.map((version: any) => {
    const rule = (version.rules || []).find((item: any) => String(item.leaveType) === String(leaveTypeId));
    if (!rule) throw generateError("The selected leave type is missing from its resolved policy version", 409);
    const workflowId = text(rule.requestApprovalWorkflow);
    if (!mongoose.Types.ObjectId.isValid(workflowId)) {
      throw generateError(
        `Approval workflow setup is incomplete for ${rule.leaveTypeCodeSnapshot || "this leave type"}`,
        409
      );
    }
    return {
      workflowId,
      setupLabel: `${rule.leaveTypeCodeSnapshot || "Leave"} requests`,
    };
  });
  const keys = new Set(references.map((reference) => reference.workflowId));
  if (keys.size > 1) {
    throw generateError(
      "The selected dates use different leave approval workflows. Submit separate requests for each workflow period",
      422
    );
  }
  const reference = references[0];
  const effective = await resolveEffectiveApprovalWorkflowReference({
    company,
    workflowId: reference.workflowId,
    requestType: "leave_request",
    at: new Date(),
    setupLabel: reference.setupLabel,
  });
  return {
    workflowId: effective.workflow,
    workflowVersionId: effective.version,
    workflowVersionNumber: effective.versionNumber,
  };
}

function syncRequestApprovalState(request: any, approval: any) {
  request.approvalInstance = approval.instance._id;
  request.currentApprovers = approval.currentApprovers;
  request.approver = approval.currentApprovers[0] || null;
  const current = approval.instance.steps?.find((step: any) => step.order === approval.instance.currentStepOrder);
  const currentApprover = current?.approvers?.find((item: any) => item.status === "pending");
  request.approverNameSnapshot = currentApprover?.nameSnapshot || "";
}

export async function previewLeaveRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const employeeId = req.body?.employeeId || actor._id;
    const employee = await loadEmployee(company, employeeId);
    ensureEmployeeInActorScope(
      actor,
      employee,
      PERMISSION_KEYS.VIEW_LEAVE_REQUESTS,
      "You cannot preview leave for this employee"
    );
    const result = await calculateEmployeeLeaveRequest({
      companyId: company,
      employeeId: employee._id,
      leaveTypeId: req.body?.leaveTypeId,
      fromDate: text(req.body?.fromDate),
      toDate: text(req.body?.toDate),
      startPortion: req.body?.startPortion,
      endPortion: req.body?.endPortion,
      requestedHours: req.body?.requestedHours,
      attachmentCount: Array.isArray(req.body?.attachments) ? req.body.attachments.length : 0,
    });
    return res.status(200).json({
      success: true,
      data: {
        employee: result.employee,
        leaveType: result.leaveType,
        ...result.calculation,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function createLeaveRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId);
    const employeeId = req.body?.employeeId || actor._id;
    const employee = await loadEmployee(company, employeeId);
    const isSelf = String(employee._id) === String(actor._id);
    if (!isSelf) {
      if (!hasPermission(actor, PERMISSION_KEYS.APPROVE_LEAVE_REQUESTS)) {
        throw generateError("You do not have permission to submit leave on behalf of employees", 403);
      }
      ensureEmployeeInActorScope(
        actor,
        employee,
        PERMISSION_KEYS.APPROVE_LEAVE_REQUESTS,
        "You cannot submit leave for this employee"
      );
    }

    const reason = text(req.body?.reason);
    if (reason.length < 3) throw generateError("Leave reason must be at least 3 characters", 422);
    const attachments = await resolveAttachments(req.body?.attachments, company, actor._id);
    const result = await calculateEmployeeLeaveRequest({
      companyId: company,
      employeeId: employee._id,
      leaveTypeId: req.body?.leaveTypeId,
      fromDate: text(req.body?.fromDate),
      toDate: text(req.body?.toDate),
      startPortion: req.body?.startPortion,
      endPortion: req.body?.endPortion,
      requestedHours: req.body?.requestedHours,
      attachmentCount: attachments.length,
    });
    const overlap = await LeaveRequest.exists({
      company,
      employee: employee._id,
      status: { $in: ["submitted", "approved"] },
      fromDate: { $lte: text(req.body?.toDate) },
      toDate: { $gte: text(req.body?.fromDate) },
    });
    if (overlap) throw generateError("An active leave request already overlaps these dates", 409);

    const manager = employee.reportingManager
      ? await User.findOne({
          _id: employee.reportingManager,
          company,
          deletedAt: { $exists: false },
          is_enabled: { $ne: false },
        }).select("_id name").lean()
      : null;
    const firstDay = result.calculation.dayBreakdown[0];
    const approvalWorkflow = await resolveLeaveApprovalWorkflow(
      company,
      result.calculation,
      result.leaveType._id
    );
    const request = new LeaveRequest({
      company,
      employee: employee._id,
      leaveType: result.leaveType._id,
      leaveTypeCodeSnapshot: result.leaveType.code,
      leaveTypeNameSnapshot: result.leaveType.name,
      leaveUnit: result.leaveType.unit,
      paid: result.leaveType.paid,
      balanceTracked: result.leaveType.balanceTracked,
      entitlementModeSnapshot: result.calculation.entitlementMode,
      departmentNameSnapshot: firstDay.departmentNameSnapshot || employee.department || "",
      teamNameSnapshot: firstDay.teamNameSnapshot || employee.team || "",
      officeLocation: firstDay.officeLocation || employee.officeLocation || null,
      officeLocationNameSnapshot: firstDay.officeLocationNameSnapshot || "",
      reportingManager: firstDay.reportingManager || employee.reportingManager || null,
      reportingManagerNameSnapshot: firstDay.reportingManagerNameSnapshot || manager?.name || "",
      fromDate: req.body.fromDate,
      toDate: req.body.toDate,
      startPortion: result.calculation.startPortion,
      endPortion: result.calculation.endPortion,
      requestedHours: result.calculation.requestedHours,
      requestedUnits: result.calculation.requestedUnits,
      chargedUnits: result.calculation.chargedUnits,
      dayBreakdown: result.calculation.dayBreakdown,
      reason,
      attachments,
      status: "submitted",
      approver: manager?._id || null,
      approverNameSnapshot: manager?.name || "",
      history: [event(actor, "submitted", isSelf ? undefined : "Submitted on behalf of employee")],
      submittedAt: new Date(),
      createdBy: actor._id,
    });

    await mongoose.connection.transaction(async (session) => {
      const lockDates = result.calculation.dayBreakdown
        .filter((day: any) => Number(day.chargedUnits || 0) > 0)
        .map((day: any) => day.attendanceDate);
      await EmployeeDayRequestLock.create(
        lockDates.map((attendanceDate: string) => ({
          company,
          employee: employee._id,
          attendanceDate,
          requestType: "leave",
          requestModel: "LeaveRequest",
          request: request._id,
        })),
        { session }
      );
      if (result.leaveType.balanceTracked) {
        for (const segment of result.calculation.balanceSegments) {
          if (segment.balanceTracked === false) continue;
          if (segment.entitlementMode === "earned") {
            await expireCompOffCredits({
              company,
              employee: employee._id,
              leaveType: result.leaveType._id,
              asOf: currentDateKey(),
              actorId: actor._id,
              session,
            });
          }
          await reserveLeaveBalance({
            key: balanceKey({
              company,
              employee: employee._id,
              leaveType: result.leaveType._id,
              ...segment,
            }),
            units: segment.chargedUnits,
            maxNegativeBalance: segment.negativeBalanceAllowed ? segment.maxNegativeBalance : 0,
            session,
          });
          if (segment.entitlementMode === "earned") {
            const allocations = await reserveCompOffCredits({
              company,
              employee: employee._id,
              leaveType: result.leaveType._id,
              leaveYearKey: segment.leaveYearKey,
              usage: result.calculation.dayBreakdown
                .filter((day: any) => day.leaveYearKey === segment.leaveYearKey && Number(day.chargedUnits || 0) > 0)
                .map((day: any) => ({
                  attendanceDate: day.attendanceDate,
                  units: Number(day.chargedUnits),
                })),
              session,
            });
            request.compOffAllocations.push(...(allocations as any));
          }
        }
      }
      const approval = await createApprovalInstance({
        company,
        requestType: "leave_request",
        requestModel: "LeaveRequest",
        requestId: request._id,
        employee: {
          ...employee,
          departmentId: firstDay.department,
          departmentNameSnapshot: firstDay.departmentNameSnapshot || employee.department || "",
          teamNameSnapshot: firstDay.teamNameSnapshot || employee.team || "",
          officeLocation: firstDay.officeLocation || employee.officeLocation || null,
          reportingManager: firstDay.reportingManager || employee.reportingManager || null,
        },
        workflowId: approvalWorkflow.workflowId,
        workflowVersionId: approvalWorkflow.workflowVersionId,
        actorId: actor._id,
        session,
      });
      syncRequestApprovalState(request, approval);
      if (approval.finalApproved) {
        await finalizeLeaveApproval(request, actor._id, session);
        request.status = "approved";
        request.decidedAt = new Date();
        request.decidedBy = actor._id;
        request.decisionComment = "Auto-approved by approval workflow";
        request.history.push(event(actor, "approved", "Auto-approved by approval workflow") as any);
      }
      await request.save({ session });
      if (attachments.length) {
        const attachmentIds = attachments.map((item) => item.attachment);
        const linked = await LeaveAttachment.updateMany(
          { _id: { $in: attachmentIds }, company, uploadedBy: actor._id, linkedRequest: null },
          { $set: { linkedRequest: request._id } },
          { session }
        );
        if (linked.modifiedCount !== attachmentIds.length) {
          throw generateError("One or more leave attachments were already used", 409);
        }
      }
    });

    const populated = await populateRequest(LeaveRequest.findById(request._id));
    return res.status(201).json({ success: true, data: populated, message: "Leave request submitted" });
  } catch (error) {
    if ((error as any)?.code === 11000) {
      next(generateError("An active leave request already covers one or more selected work dates", 409));
      return;
    }
    next(error);
  }
}

export async function uploadLeaveAttachmentService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId);
    const name = text(req.body?.name);
    const type = text(req.body?.type).toLowerCase();
    const size = Number(req.body?.size || 0);
    const data = text(req.body?.data);
    const allowedTypes = ["application/pdf", "image/jpeg", "image/png"];
    if (!name || !allowedTypes.includes(type)) {
      throw generateError("Upload a PDF, JPG, or PNG document", 422);
    }
    if (!Number.isFinite(size) || size <= 0 || size > 5 * 1024 * 1024) {
      throw generateError("Leave attachments must be 5 MB or smaller", 422);
    }
    if (!data.startsWith(`data:${type};base64,`)) throw generateError("Attachment data does not match its content type", 422);
    const encoded = data.slice(data.indexOf(",") + 1);
    const actualSize = Buffer.byteLength(encoded, "base64");
    if (actualSize <= 0 || actualSize > 5 * 1024 * 1024 || Math.abs(actualSize - size) > 2) {
      throw generateError("Attachment size does not match the uploaded data", 422);
    }
    const url = await uploadFile({ filename: name, buffer: data });
    const attachment = await LeaveAttachment.create({
      company,
      uploadedBy: actor._id,
      name,
      type,
      size: actualSize,
      url,
    });
    return res.status(201).json({
      success: true,
      data: {
        _id: attachment._id,
        name: attachment.name,
        type: attachment.type,
        size: attachment.size,
        url: attachment.url,
      },
      message: "Leave attachment uploaded",
    });
  } catch (error) {
    next(error);
  }
}

export async function listLeaveRequestsService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    const { page, limit, skip } = pagination(req.query);
    const requestedScope = text(req.query?.scope || "mine").toLowerCase();
    const match: any = { company };
    if (requestedScope === "mine") {
      match.employee = actor._id;
    } else if (requestedScope === "approvals") {
      const legacyScope = buildLeaveRequestScope(actor, PERMISSION_KEYS.APPROVE_LEAVE_REQUESTS, false);
      match.$or = [
        { currentApprovers: actor._id },
        { approvalInstance: null, ...legacyScope },
      ];
    } else if (requestedScope === "company") {
      if (!hasPermission(actor, PERMISSION_KEYS.VIEW_LEAVE_REQUESTS)) {
        throw generateError("You do not have permission to view company leave requests", 403);
      }
      Object.assign(match, buildLeaveRequestScope(actor, PERMISSION_KEYS.VIEW_LEAVE_REQUESTS, false));
    } else {
      throw generateError("scope must be mine, approvals, or company", 400);
    }
    const statuses = text(req.query?.status)
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (statuses.length) match.status = { $in: statuses };
    if (req.query?.employeeId) {
      const employee = await loadEmployee(company, req.query.employeeId);
      ensureEmployeeInActorScope(
        actor,
        employee,
        PERMISSION_KEYS.VIEW_LEAVE_REQUESTS,
        "You cannot view leave for this employee"
      );
      match.employee = employee._id;
    }
    if (req.query?.fromDate) match.toDate = { $gte: parseAttendanceDate(text(req.query.fromDate)).dateKey };
    if (req.query?.toDate) match.fromDate = { $lte: parseAttendanceDate(text(req.query.toDate)).dateKey };

    const [items, total] = await Promise.all([
      populateRequest(LeaveRequest.find(match).sort({ submittedAt: -1, _id: -1 }).skip(skip).limit(limit)),
      LeaveRequest.countDocuments(match),
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

export async function getLeaveRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    const request = await populateRequest(
      LeaveRequest.findOne({ _id: objectId(req.params.requestId, "leave request id"), company })
    );
    if (!request) throw generateError("Leave request not found", 404);
    ensureCanViewRequest(actor, request);
    return res.status(200).json({ success: true, data: request });
  } catch (error) {
    next(error);
  }
}

async function releaseRequestReservation(
  request: any,
  actorId: mongoose.Types.ObjectId,
  session: mongoose.ClientSession
) {
  if (!request.balanceTracked) return;
  for (const segment of requestBalanceSegments(request)) {
    await releasePendingLeaveBalance({
      key: balanceKey({
        company: request.company,
        employee: request.employee,
        leaveType: request.leaveType,
        ...segment,
      }),
      units: segment.chargedUnits,
      session,
    });
  }
  if (request.entitlementModeSnapshot === "earned") {
    await releaseReservedCompOffCredits({
      request,
      actorId,
      asOf: currentDateKey(),
      session,
    });
  }
}

async function releaseRequestDateLocks(request: any, session: mongoose.ClientSession) {
  await Promise.all([
    EmployeeDayRequestLock.deleteMany({
      company: request.company,
      employee: request.employee,
      requestType: "leave",
      request: request._id,
    }).session(session),
    LeaveRequestDateLock.deleteMany({
      company: request.company,
      employee: request.employee,
      request: request._id,
    }).session(session),
  ]);
}

async function finalizeLeaveApproval(
  request: any,
  actorId: mongoose.Types.ObjectId,
  session: mongoose.ClientSession
) {
  if (request.balanceTracked) {
    for (const segment of requestBalanceSegments(request)) {
      const key = balanceKey({
        company: request.company,
        employee: request.employee,
        leaveType: request.leaveType,
        ...segment,
      });
      await releasePendingLeaveBalance({ key, units: segment.chargedUnits, session });
      await postLeaveBalanceTransaction({
        key,
        units: -segment.chargedUnits,
        transactionType: "leave_debit",
        sourceType: "leave_request",
        sourceId: request._id,
        effectiveDate: segment.leaveYearStart > request.fromDate ? segment.leaveYearStart : request.fromDate,
        idempotencyKey: `${request._id}:debit:${segment.leaveYearKey}`,
        reason: `Approved ${request.leaveTypeCodeSnapshot} leave request`,
        leavePolicyAssignment: optionalObjectId(segment.leavePolicyAssignment),
        leavePolicy: optionalObjectId(segment.leavePolicy),
        leavePolicyVersion: optionalObjectId(segment.leavePolicyVersion),
        createdBy: actorId,
        session,
      });
    }
  }
  if (request.entitlementModeSnapshot === "earned") {
    await consumeReservedCompOffCredits(request, session);
  }
  await applyApprovedLeaveToAttendance({ request, actor: actorId, session });
}

export async function approveLeaveRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const requestId = objectId(req.params.requestId, "leave request id");
    const candidate = await LeaveRequest.findOne({ _id: requestId, company }).lean();
    if (!candidate) throw generateError("Leave request not found", 404);
    if (!candidate.approvalInstance) ensureCanApproveRequest(actor, candidate);

    let finalApproved = true;
    let currentStepName: string | null = null;
    await mongoose.connection.transaction(async (session) => {
      const request = await LeaveRequest.findOne({ _id: requestId, company, status: "submitted" }).session(session);
      if (!request) throw generateError("Only a submitted leave request can be approved", 409);
      if (request.approvalInstance) {
        const approval = await approveApprovalInstance({
          company,
          requestModel: "LeaveRequest",
          requestId,
          actor,
          comment: req.body?.comment,
          session,
        });
        syncRequestApprovalState(request, approval);
        finalApproved = approval.finalApproved;
        currentStepName = approval.currentStepName;
      }
      if (finalApproved) {
        await finalizeLeaveApproval(request, actor._id, session);
        request.status = "approved";
        request.currentApprovers = [];
        request.approver = null;
        request.approverNameSnapshot = "";
        request.decidedAt = new Date();
        request.decidedBy = actor._id;
        request.decisionComment = text(req.body?.comment);
        request.history.push(event(actor, "approved", req.body?.comment) as any);
      }
      await request.save({ session });
    });
    const updated = await populateRequest(LeaveRequest.findById(requestId));
    return res.status(200).json({
      success: true,
      data: updated,
      message: finalApproved
        ? "Leave request approved"
        : `Approval recorded${currentStepName ? `; awaiting ${currentStepName}` : ""}`,
    });
  } catch (error) {
    next(error);
  }
}

export async function rejectLeaveRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const requestId = objectId(req.params.requestId, "leave request id");
    const candidate = await LeaveRequest.findOne({ _id: requestId, company }).lean();
    if (!candidate) throw generateError("Leave request not found", 404);
    if (!candidate.approvalInstance) ensureCanApproveRequest(actor, candidate);
    const comment = text(req.body?.comment);
    if (comment.length < 3) throw generateError("A rejection reason is required", 422);

    await mongoose.connection.transaction(async (session) => {
      const request = await LeaveRequest.findOne({ _id: requestId, company, status: "submitted" }).session(session);
      if (!request) throw generateError("Only a submitted leave request can be rejected", 409);
      if (request.approvalInstance) {
        await rejectApprovalInstance({
          company,
          requestModel: "LeaveRequest",
          requestId,
          actor,
          comment,
          session,
        });
      }
      await releaseRequestReservation(request, actor._id, session);
      await releaseRequestDateLocks(request, session);
      request.status = "rejected";
      request.currentApprovers = [];
      request.approver = null;
      request.approverNameSnapshot = "";
      request.decidedAt = new Date();
      request.decidedBy = actor._id;
      request.decisionComment = comment;
      request.history.push(event(actor, "rejected", comment) as any);
      await request.save({ session });
    });
    const updated = await populateRequest(LeaveRequest.findById(requestId));
    return res.status(200).json({ success: true, data: updated, message: "Leave request rejected" });
  } catch (error) {
    next(error);
  }
}

export async function withdrawLeaveRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const requestId = objectId(req.params.requestId, "leave request id");
    await mongoose.connection.transaction(async (session) => {
      const request = await LeaveRequest.findOne({ _id: requestId, company, status: "submitted" }).session(session);
      if (!request) throw generateError("Only a submitted leave request can be withdrawn", 409);
      if (String(request.employee) !== String(actor._id)) {
        throw generateError("Only the employee can withdraw this leave request", 403);
      }
      if (request.approvalInstance) {
        await cancelApprovalInstance({
          company,
          requestModel: "LeaveRequest",
          requestId,
          actor,
          comment: req.body?.comment,
          session,
        });
      }
      await releaseRequestReservation(request, actor._id, session);
      await releaseRequestDateLocks(request, session);
      request.status = "withdrawn";
      request.currentApprovers = [];
      request.approver = null;
      request.approverNameSnapshot = "";
      request.history.push(event(actor, "withdrawn", req.body?.comment) as any);
      await request.save({ session });
    });
    const updated = await populateRequest(LeaveRequest.findById(requestId));
    return res.status(200).json({ success: true, data: updated, message: "Leave request withdrawn" });
  } catch (error) {
    next(error);
  }
}

export async function cancelLeaveRequestService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const requestId = objectId(req.params.requestId, "leave request id");
    const candidate = await LeaveRequest.findOne({ _id: requestId, company }).lean();
    if (!candidate) throw generateError("Leave request not found", 404);
    ensureCanApproveRequest(actor, candidate);
    const comment = text(req.body?.comment);
    if (comment.length < 3) throw generateError("A cancellation reason is required", 422);

    await mongoose.connection.transaction(async (session) => {
      const request = await LeaveRequest.findOne({ _id: requestId, company, status: "approved" }).session(session);
      if (!request) throw generateError("Only an approved leave request can be cancelled", 409);
      if (request.approvalInstance) {
        await cancelApprovalInstance({
          company,
          requestModel: "LeaveRequest",
          requestId,
          actor,
          comment,
          session,
        });
      }
      const debits = await LeaveBalanceTransaction.find({
        company,
        sourceType: "leave_request",
        sourceId: request._id,
        transactionType: "leave_debit",
      }).session(session);
      for (const debit of debits) {
        await postLeaveBalanceTransaction({
          key: balanceKey(debit as any),
          units: Math.abs(debit.units),
          transactionType: "leave_reversal",
          sourceType: "leave_request",
          sourceId: request._id,
          effectiveDate: currentDateKey(),
          idempotencyKey: `${request._id}:reversal:${debit._id}`,
          reason: comment,
          leavePolicyAssignment: debit.leavePolicyAssignment,
          leavePolicy: debit.leavePolicy,
          leavePolicyVersion: debit.leavePolicyVersion,
          reversalOf: debit._id,
          createdBy: actor._id,
          session,
        });
      }
      if (request.entitlementModeSnapshot === "earned") {
        await reverseConsumedCompOffCredits({
          request,
          actorId: actor._id,
          asOf: currentDateKey(),
          session,
        });
      }
      await removeCancelledLeaveFromAttendance({ request, actor: actor._id, session });
      await releaseRequestDateLocks(request, session);
      request.status = "cancelled";
      request.cancelledAt = new Date();
      request.cancelledBy = actor._id;
      request.decisionComment = comment;
      request.history.push(event(actor, "cancelled", comment) as any);
      await request.save({ session });
    });
    const updated = await populateRequest(LeaveRequest.findById(requestId));
    return res.status(200).json({ success: true, data: updated, message: "Approved leave cancelled and balance restored" });
  } catch (error) {
    next(error);
  }
}

export async function getEligibleLeaveTypesService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    const employee = await loadEmployee(company, req.query?.employeeId || actor._id);
    ensureEmployeeInActorScope(
      actor,
      employee,
      PERMISSION_KEYS.VIEW_LEAVE_REQUESTS,
      "You cannot view eligible leave types for this employee"
    );
    const at = parseAttendanceDate(text(req.query?.at || currentDateKey())).dateKey;
    const context = await resolveEmployeeDayContext({ companyId: company, employeeId: employee._id, attendanceDate: at });
    const version = context.policies.leavePolicy?.version;
    if (!version) throw generateError("No leave policy is effective for this employee and date", 422);
    const accrualAt = at < currentDateKey() ? at : currentDateKey();
    await ensureEmployeeLeaveAccruals({
      companyId: company,
      employee,
      asOf: accrualAt,
      context: accrualAt === at ? context : undefined,
    });
    await mongoose.connection.transaction(async (session) => {
      await expireCompOffCredits({
        company,
        employee: employee._id,
        asOf: currentDateKey(),
        actorId: actor._id,
        session,
      });
    });
    const typeIds = (version.rules || []).map((rule: any) => optionalObjectId(rule.leaveType)).filter(Boolean);
    const types = await LeaveType.find({ _id: { $in: typeIds }, company, status: "active" }).lean();
    const typeById = new Map(types.map((type) => [String(type._id), type]));
    const year = resolveLeaveYear(at, Number(version.leaveYearStartMonth || 1), Number(version.leaveYearStartDay || 1));
    const balances = await EmployeeLeaveBalance.find({
      company,
      employee: employee._id,
      leaveType: { $in: typeIds },
      leaveYearKey: year.leaveYearKey,
    }).lean();
    const balanceByType = new Map(balances.map((balance) => [String(balance.leaveType), balance]));
    const items = (version.rules || []).flatMap((rule: any) => {
      const type = typeById.get(String(rule.leaveType));
      if (!type) return [];
      return [{
        leaveType: type,
        rule,
        leaveYear: year,
        balance: balanceByType.get(String(type._id)) || {
          creditedUnits: 0,
          debitedUnits: 0,
          pendingUnits: 0,
          balanceUnits: 0,
          availableUnits: 0,
        },
      }];
    });
    return res.status(200).json({ success: true, data: { employee, at, items } });
  } catch (error) {
    next(error);
  }
}

export async function listLeaveBalancesService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    const employee = await loadEmployee(company, req.query?.employeeId || actor._id);
    ensureEmployeeInActorScope(
      actor,
      employee,
      PERMISSION_KEYS.VIEW_LEAVE_REQUESTS,
      "You cannot view leave balances for this employee"
    );
    const accrualAt = req.query?.at
      ? parseAttendanceDate(text(req.query.at)).dateKey
      : currentDateKey();
    await ensureEmployeeLeaveAccruals({ companyId: company, employee, asOf: accrualAt });
    await mongoose.connection.transaction(async (session) => {
      await expireCompOffCredits({
        company,
        employee: employee._id,
        asOf: currentDateKey(),
        actorId: actor._id,
        session,
      });
    });
    const match: any = { company, employee: employee._id };
    if (req.query?.leaveTypeId) match.leaveType = objectId(req.query.leaveTypeId, "leave type id");
    if (req.query?.at) {
      const at = parseAttendanceDate(text(req.query.at)).dateKey;
      match.leaveYearStart = { $lte: at };
      match.leaveYearEnd = { $gte: at };
    }
    const items = await EmployeeLeaveBalance.find(match)
      .populate("leaveType", "name code color unit paid balanceTracked")
      .sort({ leaveYearStart: -1, leaveType: 1 })
      .lean();
    return res.status(200).json({ success: true, data: { employee, items } });
  } catch (error) {
    next(error);
  }
}

export async function listLeaveTransactionsService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    const employee = await loadEmployee(company, req.query?.employeeId || actor._id);
    ensureEmployeeInActorScope(
      actor,
      employee,
      PERMISSION_KEYS.VIEW_LEAVE_REQUESTS,
      "You cannot view leave transactions for this employee"
    );
    await ensureEmployeeLeaveAccruals({ companyId: company, employee, asOf: currentDateKey() });
    const { page, limit, skip } = pagination(req.query);
    const match: any = { company, employee: employee._id };
    if (req.query?.leaveTypeId) match.leaveType = objectId(req.query.leaveTypeId, "leave type id");
    if (req.query?.leaveYearKey) match.leaveYearKey = text(req.query.leaveYearKey);
    const [items, total] = await Promise.all([
      LeaveBalanceTransaction.find(match)
        .populate("leaveType", "name code color unit")
        .populate("createdBy", "name username role")
        .sort({ effectiveDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      LeaveBalanceTransaction.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: { employee, items },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}

async function resolveAdjustmentContext(options: {
  company: mongoose.Types.ObjectId;
  employee: any;
  leaveTypeId: mongoose.Types.ObjectId;
  effectiveDate: string;
}) {
  const [leaveType, context] = await Promise.all([
    LeaveType.findOne({ _id: options.leaveTypeId, company: options.company }).lean(),
    resolveEmployeeDayContext({
      companyId: options.company,
      employeeId: options.employee._id,
      attendanceDate: options.effectiveDate,
    }),
  ]);
  if (!leaveType) throw generateError("Leave type not found in this company", 404);
  const version = context.policies.leavePolicy?.version;
  if (!version) throw generateError("No leave policy is effective on the adjustment date", 422);
  const rule = (version.rules || []).find((item: any) => String(item.leaveType) === String(leaveType._id));
  if (!rule) throw generateError("The leave type is not part of the effective leave policy", 422);
  const year = resolveLeaveYear(
    options.effectiveDate,
    Number(version.leaveYearStartMonth || 1),
    Number(version.leaveYearStartDay || 1)
  );
  return { leaveType, context, version, rule, year };
}

export async function adjustLeaveBalanceService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId);
    if (!hasPermission(actor, PERMISSION_KEYS.MANAGE_LEAVE_BALANCES)) {
      throw generateError("You do not have permission to adjust leave balances", 403);
    }
    const employee = await loadEmployee(company, req.body?.employeeId);
    ensureEmployeeInActorScope(
      actor,
      employee,
      PERMISSION_KEYS.MANAGE_LEAVE_BALANCES,
      "You cannot adjust leave balances for this employee"
    );
    const leaveTypeId = objectId(req.body?.leaveTypeId, "leave type id");
    const effectiveDate = parseAttendanceDate(text(req.body?.effectiveDate || currentDateKey())).dateKey;
    const units = Number(req.body?.units);
    if (!Number.isFinite(units) || units === 0) throw generateError("Adjustment units must be a non-zero number", 422);
    const reason = text(req.body?.reason);
    if (reason.length < 3) throw generateError("Adjustment reason must be at least 3 characters", 422);
    const transactionType = req.body?.transactionType === "opening_balance"
      ? "opening_balance"
      : "manual_adjustment";
    const resolved = await resolveAdjustmentContext({ company, employee, leaveTypeId, effectiveDate });
    if (resolved.rule.entitlementMode === "earned") {
      throw generateError(
        "Earned comp-off balances can be changed only through comp-off claim and credit workflows",
        422
      );
    }
    const key = balanceKey({
      company,
      employee: employee._id,
      leaveType: leaveTypeId,
      ...resolved.year,
    });
    const idempotencyKey = text(req.body?.idempotencyKey) || `manual:${new mongoose.Types.ObjectId()}`;
    let transaction: any;
    await mongoose.connection.transaction(async (session) => {
      transaction = await postLeaveBalanceTransaction({
        key,
        units,
        transactionType,
        sourceType: "manual",
        effectiveDate,
        idempotencyKey,
        reason,
        leavePolicyAssignment: optionalObjectId(resolved.context.policyReferences.leavePolicy?.assignmentId),
        leavePolicy: optionalObjectId(resolved.context.policyReferences.leavePolicy?.resourceId),
        leavePolicyVersion: optionalObjectId(resolved.context.policyReferences.leavePolicy?.versionId),
        createdBy: actor._id,
        session,
      });
    });
    const balance = await EmployeeLeaveBalance.findOne({ ...key }).populate("leaveType", "name code color unit");
    return res.status(201).json({ success: true, data: { transaction, balance }, message: "Leave balance adjusted" });
  } catch (error) {
    next(error);
  }
}

export async function rebuildLeaveBalanceService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId);
    if (!hasPermission(actor, PERMISSION_KEYS.MANAGE_LEAVE_BALANCES)) {
      throw generateError("You do not have permission to rebuild leave balances", 403);
    }
    const employee = await loadEmployee(company, req.body?.employeeId);
    ensureEmployeeInActorScope(
      actor,
      employee,
      PERMISSION_KEYS.MANAGE_LEAVE_BALANCES,
      "You cannot rebuild leave balances for this employee"
    );
    const leaveTypeId = objectId(req.body?.leaveTypeId, "leave type id");
    const effectiveDate = parseAttendanceDate(text(req.body?.effectiveDate || currentDateKey())).dateKey;
    const resolved = await resolveAdjustmentContext({ company, employee, leaveTypeId, effectiveDate });
    await ensureEmployeeLeaveAccruals({ companyId: company, employee, asOf: effectiveDate });
    const key = balanceKey({ company, employee: employee._id, leaveType: leaveTypeId, ...resolved.year });
    let balance: any;
    await mongoose.connection.transaction(async (session) => {
      balance = await rebuildLeaveBalanceProjection({ key, session });
    });
    return res.status(200).json({ success: true, data: balance, message: "Leave balance projection rebuilt" });
  } catch (error) {
    next(error);
  }
}

export async function runLeaveAccrualCatchUpService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId);
    if (!hasPermission(actor, PERMISSION_KEYS.MANAGE_LEAVE_BALANCES)) {
      throw generateError("You do not have permission to run leave accruals", 403);
    }

    const employeeId = req.body?.employeeId
      ? objectId(req.body.employeeId, "employee id")
      : null;
    if (employeeId) {
      const employee = await loadEmployee(company, employeeId);
      ensureEmployeeInActorScope(
        actor,
        employee,
        PERMISSION_KEYS.MANAGE_LEAVE_BALANCES,
        "You cannot run leave accruals for this employee"
      );
    } else if (!["superadmin", "admin", "hradmin"].includes(text(actor.role).toLowerCase())) {
      throw generateError("Company-wide leave accrual requires company administrator access", 403);
    }

    const requestedAt = text(req.body?.at || currentDateKey());
    const at = parseAttendanceDate(requestedAt).dateKey;
    if (at > currentDateKey()) {
      throw generateError("Leave accruals cannot be posted for a future date", 422);
    }
    const result = await runCompanyLeaveAccrualCatchUp({ companyId: company, employeeId, asOf: at });
    return res.status(200).json({
      success: true,
      data: result,
      message: "Leave accrual catch-up completed",
    });
  } catch (error) {
    next(error);
  }
}
