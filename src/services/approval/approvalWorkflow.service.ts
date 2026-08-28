import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import ApprovalWorkflow, {
  APPROVAL_REQUEST_TYPES,
} from "../../schemas/Approval/ApprovalWorkflow.schema";
import ApprovalWorkflowVersion, {
  APPROVAL_STEP_TYPES,
  ApprovalWorkflowStepI,
} from "../../schemas/Approval/ApprovalWorkflowVersion.schema";
import User from "../../schemas/User/User";
import {
  ensurePolicyManager,
  ensurePolicyViewer,
  escapeRegex,
  getPolicyActorId,
  normalizeText,
  resolvePolicyCompany,
  validateObjectId,
  writePolicyAudit,
} from "../workforcePolicy/workforcePolicy.utils";

function normalizeCode(value: unknown) {
  return normalizeText(value).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

function normalizeApplicableTo(value: unknown, fallback: string[] = []) {
  const source = value === undefined ? fallback : value;
  if (!Array.isArray(source)) throw generateError("Applicable request types must be an array", 400);
  const applicableTo = Array.from(
    new Set(source.map((item) => normalizeText(item).toLowerCase()).filter(Boolean))
  );
  if (!applicableTo.length || applicableTo.some((item) => !APPROVAL_REQUEST_TYPES.includes(item as any))) {
    throw generateError("Select at least one valid approval request type", 422);
  }
  return applicableTo as (typeof APPROVAL_REQUEST_TYPES)[number][];
}

function objectIdOrNull(value: unknown) {
  const normalized = normalizeText((value as any)?._id || value);
  return mongoose.Types.ObjectId.isValid(normalized)
    ? new mongoose.Types.ObjectId(normalized)
    : null;
}

async function normalizeSteps(options: {
  company: mongoose.Types.ObjectId;
  input: unknown;
  current?: ApprovalWorkflowStepI[];
  publishing?: boolean;
}) {
  const source = options.input === undefined ? options.current || [] : options.input;
  if (!Array.isArray(source)) throw generateError("Approval steps must be an array", 400);
  if (source.length > 10) throw generateError("An approval workflow cannot exceed 10 levels", 422);

  const normalized = source.map((step: any, index: number) => {
    const approverType = normalizeText(step?.approverType).toLowerCase();
    if (!APPROVAL_STEP_TYPES.includes(approverType as any)) {
      throw generateError(`Approval step ${index + 1} has an invalid approver type`, 400);
    }
    const approvalRule = normalizeText(step?.approvalRule || "any").toLowerCase();
    if (!["any", "all"].includes(approvalRule)) {
      throw generateError(`Approval step ${index + 1} has an invalid approval rule`, 400);
    }
    const userIds = Array.from(
      new Set<string>(
        (Array.isArray(step?.approverUserIds) ? step.approverUserIds : [])
          .map((item: any) => normalizeText(item?._id || item))
          .filter(Boolean)
      )
    );
    if (userIds.some((item) => !mongoose.Types.ObjectId.isValid(item))) {
      throw generateError(`Approval step ${index + 1} contains an invalid user`, 400);
    }
    if (options.publishing && approverType === "specific_users" && !userIds.length) {
      throw generateError(`Approval step ${index + 1} must select at least one employee`, 422);
    }
    return {
      order: index + 1,
      name: normalizeText(step?.name) || `Level ${index + 1}`,
      approverType,
      approvalRule,
      approverUserIds: userIds.map((item) => new mongoose.Types.ObjectId(item)),
      fallbackToHr: Boolean(step?.fallbackToHr),
    };
  });

  const specificIds = normalized.flatMap((step) => step.approverUserIds);
  if (specificIds.length) {
    const count = await User.countDocuments({
      _id: { $in: specificIds },
      company: options.company,
      deletedAt: { $exists: false },
      is_enabled: { $ne: false },
    });
    if (count !== new Set(specificIds.map(String)).size) {
      throw generateError("One or more selected approvers are unavailable in this company", 422);
    }
  }
  return normalized;
}

async function findWorkflow(company: mongoose.Types.ObjectId, workflowIdInput: unknown) {
  const workflowId = validateObjectId(workflowIdInput, "approval workflow id");
  const workflow = await ApprovalWorkflow.findOne({
    _id: new mongoose.Types.ObjectId(workflowId),
    company,
  });
  if (!workflow) throw generateError("Approval workflow not found", 404);
  return workflow;
}

export async function validatePublishedApprovalWorkflowReference(options: {
  company: mongoose.Types.ObjectId;
  workflowId: unknown;
  versionId: unknown;
  requestType: (typeof APPROVAL_REQUEST_TYPES)[number];
}) {
  const workflowId = objectIdOrNull(options.workflowId);
  const versionId = objectIdOrNull(options.versionId);
  if (!workflowId || !versionId) throw generateError("Select a published approval workflow", 422);
  const [workflow, version] = await Promise.all([
    ApprovalWorkflow.findOne({
      _id: workflowId,
      company: options.company,
      status: "active",
      applicableTo: options.requestType,
    }).lean(),
    ApprovalWorkflowVersion.findOne({
      _id: versionId,
      company: options.company,
      workflow: workflowId,
      status: "published",
    }).lean(),
  ]);
  if (!workflow || !version) {
    throw generateError(`The selected approval workflow is not published for ${options.requestType}`, 422);
  }
  return {
    workflow: workflowId,
    version: versionId,
    versionNumber: version.versionNumber,
  };
}

async function listWithVersions(company: mongoose.Types.ObjectId, match: any, page: number, limit: number) {
  const [workflows, total] = await Promise.all([
    ApprovalWorkflow.find(match).sort({ status: 1, name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    ApprovalWorkflow.countDocuments(match),
  ]);
  const versions = workflows.length
    ? await ApprovalWorkflowVersion.find({ company, workflow: { $in: workflows.map((item) => item._id) } })
        .sort({ versionNumber: -1 })
        .lean()
    : [];
  const grouped = versions.reduce<Map<string, any[]>>((map, version: any) => {
    const key = String(version.workflow);
    map.set(key, [...(map.get(key) || []), version]);
    return map;
  }, new Map());
  return {
    data: workflows.map((workflow: any) => {
      const items = grouped.get(String(workflow._id)) || [];
      return {
        ...workflow,
        draftVersion: items.find((item) => item.status === "draft") || null,
        latestPublishedVersion: items.find((item) => item.status === "published") || null,
      };
    }),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function listApprovalWorkflowsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.query?.companyId);
    const page = Math.max(1, Number(req.query?.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query?.limit || 20)));
    const match: any = { company: companyObjectId };
    const status = normalizeText(req.query?.status).toLowerCase();
    const requestType = normalizeText(req.query?.requestType).toLowerCase();
    const search = normalizeText(req.query?.search);
    if (["active", "archived"].includes(status)) match.status = status;
    if (requestType) {
      if (!APPROVAL_REQUEST_TYPES.includes(requestType as any)) throw generateError("Invalid request type", 400);
      match.applicableTo = requestType;
    }
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      match.$or = [{ name: regex }, { code: regex }, { description: regex }];
    }
    const result = await listWithVersions(companyObjectId, match, page, limit);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
}

export async function getApprovalWorkflowService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.query?.companyId);
    const workflow = await findWorkflow(companyObjectId, req.params.workflowId);
    const versions = await ApprovalWorkflowVersion.find({ company: companyObjectId, workflow: workflow._id })
      .sort({ versionNumber: -1 })
      .populate("steps.approverUserIds", "name username code role")
      .lean();
    return res.status(200).json({ success: true, data: { workflow, versions } });
  } catch (error) {
    next(error);
  }
}

