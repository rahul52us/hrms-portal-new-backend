import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import RemoteWorkPolicy from "../../schemas/WorkforcePolicy/RemoteWorkPolicy.schema";
import RemoteWorkPolicyVersion, {
  REMOTE_WORK_APPROVAL_MODES,
  REMOTE_WORK_WEEKDAYS,
  RemoteWorkRules,
} from "../../schemas/WorkforcePolicy/RemoteWorkPolicyVersion.schema";
import WorkforcePolicyAssignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import {
  ensurePolicyManager,
  ensurePolicyViewer,
  escapeRegex,
  getPolicyActorId,
  getVersionEffectiveTo,
  normalizeText,
  parseEffectiveDate,
  resolvePolicyCompany,
  validateObjectId,
  writePolicyAudit,
} from "./workforcePolicy.utils";

const DEFAULT_RULES: RemoteWorkRules = {
  approvalMode: "reporting_manager",
  allowedWeekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  maxDaysPerWeek: 0,
  maxDaysPerMonth: 0,
  maxConsecutiveDays: 0,
  minimumNoticeDays: 0,
  maximumAdvanceDays: 90,
  allowHalfDay: true,
  requireReason: true,
  minimumReasonLength: 10,
  probationEligibility: "allowed",
};

function integer(value: unknown, fallback: number, label: string, minimum: number, maximum: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw generateError(`${label} must be a whole number between ${minimum} and ${maximum}`, 400);
  }
  return parsed;
}

function normalizeRules(input: any = {}, current?: any): RemoteWorkRules {
  const base: any = {
    ...DEFAULT_RULES,
    ...(current?.toObject ? current.toObject() : current || {}),
  };
  const approvalMode = normalizeText(input.approvalMode || base.approvalMode) as RemoteWorkRules["approvalMode"];
  if (!REMOTE_WORK_APPROVAL_MODES.includes(approvalMode as any)) {
    throw generateError("Invalid remote-work approval mode", 400);
  }
  const probationEligibility = normalizeText(
    input.probationEligibility || base.probationEligibility
  ) as RemoteWorkRules["probationEligibility"];
  if (!["allowed", "after_confirmation", "not_allowed"].includes(probationEligibility)) {
    throw generateError("Invalid probation eligibility", 400);
  }
  const allowedInput = input.allowedWeekdays === undefined ? base.allowedWeekdays : input.allowedWeekdays;
  if (!Array.isArray(allowedInput)) throw generateError("Allowed weekdays must be a list", 400);
  const allowedWeekdays = Array.from(new Set(allowedInput.map((day: unknown) => normalizeText(day))));
  if (!allowedWeekdays.length || allowedWeekdays.some((day) => !REMOTE_WORK_WEEKDAYS.includes(day as any))) {
    throw generateError("Select at least one valid remote-work weekday", 400);
  }
  const requireReason = typeof input.requireReason === "boolean" ? input.requireReason : base.requireReason;
  const minimumReasonLength = integer(
    input.minimumReasonLength,
    base.minimumReasonLength,
    "Minimum reason length",
    0,
    500
  );
  if (!requireReason && minimumReasonLength > 0) {
    throw generateError("Minimum reason length must be 0 when a reason is not required", 400);
  }
  return {
    approvalMode,
    allowedWeekdays,
    maxDaysPerWeek: integer(input.maxDaysPerWeek, base.maxDaysPerWeek, "Weekly WFH limit", 0, 7),
    maxDaysPerMonth: integer(input.maxDaysPerMonth, base.maxDaysPerMonth, "Monthly WFH limit", 0, 31),
    maxConsecutiveDays: integer(input.maxConsecutiveDays, base.maxConsecutiveDays, "Consecutive WFH limit", 0, 31),
    minimumNoticeDays: integer(input.minimumNoticeDays, base.minimumNoticeDays, "Minimum notice", 0, 365),
    maximumAdvanceDays: integer(input.maximumAdvanceDays, base.maximumAdvanceDays, "Maximum advance window", 0, 730),
    allowHalfDay: typeof input.allowHalfDay === "boolean" ? input.allowHalfDay : base.allowHalfDay,
    requireReason,
    minimumReasonLength,
    probationEligibility,
  };
}

