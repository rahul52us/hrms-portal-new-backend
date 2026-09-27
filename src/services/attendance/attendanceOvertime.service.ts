import { NextFunction, Response } from "express";
import mongoose, { ClientSession } from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceOvertimeReview from "../../schemas/Attendance/AttendanceOvertimeReview.schema";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";
import CompOffClaim from "../../schemas/CompOff/CompOffClaim.schema";
import User from "../../schemas/User/User";
import AttendancePolicyVersion from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import {
  approveApprovalInstance,
  cancelApprovalInstance,
  createApprovalInstance,
  rejectApprovalInstance,
} from "../approval/approvalEngine.service";
import {
  buildLeaveRequestScope,
  getLeaveActor,
  resolveEmployeeRequestCompanyId,
} from "../leave/leaveAccess.utils";
import { createRequestNotifications } from "../notification/notification.service";
import { PERMISSION_KEYS } from "../permissions/permission.utils";
import { overtimeMinutesForApproval } from "./attendanceOvertime.utils";
import { assertAttendanceDateWritable } from "./attendancePeriod.service";

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

function reviewEvent(actor: any, action: string, comment?: unknown) {
  return {
    action,
    actor: actor?._id || null,
    actorRole: text(actor?.role || "system"),
    comment: text(comment),
    at: new Date(),
  };
}

function syncApproval(review: any, approval: any) {
  review.approvalInstance = approval.instance._id;
  review.currentApprovers = approval.currentApprovers || [];
  review.approver = approval.currentApprovers?.[0] || null;
  const currentStep = approval.instance.steps?.find(
    (step: any) => step.order === approval.instance.currentStepOrder
  );
  review.approverNameSnapshot = currentStep?.nameSnapshot || "";
}

function populateReview(query: any) {
  return query
    .populate("employee", "name username code role designation")
    .populate("approver", "name username code role designation")
    .populate("currentApprovers", "name username code role designation")
    .populate({
      path: "approvalInstance",
      populate: [
        { path: "steps.approvers.user", select: "name username code role designation" },
        { path: "history.actor", select: "name username code role" },
      ],
    });
}

async function notifyOvertimeReview(options: {
  review: any;
  recipients: any[];
  actorId?: any;
  event: "awaiting_approval" | "approved" | "rejected" | "superseded";
  employeeName?: string;
  stepOrder?: number | null;
  session: ClientSession;
}) {
  const titles = {
    awaiting_approval: "Overtime needs approval",
    approved: "Overtime approved",
    rejected: "Overtime rejected",
    superseded: "Overtime review superseded",
  };
  const employeeName = options.employeeName || "Employee";
  const messages = {
    awaiting_approval: `${employeeName}'s ${options.review.overtimeMinutesSnapshot} overtime minute(s) for ${options.review.attendanceDate} need your decision.`,
    approved: `Your ${options.review.overtimeMinutesSnapshot} overtime minute(s) for ${options.review.attendanceDate} were approved.`,
    rejected: `Your overtime for ${options.review.attendanceDate} was rejected.`,
    superseded: `Your overtime review for ${options.review.attendanceDate} was superseded by an attendance change.`,
  };
  await createRequestNotifications(
    {
      company: options.review.company,
      recipients: options.recipients,
      actor: options.actorId,
      eventType: `attendance_overtime.${options.event}`,
      entityType: "attendance_overtime_review",
      entityId: options.review._id,
      title: titles[options.event],
      message: messages[options.event],
      actionUrl: options.event === "awaiting_approval" ? "/dashboard" : "/dashboard/attendance",
      category: options.event === "awaiting_approval" ? "approval" : "attendance",
      metadata: {
        requestType: "attendance_overtime_review",
        attendanceDate: options.review.attendanceDate,
        overtimeMinutes: options.review.overtimeMinutesSnapshot,
      },
      dedupeEventKey: options.event === "awaiting_approval"
        ? `attendance_overtime.awaiting_approval:step:${options.stepOrder}`
        : undefined,
    },
    options.session
  );
}

export async function assertNoActiveCompOffClaimForAttendanceRecord(
  attendanceRecordId: unknown,
  session: ClientSession
) {
  const activeClaim = await CompOffClaim.findOne({
    attendanceRecord: attendanceRecordId,
    status: { $in: ["submitted", "approved"] },
  })
    .select("_id status")
    .session(session)
    .lean();
  if (activeClaim) {
    throw generateError(
      "Withdraw or revoke the active comp-off claim before changing this attendance record",
      409
    );
  }
}