export async function createApprovalWorkflowService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.body?.companyId, true);
    const actorId = getPolicyActorId(req);
    const name = normalizeText(req.body?.name);
    const code = normalizeCode(req.body?.code);
    if (name.length < 3) throw generateError("Approval workflow name must be at least 3 characters", 422);
    if (code.length < 2) throw generateError("Approval workflow code must be at least 2 characters", 422);
    const applicableTo = normalizeApplicableTo(req.body?.applicableTo);
    const autoApprove = Boolean(req.body?.autoApprove);
    const steps = await normalizeSteps({ company: companyObjectId, input: req.body?.steps });
    if (autoApprove && steps.length) throw generateError("Automatic workflows cannot contain approval steps", 422);

    const workflow = new ApprovalWorkflow({
      company: companyObjectId,
      name,
      code,
      description: normalizeText(req.body?.description),
      applicableTo,
      status: "active",
      latestVersionNumber: 1,
      createdBy: actorId,
    });
    const version = new ApprovalWorkflowVersion({
      company: companyObjectId,
      workflow: workflow._id,
      versionNumber: 1,
      status: "draft",
      autoApprove,
      steps,
      changeReason: normalizeText(req.body?.changeReason),
      createdBy: actorId,
    });
    await mongoose.connection.transaction(async (session) => {
      await workflow.save({ session });
      await version.save({ session });
      await writePolicyAudit({
        company: companyObjectId,
        entityType: "approval_workflow",
        entityId: workflow._id as mongoose.Types.ObjectId,
        action: "created",
        actor: actorId,
        details: { code, applicableTo, versionNumber: 1 },
      }, session);
    });
    return res.status(201).json({ success: true, data: { workflow, version }, message: "Approval workflow draft created" });
  } catch (error: any) {
    if (error?.code === 11000) return next(generateError("Approval workflow code already exists", 409));
    next(error);
  }
}