function serializeVersions(versions: any[]) {
  const published = versions.filter((version) => version.status === "published");
  return versions.map((version) => ({
    ...version,
    effectiveTo: getVersionEffectiveTo(version, published),
  }));
}

async function findPolicy(company: mongoose.Types.ObjectId, policyIdInput: unknown) {
  const policyId = validateObjectId(policyIdInput, "remote-work policy id");
  const policy = await RemoteWorkPolicy.findOne({
    _id: new mongoose.Types.ObjectId(policyId),
    company,
  });
  if (!policy) throw generateError("Remote-work policy not found", 404);
  return policy;
}

export async function listRemoteWorkPoliciesService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const { companyId, companyObjectId } = await resolvePolicyCompany(req, req.query.companyId);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    const status = normalizeText(req.query.status);
    const search = normalizeText(req.query.search);
    const match: any = { company: companyObjectId };
    if (["active", "archived"].includes(status)) match.status = status;
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      match.$or = [{ name: regex }, { code: regex }, { description: regex }];
    }
    const [policies, total] = await Promise.all([
      RemoteWorkPolicy.find(match).sort({ status: 1, name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      RemoteWorkPolicy.countDocuments(match),
    ]);
    const policyIds = policies.map((policy) => policy._id);
    const [versions, assignments] = await Promise.all([
      policyIds.length
        ? RemoteWorkPolicyVersion.find({ company: companyObjectId, policy: { $in: policyIds } }).sort({ versionNumber: -1 }).lean()
        : [],
      policyIds.length
        ? WorkforcePolicyAssignment.aggregate([
            { $match: { company: companyObjectId, resourceType: "remote_work_policy", resource: { $in: policyIds }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }] } },
            { $group: { _id: "$resource", count: { $sum: 1 } } },
          ])
        : [],
    ]);
    const versionsByPolicy = versions.reduce<Map<string, any[]>>((map, version: any) => {
      const key = String(version.policy);
      map.set(key, [...(map.get(key) || []), version]);
      return map;
    }, new Map());
    const counts = new Map(assignments.map((item: any) => [String(item._id), item.count]));
    const data = policies.map((policy: any) => {
      const policyVersions = versionsByPolicy.get(String(policy._id)) || [];
      return {
        ...policy,
        draftVersion: policyVersions.find((version) => version.status === "draft") || null,
        latestPublishedVersion: policyVersions.filter((version) => version.status === "published").sort((a, b) => b.versionNumber - a.versionNumber)[0] || null,
        assignmentCount: counts.get(String(policy._id)) || 0,
      };
    });
    return res.status(200).json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }, companyId });
  } catch (error) {
    next(error);
  }
}

export async function getRemoteWorkPolicyService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.query.companyId);
    const policy = await findPolicy(companyObjectId, req.params.policyId);
    const versions = await RemoteWorkPolicyVersion.find({ company: companyObjectId, policy: policy._id }).sort({ versionNumber: -1 }).lean();
    return res.status(200).json({ success: true, data: { policy: policy.toObject(), versions: serializeVersions(versions) } });
  } catch (error) {
    next(error);
  }
}

export async function createRemoteWorkPolicyService(req: any, res: Response, next: NextFunction) {
  let createdPolicyId: mongoose.Types.ObjectId | null = null;
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.body.companyId || req.body.company, true);
    const actorId = getPolicyActorId(req);
    const name = normalizeText(req.body.name);
    const code = normalizeText(req.body.code).toUpperCase();
    if (!name || !code) throw generateError("Policy name and code are required", 422);
    const rules = normalizeRules(req.body.rules || {});
    const effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date", false);
    const policy = await RemoteWorkPolicy.create({ company: companyObjectId, name, code, description: normalizeText(req.body.description), latestVersionNumber: 1, createdBy: actorId });
    createdPolicyId = policy._id as mongoose.Types.ObjectId;
    const version = await RemoteWorkPolicyVersion.create({ company: companyObjectId, policy: policy._id, versionNumber: 1, status: "draft", effectiveFrom, changeReason: normalizeText(req.body.changeReason) || "Initial remote-work configuration", rules, createdBy: actorId });
    await writePolicyAudit({ company: companyObjectId, entityType: "remote_work_policy", entityId: policy._id as mongoose.Types.ObjectId, action: "created", actor: actorId, details: { code, initialVersionId: version._id, effectiveFrom } });
    return res.status(201).json({ success: true, message: "Remote-work policy draft created", data: { policy, version } });
  } catch (error: any) {
    if (createdPolicyId) await RemoteWorkPolicy.deleteOne({ _id: createdPolicyId }).catch(() => undefined);
    if (error?.code === 11000) return next(generateError("A remote-work policy with this code already exists", 409));
    next(error);
  }
}