export async function supersedeOvertimeReviewForRecord(options: {
  record: any;
  actor?: any;
  reason: string;
  session: ClientSession;
}) {
  const reviewId = options.record.overtimeReview;
  if (reviewId) {
    const review = await AttendanceOvertimeReview.findOne({
      _id: reviewId,
      company: options.record.company,
      status: { $in: ["pending", "approved", "rejected"] },
    }).session(options.session);
    if (review && review.status !== "superseded") {
      if (review.approvalInstance) {
        await cancelApprovalInstance({
          company: review.company,
          requestModel: "AttendanceOvertimeReview",
          requestId: review._id as mongoose.Types.ObjectId,
          actor: options.actor || { _id: null, name: "System" },
          comment: options.reason,
          session: options.session,
        });
      }
      review.status = "superseded";
      review.currentApprovers = [];
      review.approver = null;
      review.approverNameSnapshot = "";
      review.decidedAt = new Date();
      review.decidedBy = options.actor?._id || null;
      review.decisionComment = options.reason;
      review.history.push(reviewEvent(options.actor, "superseded", options.reason) as any);
      await review.save({ session: options.session });
      await notifyOvertimeReview({
        review,
        recipients: [review.employee],
        actorId: options.actor?._id,
        event: "superseded",
        session: options.session,
      });
    }
  }
  options.record.overtimeReview = null;
  options.record.overtimeApprovalStatus = "not_required";
  options.record.approvedOvertimeMinutes = 0;
}

