import mongoose, { ClientSession } from "mongoose";
import { generateError } from "../../config/Error/functions";
import ApprovalInstance from "../../schemas/Approval/ApprovalInstance.schema";
import ApprovalWorkflow from "../../schemas/Approval/ApprovalWorkflow.schema";
import ApprovalWorkflowVersion from "../../schemas/Approval/ApprovalWorkflowVersion.schema";
import Department from "../../schemas/Department/Department.schema";
import User from "../../schemas/User/User";
import { isEmployeeInActorScope, normalizeLeaveRole } from "../leave/leaveAccess.utils";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import {
  approveCurrentApprovalStep,
  rejectCurrentApprovalStep,
} from "./approvalDecision.utils";

type RequestType = "leave_request" | "remote_work_request" | "comp_off_claim";
type RequestModel = "LeaveRequest" | "RemoteWorkRequest" | "CompOffClaim";

function text(value: unknown) {
  return String(value || "").trim();
}

function objectId(value: unknown, label: string) {
  const normalized = text((value as any)?._id || value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function permissionFor(requestType: RequestType) {
  return requestType === "remote_work_request"
    ? PERMISSION_KEYS.APPROVE_REMOTE_WORK_REQUESTS
    : PERMISSION_KEYS.APPROVE_LEAVE_REQUESTS;
}

function scopeEmployee(employee: any) {
  return {
    _id: employee._id,
    department: employee.departmentNameSnapshot || employee.department,
    team: employee.teamNameSnapshot || employee.team,
    officeLocation: employee.officeLocation,
    reportingManager: employee.reportingManager,
  };
}

function approverSnapshot(user: any) {
  return {
    user: user._id,
    nameSnapshot: text(user.name || user.username),
    roleSnapshot: normalizeLeaveRole(user.role),
    status: "waiting",
  };
}

async function activeUser(company: mongoose.Types.ObjectId, userId: unknown, session: ClientSession) {
  const id = text((userId as any)?._id || userId);
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return User.findOne({
    _id: new mongoose.Types.ObjectId(id),
    company,
    deletedAt: { $exists: false },
    is_enabled: { $ne: false },
  })
    .select("_id name username code role reportingManager department team officeLocation hrScope permissions")
    .session(session)
    .lean();
}

async function hrApprovers(options: {
  company: mongoose.Types.ObjectId;
  employee: any;
  requestType: RequestType;
  session: ClientSession;
}) {
  const users = await User.find({
    company: options.company,
    role: { $in: ["admin", "hradmin", "hr", "head hr", "hr admin", "hr executive"] },
    deletedAt: { $exists: false },
    is_enabled: { $ne: false },
  })
    .select("_id name username code role department team officeLocation hrScope permissions")
    .session(options.session)
    .lean();
  const permission = permissionFor(options.requestType);
  const target = scopeEmployee(options.employee);
  return users.filter((user: any) => {
    const actor = { ...user, role: normalizeLeaveRole(user.role) };
    return hasPermission(actor, permission) && isEmployeeInActorScope(actor, target, permission);
  });
}

async function resolveApprovers(options: {
  company: mongoose.Types.ObjectId;
  employee: any;
  requestType: RequestType;
  step: any;
  session: ClientSession;
}) {
  const type = text(options.step.approverType);
  if (type === "reporting_manager") {
    const manager = await activeUser(options.company, options.employee.reportingManager, options.session);
    return manager ? [manager] : [];
  }
  if (type === "manager_manager") {
    const manager = await activeUser(options.company, options.employee.reportingManager, options.session);
    const senior = manager
      ? await activeUser(options.company, manager.reportingManager, options.session)
      : null;
    return senior ? [senior] : [];
  }
  if (type === "department_head") {
    const departmentId = text(options.employee.departmentId || options.employee.department?._id);
    const departmentName = text(options.employee.departmentNameSnapshot || options.employee.department);
    const match: any = { company: options.company, deletedAt: { $exists: false } };
    if (mongoose.Types.ObjectId.isValid(departmentId)) match._id = new mongoose.Types.ObjectId(departmentId);
    else if (departmentName) match.departmentName = new RegExp(`^${departmentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    else return [];
    const department = await Department.findOne(match).select("departmentHead").session(options.session).lean();
    const head = department?.departmentHead
      ? await activeUser(options.company, department.departmentHead, options.session)
      : null;
    return head ? [head] : [];
  }
  if (type === "hr") {
    return hrApprovers(options);
  }
  if (type === "specific_users") {
    const ids = (options.step.approverUserIds || [])
      .map((item: any) => text(item?._id || item))
      .filter(mongoose.Types.ObjectId.isValid)
      .map((item: string) => new mongoose.Types.ObjectId(item));
    return User.find({
      _id: { $in: ids },
      company: options.company,
      deletedAt: { $exists: false },
      is_enabled: { $ne: false },
    })
      .select("_id name username code role")
      .session(options.session)
      .lean();
  }
  return [];
}

export async function createApprovalInstance(options: {
  company: mongoose.Types.ObjectId;
  requestType: RequestType;
  requestModel: RequestModel;
  requestId: mongoose.Types.ObjectId;
  employee: any;
  workflowId: unknown;
  workflowVersionId: unknown;
  actorId: mongoose.Types.ObjectId;
  session: ClientSession;
}) {
  const workflowId = objectId(options.workflowId, "approval workflow id");
  const workflowVersionId = objectId(options.workflowVersionId, "approval workflow version id");
  const [workflow, version] = await Promise.all([
    ApprovalWorkflow.findOne({
      _id: workflowId,
      company: options.company,
      applicableTo: options.requestType,
    }).session(options.session),
    ApprovalWorkflowVersion.findOne({
      _id: workflowVersionId,
      company: options.company,
      workflow: workflowId,
      status: "published",
    }).session(options.session),
  ]);
  if (!workflow || !version) throw generateError("The selected approval workflow is unavailable", 409);

  const seenApprovers = new Set<string>();
  const steps: any[] = [];
  for (const configured of [...(version.steps || [])].sort((left: any, right: any) => left.order - right.order)) {
    let users = await resolveApprovers({ ...options, step: configured });
    let fallbackUsed = false;
    if (!users.length && configured.fallbackToHr && configured.approverType !== "hr") {
      users = await hrApprovers(options);
      fallbackUsed = true;
    }
    const unique = users.filter((user: any) => {
      const key = String(user._id);
      if (seenApprovers.has(key)) return false;
      seenApprovers.add(key);
      return String(user._id) !== String(options.employee._id);
    });
    if (!unique.length && !users.length) {
      throw generateError(`No active approver could be resolved for ${configured.name}`, 422);
    }
    steps.push({
      order: configured.order,
      nameSnapshot: configured.name,
      approverType: configured.approverType,
      approvalRule: configured.approvalRule,
      fallbackUsed,
      status: unique.length ? "waiting" : "skipped",
      approvers: unique.map(approverSnapshot),
      completedAt: unique.length ? null : new Date(),
    });
  }

  const autoApproved = Boolean(version.autoApprove);
  if (!autoApproved && !steps.some((step) => step.status === "waiting")) {
    throw generateError("Approval workflow did not resolve any approvers", 422);
  }
  const firstStep = steps.find((step) => step.status === "waiting") || null;
  if (firstStep) {
    firstStep.status = "pending";
    firstStep.approvers.forEach((approver: any) => {
      approver.status = "pending";
    });
  }
  const instance = await ApprovalInstance.create(
    [
      {
        company: options.company,
        requestType: options.requestType,
        requestModel: options.requestModel,
        request: options.requestId,
        employee: options.employee._id,
        workflow: workflow._id,
        workflowVersion: version._id,
        workflowVersionNumber: version.versionNumber,
        workflowNameSnapshot: workflow.name,
        status: autoApproved ? "approved" : "pending",
        currentStepOrder: firstStep?.order || null,
        steps,
        history: [
          { action: "created", actor: options.actorId, actorNameSnapshot: "Request submitter", at: new Date() },
          ...(autoApproved
            ? [{ action: "auto_approved", actor: null, actorNameSnapshot: "System", at: new Date() }]
            : []),
        ],
        completedAt: autoApproved ? new Date() : null,
      },
    ],
    { session: options.session }
  );
  return approvalResult(instance[0]);
}

function approvalResult(instance: any) {
  const current = instance.steps?.find((step: any) => step.order === instance.currentStepOrder);
  return {
    instance,
    finalApproved: instance.status === "approved",
    rejected: instance.status === "rejected",
    currentStepName: current?.nameSnapshot || null,
    currentApprovers: (current?.approvers || [])
      .filter((approver: any) => approver.status === "pending")
      .map((approver: any) => approver.user),
  };
}

export async function approveApprovalInstance(options: {
  company: mongoose.Types.ObjectId;
  requestModel: RequestModel;
  requestId: mongoose.Types.ObjectId;
  actor: any;
  comment?: string;
  session: ClientSession;
}) {
  const instance = await ApprovalInstance.findOne({
    company: options.company,
    requestModel: options.requestModel,
    request: options.requestId,
    status: "pending",
  }).session(options.session);
  if (!instance) throw generateError("Pending approval workflow was not found", 409);
  approveCurrentApprovalStep(instance, options.actor, options.comment);
  await instance.save({ session: options.session });
  return approvalResult(instance);
}

export async function rejectApprovalInstance(options: {
  company: mongoose.Types.ObjectId;
  requestModel: RequestModel;
  requestId: mongoose.Types.ObjectId;
  actor: any;
  comment: string;
  session: ClientSession;
}) {
  const instance = await ApprovalInstance.findOne({
    company: options.company,
    requestModel: options.requestModel,
    request: options.requestId,
    status: "pending",
  }).session(options.session);
  if (!instance) throw generateError("Pending approval workflow was not found", 409);
  rejectCurrentApprovalStep(instance, options.actor, options.comment);
  await instance.save({ session: options.session });
  return approvalResult(instance);
}

export async function cancelApprovalInstance(options: {
  company: mongoose.Types.ObjectId;
  requestModel: RequestModel;
  requestId: mongoose.Types.ObjectId;
  actor: any;
  comment?: string;
  session: ClientSession;
}) {
  const instance = await ApprovalInstance.findOne({
    company: options.company,
    requestModel: options.requestModel,
    request: options.requestId,
    status: { $in: ["pending", "approved"] },
  }).session(options.session);
  if (!instance) return null;
  instance.status = "cancelled";
  instance.currentStepOrder = null;
  instance.completedAt = new Date();
  instance.history.push({
    action: "cancelled",
    actor: options.actor._id,
    actorNameSnapshot: text(options.actor.name || options.actor.username),
    comment: text(options.comment),
    at: new Date(),
  } as any);
  await instance.save({ session: options.session });
  return instance;
}