export async function updateRemoteWorkPolicyService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.body.companyId || req.query.companyId, true);
    const actorId = getPolicyActorId(req);
    const policy = await findPolicy(companyObjectId, req.params.policyId);
    if (policy.status === "archived") throw generateError("Archived remote-work policies cannot be edited", 409);
    if (req.body.name !== undefined) {
      const name = normalizeText(req.body.name);
      if (!name) throw generateError("Policy name is required", 422);
      policy.name = name;
    }
    if (req.body.code !== undefined) {
      const code = normalizeText(req.body.code).toUpperCase();
      if (!code) throw generateError("Policy code is required", 422);
      policy.code = code;
    }
    if (req.body.description !== undefined) policy.description = normalizeText(req.body.description);
    await policy.save();
    await writePolicyAudit({ company: companyObjectId, entityType: "remote_work_policy", entityId: policy._id as mongoose.Types.ObjectId, action: "metadata_updated", actor: actorId, details: { name: policy.name, code: policy.code } });
    return res.status(200).json({ success: true, message: "Remote-work policy updated", data: policy });
  } catch (error: any) {
    if (error?.code === 11000) return next(generateError("A remote-work policy with this code already exists", 409));
    next(error);
  }
}

export async function createRemoteWorkPolicyVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.body.companyId || req.query.companyId, true);
    const actorId = getPolicyActorId(req);
    const policy = await findPolicy(companyObjectId, req.params.policyId);
    if (policy.status === "archived") throw generateError("Archived remote-work policies cannot receive versions", 409);
    if (await RemoteWorkPolicyVersion.exists({ company: companyObjectId, policy: policy._id, status: "draft" })) {
      throw generateError("Finish the existing draft before creating another version", 409);
    }
    const source = await RemoteWorkPolicyVersion.findOne({ company: companyObjectId, policy: policy._id, status: "published" }).sort({ effectiveFrom: -1, versionNumber: -1 });
    const rules = normalizeRules(req.body.rules || {}, source?.rules || DEFAULT_RULES);
    const effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date", false);
    const updated = await RemoteWorkPolicy.findOneAndUpdate({ _id: policy._id, company: companyObjectId, status: "active" }, { $inc: { latestVersionNumber: 1 } }, { new: true });
    if (!updated) throw generateError("Remote-work policy is no longer active", 409);
    const version = await RemoteWorkPolicyVersion.create({ company: companyObjectId, policy: policy._id, versionNumber: updated.latestVersionNumber, status: "draft", effectiveFrom, changeReason: normalizeText(req.body.changeReason), rules, createdBy: actorId });
    await writePolicyAudit({ company: companyObjectId, entityType: "remote_work_version", entityId: version._id as mongoose.Types.ObjectId, action: "draft_created", actor: actorId, details: { policyId: policy._id, versionNumber: version.versionNumber, effectiveFrom } });
    return res.status(201).json({ success: true, message: "Remote-work policy version draft created", data: version });
  } catch (error) {
    next(error);
  }
}

export async function updateRemoteWorkPolicyVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.body.companyId || req.query.companyId, true);
    const actorId = getPolicyActorId(req);
    const policy = await findPolicy(companyObjectId, req.params.policyId);
    const versionId = validateObjectId(req.params.versionId, "remote-work policy version id");
    const version = await RemoteWorkPolicyVersion.findOne({ _id: new mongoose.Types.ObjectId(versionId), company: companyObjectId, policy: policy._id });
    if (!version) throw generateError("Remote-work policy version not found", 404);
    if (version.status !== "draft") throw generateError("Published remote-work policy versions are immutable", 409);
    version.rules = normalizeRules(req.body.rules || {}, version.rules) as any;
    if (req.body.effectiveFrom !== undefined) version.effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date", false);
    if (req.body.changeReason !== undefined) version.changeReason = normalizeText(req.body.changeReason);
    await version.save();
    await writePolicyAudit({ company: companyObjectId, entityType: "remote_work_version", entityId: version._id as mongoose.Types.ObjectId, action: "draft_updated", actor: actorId, details: { policyId: policy._id, versionNumber: version.versionNumber } });
    return res.status(200).json({ success: true, message: "Remote-work policy draft updated", data: version });
  } catch (error) {
    next(error);
  }
}

export async function publishRemoteWorkPolicyVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.body.companyId || req.query.companyId, true);
    const actorId = getPolicyActorId(req);
    const policy = await findPolicy(companyObjectId, req.params.policyId);
    if (policy.status !== "active") throw generateError("Archived remote-work policies cannot be published", 409);
    const versionId = validateObjectId(req.params.versionId, "remote-work policy version id");
    const version = await RemoteWorkPolicyVersion.findOne({ _id: new mongoose.Types.ObjectId(versionId), company: companyObjectId, policy: policy._id });
    if (!version) throw generateError("Remote-work policy version not found", 404);
    if (version.status !== "draft") throw generateError("Only draft remote-work policy versions can be published", 409);
    const effectiveFrom = parseEffectiveDate(req.body.effectiveFrom || version.effectiveFrom, "effective from date") as Date;
    const changeReason = normalizeText(req.body.changeReason || version.changeReason);
    if (version.versionNumber > 1 && changeReason.length < 3) throw generateError("A change reason is required for a new version", 422);
    if (await RemoteWorkPolicyVersion.exists({ company: companyObjectId, policy: policy._id, status: "published", effectiveFrom, _id: { $ne: version._id } })) {
      throw generateError("Another published version already starts on this date", 409);
    }
    version.rules = normalizeRules({}, version.rules) as any;
    version.effectiveFrom = effectiveFrom;
    version.changeReason = changeReason || "Initial remote-work policy publication";
    version.status = "published";
    version.publishedAt = new Date();
    version.publishedBy = actorId;
    await version.save();
    await writePolicyAudit({ company: companyObjectId, entityType: "remote_work_version", entityId: version._id as mongoose.Types.ObjectId, action: "published", actor: actorId, details: { policyId: policy._id, versionNumber: version.versionNumber, effectiveFrom, changeReason: version.changeReason } });
    return res.status(200).json({ success: true, message: "Remote-work policy version published", data: version, meta: { historicalRecalculationRequired: effectiveFrom.getTime() < Date.now() } });
  } catch (error) {
    next(error);
  }
}

export async function archiveRemoteWorkPolicyService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.body.companyId || req.query.companyId, true);
    const actorId = getPolicyActorId(req);
    const policy = await findPolicy(companyObjectId, req.params.policyId);
    if (policy.status === "archived") return res.status(200).json({ success: true, message: "Remote-work policy is already archived", data: policy });
    const reason = normalizeText(req.body.reason || req.body.archiveReason);
    if (reason.length < 3) throw generateError("Archive reason must be at least 3 characters", 422);
    const activeAssignments = await WorkforcePolicyAssignment.countDocuments({ company: companyObjectId, resourceType: "remote_work_policy", resource: policy._id, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }] });
    if (activeAssignments) throw generateError(`End ${activeAssignments} active or scheduled assignment${activeAssignments === 1 ? "" : "s"} before archiving this policy`, 409);
    policy.status = "archived";
    policy.archivedAt = new Date();
    policy.archivedBy = actorId;
    policy.archiveReason = reason;
    await policy.save();
    await writePolicyAudit({ company: companyObjectId, entityType: "remote_work_policy", entityId: policy._id as mongoose.Types.ObjectId, action: "archived", actor: actorId, details: { reason } });
    return res.status(200).json({ success: true, message: "Remote-work policy archived", data: policy });
  } catch (error) {
    next(error);
  }
}