export async function ensureOvertimeReviewForFinalizedRecord(options: {
  record: any;
  actor?: any;
  session: ClientSession;
}) {
  const { record, session } = options;
  if (record.state !== "finalized") {
    throw generateError("Finalize attendance before creating an overtime review", 409);
  }
  if (!record.attendancePolicyVersion) {
    throw generateError("Attendance policy snapshot is unavailable for overtime review", 409);
  }
  const policyVersion: any = await AttendancePolicyVersion.findOne({
    _id: record.attendancePolicyVersion,
    company: record.company,
  }).session(session).lean();
  if (!policyVersion) {
    throw generateError("Attendance policy snapshot is unavailable for overtime review", 409);
  }

  const approvalRules = policyVersion.rules?.overtimeApproval || {};
  const approvalRequired = approvalRules.required === true;
  const reviewMinutes = overtimeMinutesForApproval(record);
  record.overtimeApprovalRequiredSnapshot = approvalRequired;

  if (!approvalRequired || reviewMinutes <= 0) {
    await supersedeOvertimeReviewForRecord({
      record,
      actor: options.actor,
      reason: approvalRequired
        ? "No overtime minutes require approval"
        : "Overtime approval is not required by the attendance policy",
      session,
    });
    record.overtimeApprovalRequiredSnapshot = approvalRequired;
    record.overtimeApprovalStatus = "not_required";
    record.approvedOvertimeMinutes = approvalRequired ? 0 : reviewMinutes;
    await record.save({ session });
    return null;
  }

  if (record.overtimeReview) {
    const current = await AttendanceOvertimeReview.findOne({
      _id: record.overtimeReview,
      company: record.company,
      attendanceRecord: record._id,
      attendanceRevisionNumber: record.revisionNumber,
    }).session(session);
    if (current) return current;
  }

  await supersedeOvertimeReviewForRecord({
    record,
    actor: options.actor,
    reason: "Attendance was finalized with a newer revision",
    session,
  });

  const employee: any = await User.findOne({
    _id: record.employee,
    company: record.company,
    deletedAt: { $exists: false },
  })
    .select("_id name username code role department team officeLocation reportingManager")
    .session(session)
    .lean();
  if (!employee) throw generateError("Employee is unavailable for overtime review", 409);

  const [review] = await AttendanceOvertimeReview.create(
    [{
      company: record.company,
      employee: record.employee,
      attendanceRecord: record._id,
      attendanceDate: record.attendanceDate,
      attendanceRevisionNumber: record.revisionNumber,
      overtimeMinutesSnapshot: reviewMinutes,
      workedMinutesSnapshot: Number(record.workedMinutes || 0),
      dayTypeSnapshot: record.dayTypeSnapshot || "working_day",
      status: "pending",
      attendancePolicyAssignment: record.attendancePolicyAssignment || null,
      attendancePolicy: record.attendancePolicy,
      attendancePolicyVersion: record.attendancePolicyVersion,
      attendancePolicyVersionNumber: Number(policyVersion.versionNumber || 1),
      departmentNameSnapshot: record.departmentNameSnapshot || "",
      teamNameSnapshot: record.teamNameSnapshot || "",
      officeLocation: record.officeLocation || null,
      officeLocationNameSnapshot: record.officeLocationNameSnapshot || "",
      reportingManager: record.reportingManager || null,
      currentApprovers: [],
      history: [reviewEvent(options.actor, "pending", "Created when attendance was finalized")],
      submittedAt: new Date(),
      createdBy: options.actor?._id || null,
    }],
    { session }
  );

  const approval = await createApprovalInstance({
    company: objectId(record.company, "company id"),
    requestType: "attendance_overtime_review",
    requestModel: "AttendanceOvertimeReview",
    requestId: review._id as mongoose.Types.ObjectId,
    employee: {
      ...employee,
      departmentId: record.department,
      departmentNameSnapshot: record.departmentNameSnapshot || employee.department || "",
      teamNameSnapshot: record.teamNameSnapshot || employee.team || "",
      officeLocation: record.officeLocation || employee.officeLocation || null,
      reportingManager: record.reportingManager || employee.reportingManager || null,
    },
    workflowId: approvalRules.approvalWorkflow,
    workflowVersionId: approvalRules.approvalWorkflowVersion,
    actorId: options.actor?._id || null,
    session,
  });
  syncApproval(review, approval);
  if (approval.finalApproved) {
    review.status = "approved";
    review.currentApprovers = [];
    review.approver = null;
    review.approverNameSnapshot = "";
    review.decidedAt = new Date();
    review.decidedBy = options.actor?._id || null;
    review.decisionComment = "Auto-approved by approval workflow";
    review.history.push(reviewEvent(options.actor, "approved", review.decisionComment) as any);
  }
  await review.save({ session });

  record.overtimeReview = review._id;
  record.overtimeApprovalStatus = approval.finalApproved ? "approved" : "pending";
  record.approvedOvertimeMinutes = approval.finalApproved ? reviewMinutes : 0;
  await record.save({ session });

  if (approval.finalApproved) {
    await notifyOvertimeReview({
      review,
      recipients: [review.employee],
      actorId: options.actor?._id,
      event: "approved",
      session,
    });
  } else {
    await notifyOvertimeReview({
      review,
      recipients: approval.currentApprovers,
      actorId: options.actor?._id,
      event: "awaiting_approval",
      employeeName: text(employee.name || employee.username) || "Employee",
      stepOrder: approval.instance.currentStepOrder,
      session,
    });
  }
  return review;
}