export async function createApprovalWorkflowVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.body?.companyId, true);
    const actorId = getPolicyActorId(req);
    const workflow = await findWorkflow(companyObjectId, req.params.workflowId);
    if (workflow.status !== "active") throw generateError("Archived approval workflows cannot be versioned", 409);
    const draft = await ApprovalWorkflowVersion.exists({ company: companyObjectId, workflow: workflow._id, status: "draft" });
    if (draft) throw generateError("This approval workflow already has a draft version", 409);
    const latest = await ApprovalWorkflowVersion.findOne({ company: companyObjectId, workflow: workflow._id })
      .sort({ versionNumber: -1 })
      .lean();
    const autoApprove = req.body?.autoApprove === undefined ? Boolean(latest?.autoApprove) : Boolean(req.body.autoApprove);
    const steps = await normalizeSteps({
      company: companyObjectId,
      input: req.body?.steps,
      current: (latest?.steps || []) as any,
    });
    if (autoApprove && steps.length) throw generateError("Automatic workflows cannot contain approval steps", 422);
    const versionNumber = Number(workflow.latestVersionNumber || 0) + 1;
    const version = await ApprovalWorkflowVersion.create({
      company: companyObjectId,
      workflow: workflow._id,
      versionNumber,
      status: "draft",
      autoApprove,
      steps,
      changeReason: normalizeText(req.body?.changeReason),
      createdBy: actorId,
    });
    workflow.latestVersionNumber = versionNumber;
    await workflow.save();
    return res.status(201).json({ success: true, data: version, message: "Approval workflow version created" });
  } catch (error) {
    next(error);
  }
}

export async function updateApprovalWorkflowVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.body?.companyId, true);
    const workflow = await findWorkflow(companyObjectId, req.params.workflowId);
    const versionId = validateObjectId(req.params.versionId, "approval workflow version id");
    const version = await ApprovalWorkflowVersion.findOne({
      _id: new mongoose.Types.ObjectId(versionId),
      company: companyObjectId,
      workflow: workflow._id,
      status: "draft",
    });
    if (!version) throw generateError("Approval workflow draft not found", 404);
    const autoApprove = req.body?.autoApprove === undefined ? version.autoApprove : Boolean(req.body.autoApprove);
    const steps = await normalizeSteps({ company: companyObjectId, input: req.body?.steps, current: version.steps });
    if (autoApprove && steps.length) throw generateError("Automatic workflows cannot contain approval steps", 422);
    version.autoApprove = autoApprove;
    version.steps = steps as any;
    if (req.body?.changeReason !== undefined) version.changeReason = normalizeText(req.body.changeReason);
    await version.save();
    return res.status(200).json({ success: true, data: version, message: "Approval workflow draft updated" });
  } catch (error) {
    next(error);
  }
}

export async function publishApprovalWorkflowVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.body?.companyId, true);
    const actorId = getPolicyActorId(req);
    const workflow = await findWorkflow(companyObjectId, req.params.workflowId);
    const versionId = validateObjectId(req.params.versionId, "approval workflow version id");
    const version = await ApprovalWorkflowVersion.findOne({
      _id: new mongoose.Types.ObjectId(versionId),
      company: companyObjectId,
      workflow: workflow._id,
      status: "draft",
    });
    if (!version) throw generateError("Approval workflow draft not found", 404);
    const steps = await normalizeSteps({
      company: companyObjectId,
      input: version.steps,
      publishing: true,
    });
    if (version.autoApprove && steps.length) throw generateError("Automatic workflows cannot contain approval steps", 422);
    if (!version.autoApprove && !steps.length) throw generateError("Add at least one approval step before publishing", 422);
    version.steps = steps as any;
    version.status = "published";
    version.publishedAt = new Date();
    version.publishedBy = actorId;
    if (req.body?.changeReason !== undefined) version.changeReason = normalizeText(req.body.changeReason);
    await mongoose.connection.transaction(async (session) => {
      await version.save({ session });
      await writePolicyAudit({
        company: companyObjectId,
        entityType: "approval_workflow_version",
        entityId: version._id as mongoose.Types.ObjectId,
        action: "published",
        actor: actorId,
        details: { workflow: workflow._id, versionNumber: version.versionNumber, autoApprove: version.autoApprove },
      }, session);
    });
    return res.status(200).json({ success: true, data: version, message: "Approval workflow published" });
  } catch (error) {
    next(error);
  }
}

export async function archiveApprovalWorkflowService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.body?.companyId, true);
    const actorId = getPolicyActorId(req);
    const workflow = await findWorkflow(companyObjectId, req.params.workflowId);
    const reason = normalizeText(req.body?.reason);
    if (reason.length < 3) throw generateError("Archive reason must be at least 3 characters", 422);
    workflow.status = "archived";
    workflow.archivedAt = new Date();
    workflow.archivedBy = actorId;
    workflow.archiveReason = reason;
    await workflow.save();
    return res.status(200).json({ success: true, data: workflow, message: "Approval workflow archived" });
  } catch (error) {
    next(error);
  }
}