export async function listAttendanceOvertimeReviewsService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.query?.companyId, "attendance overtime");
    const { page, limit, skip } = pagination(req.query);
    const scope = text(req.query?.scope || "mine");
    const match: any = { company };
    if (scope === "mine") match.employee = actor._id;
    else if (scope === "approvals") match.currentApprovers = actor._id;
    else Object.assign(match, buildLeaveRequestScope(actor, PERMISSION_KEYS.VIEW_ATTENDANCE));
    const status = text(req.query?.status);
    if (["pending", "approved", "rejected", "superseded"].includes(status)) match.status = status;
    const [items, total] = await Promise.all([
      populateReview(
        AttendanceOvertimeReview.find(match).sort({ submittedAt: -1 }).skip(skip).limit(limit)
      ),
      AttendanceOvertimeReview.countDocuments(match),
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

export async function approveAttendanceOvertimeReviewService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId, "attendance overtime");
    const reviewId = objectId(req.params.reviewId, "overtime review id");
    let finalApproved = false;
    let currentStepName: string | null = null;
    await mongoose.connection.transaction(async (session) => {
      const review: any = await AttendanceOvertimeReview.findOne({
        _id: reviewId,
        company,
        status: "pending",
      }).session(session);
      if (!review) throw generateError("Only pending overtime can be approved", 409);
      await assertAttendanceDateWritable({ company, attendanceDate: review.attendanceDate, session });
      const record: any = await AttendanceRecord.findOne({
        _id: review.attendanceRecord,
        company,
        employee: review.employee,
        state: "finalized",
      }).session(session);
      if (
        !record ||
        Number(record.revisionNumber) !== Number(review.attendanceRevisionNumber) ||
        overtimeMinutesForApproval(record) !== Number(review.overtimeMinutesSnapshot)
      ) {
        throw generateError("Attendance changed after this overtime review was created", 409);
      }
      const previousApprovers = new Set((review.currentApprovers || []).map(String));
      const approval = await approveApprovalInstance({
        company,
        requestModel: "AttendanceOvertimeReview",
        requestId: reviewId,
        actor,
        comment: req.body?.comment,
        session,
      });
      syncApproval(review, approval);
      finalApproved = approval.finalApproved;
      currentStepName = approval.currentStepName;
      if (finalApproved) {
        review.status = "approved";
        review.currentApprovers = [];
        review.approver = null;
        review.approverNameSnapshot = "";
        review.decidedAt = new Date();
        review.decidedBy = actor._id;
        review.decisionComment = text(req.body?.comment);
        review.history.push(reviewEvent(actor, "approved", req.body?.comment) as any);
        record.overtimeApprovalStatus = "approved";
        record.approvedOvertimeMinutes = review.overtimeMinutesSnapshot;
        await record.save({ session });
        await notifyOvertimeReview({
          review,
          recipients: [review.employee],
          actorId: actor._id,
          event: "approved",
          session,
        });
      } else {
        const nextApprovers = approval.currentApprovers.filter(
          (item: any) => !previousApprovers.has(String(item))
        );
        if (nextApprovers.length) {
          const employee: any = await User.findById(review.employee)
            .select("name username")
            .session(session)
            .lean();
          await notifyOvertimeReview({
            review,
            recipients: nextApprovers,
            actorId: actor._id,
            event: "awaiting_approval",
            employeeName: text(employee?.name || employee?.username) || "Employee",
            stepOrder: approval.instance.currentStepOrder,
            session,
          });
        }
      }
      await review.save({ session });
    });
    const updated = await populateReview(AttendanceOvertimeReview.findById(reviewId));
    return res.status(200).json({
      success: true,
      data: updated,
      message: finalApproved
        ? "Overtime approved"
        : `Approval recorded${currentStepName ? `; awaiting ${currentStepName}` : ""}`,
    });
  } catch (error) {
    next(error);
  }
}

export async function rejectAttendanceOvertimeReviewService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId, "attendance overtime");
    const reviewId = objectId(req.params.reviewId, "overtime review id");
    const comment = text(req.body?.comment);
    if (comment.length < 3) throw generateError("A rejection reason of at least 3 characters is required", 422);
    await mongoose.connection.transaction(async (session) => {
      const review: any = await AttendanceOvertimeReview.findOne({
        _id: reviewId,
        company,
        status: "pending",
      }).session(session);
      if (!review) throw generateError("Only pending overtime can be rejected", 409);
      await assertAttendanceDateWritable({ company, attendanceDate: review.attendanceDate, session });
      await rejectApprovalInstance({
        company,
        requestModel: "AttendanceOvertimeReview",
        requestId: reviewId,
        actor,
        comment,
        session,
      });
      review.status = "rejected";
      review.currentApprovers = [];
      review.approver = null;
      review.approverNameSnapshot = "";
      review.decidedAt = new Date();
      review.decidedBy = actor._id;
      review.decisionComment = comment;
      review.history.push(reviewEvent(actor, "rejected", comment) as any);
      await review.save({ session });
      await AttendanceRecord.updateOne(
        { _id: review.attendanceRecord, company, overtimeReview: review._id },
        { $set: { overtimeApprovalStatus: "rejected", approvedOvertimeMinutes: 0 } },
        { session }
      );
      await notifyOvertimeReview({
        review,
        recipients: [review.employee],
        actorId: actor._id,
        event: "rejected",
        session,
      });
    });
    const updated = await populateReview(AttendanceOvertimeReview.findById(reviewId));
    return res.status(200).json({ success: true, data: updated, message: "Overtime rejected" });
  } catch (error) {
    next(error);
  }
}
