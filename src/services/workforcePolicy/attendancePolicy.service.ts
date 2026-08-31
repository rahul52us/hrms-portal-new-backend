import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import AttendancePolicy from "../../schemas/WorkforcePolicy/AttendancePolicy.schema";
import AttendancePolicyVersion, {
  AttendanceRules,
} from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
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

const DEFAULT_RULES: AttendanceRules = {
  gracePeriodMinutesLate: 0,
  gracePeriodMinutesEarly: 0,
  minimumFullDayMinutes: 480,
  minimumHalfDayMinutes: 240,
  requirePunchOut: true,
  missingPunchTreatment: "flag_incomplete",
  overtimeEnabled: false,
  overtimeStartsAfterMinutes: 0,
};

function normalizeNumber(value: unknown, fallback: number, label: string, minimum = 0) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw generateError(`${label} must be at least ${minimum}`, 400);
  }

  return Math.round(parsed);
}

function normalizeAttendanceRules(input: any = {}, current?: any): AttendanceRules {
  const base: any = {
    ...DEFAULT_RULES,
    ...(current?.toObject ? current.toObject() : current || {}),
  };
  const minimumFullDayMinutes = normalizeNumber(
    input.minimumFullDayMinutes,
    base.minimumFullDayMinutes,
    "Minimum full-day minutes",
    1
  );
  const minimumHalfDayMinutes = normalizeNumber(
    input.minimumHalfDayMinutes,
    base.minimumHalfDayMinutes,
    "Minimum half-day minutes",
    1
  );
  if (minimumHalfDayMinutes >= minimumFullDayMinutes) {
    throw generateError("Half-day minutes must be less than full-day minutes", 400);
  }

  const missingPunchTreatment = normalizeText(
    input.missingPunchTreatment || base.missingPunchTreatment
  ) as AttendanceRules["missingPunchTreatment"];
  if (!["flag_incomplete", "half_day", "absent"].includes(missingPunchTreatment)) {
    throw generateError("Invalid missing punch treatment", 400);
  }

  return {
    gracePeriodMinutesLate: normalizeNumber(
      input.gracePeriodMinutesLate,
      base.gracePeriodMinutesLate,
      "Late grace period"
    ),
    gracePeriodMinutesEarly: normalizeNumber(
      input.gracePeriodMinutesEarly,
      base.gracePeriodMinutesEarly,
      "Early-exit grace period"
    ),
    minimumFullDayMinutes,
    minimumHalfDayMinutes,
    requirePunchOut:
      typeof input.requirePunchOut === "boolean" ? input.requirePunchOut : base.requirePunchOut,
    missingPunchTreatment,
    overtimeEnabled:
      typeof input.overtimeEnabled === "boolean" ? input.overtimeEnabled : base.overtimeEnabled,
    overtimeStartsAfterMinutes: normalizeNumber(
      input.overtimeStartsAfterMinutes,
      base.overtimeStartsAfterMinutes,
      "Overtime threshold"
    ),
  };
}

function serializeVersions(versions: any[]) {
  const publishedVersions = versions.filter((version) => version.status === "published");
  return versions.map((version) => ({
    ...version,
    effectiveTo: getVersionEffectiveTo(version, publishedVersions),
  }));
}

async function findAttendancePolicy(companyId: mongoose.Types.ObjectId, policyIdInput: unknown) {
  const policyId = validateObjectId(policyIdInput, "attendance policy id");
  const policy = await AttendancePolicy.findOne({
    _id: new mongoose.Types.ObjectId(policyId),
    company: companyId,
  });
  if (!policy) {
    throw generateError("Attendance policy not found", 404);
  }

  return policy;
}

export async function listAttendancePoliciesService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const { companyId, companyObjectId } = await resolvePolicyCompany(req, req.query.companyId);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    const status = normalizeText(req.query.status);
    const search = normalizeText(req.query.search);
    const match: any = { company: companyObjectId };
    if (["active", "archived"].includes(status)) {
      match.status = status;
    }
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      match.$or = [{ name: regex }, { code: regex }, { description: regex }];
    }

    const [policies, total] = await Promise.all([
      AttendancePolicy.find(match)
        .sort({ status: 1, name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AttendancePolicy.countDocuments(match),
    ]);
    const policyIds = policies.map((policy) => policy._id);
    const versions = policyIds.length
      ? await AttendancePolicyVersion.find({ company: companyObjectId, policy: { $in: policyIds } })
          .sort({ versionNumber: -1 })
          .lean()
      : [];
    const assignments = policyIds.length
      ? await WorkforcePolicyAssignment.aggregate([
          {
            $match: {
              company: companyObjectId,
              resourceType: "attendance_policy",
              resource: { $in: policyIds },
              $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }],
            },
          },
          { $group: { _id: "$resource", count: { $sum: 1 } } },
        ])
      : [];
    const assignmentCountByPolicy = new Map(
      assignments.map((item: any) => [String(item._id), item.count])
    );
    const versionsByPolicy = versions.reduce<Map<string, any[]>>((map, version: any) => {
      const key = String(version.policy);
      map.set(key, [...(map.get(key) || []), version]);
      return map;
    }, new Map());
    const data = policies.map((policy: any) => {
      const policyVersions = versionsByPolicy.get(String(policy._id)) || [];
      return {
        ...policy,
        draftVersion: policyVersions.find((version) => version.status === "draft") || null,
        latestPublishedVersion:
          policyVersions
            .filter((version) => version.status === "published")
            .sort((left, right) => right.versionNumber - left.versionNumber)[0] || null,
        assignmentCount: assignmentCountByPolicy.get(String(policy._id)) || 0,
      };
    });

    return res.status(200).json({
      success: true,
      data,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      companyId,
    });
  } catch (error) {
    next(error);
  }
}

export async function getAttendancePolicyService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.query.companyId);
    const policy = await findAttendancePolicy(companyObjectId, req.params.policyId);
    const versions = await AttendancePolicyVersion.find({
      company: companyObjectId,
      policy: policy._id,
    })
      .sort({ versionNumber: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: { policy: policy.toObject(), versions: serializeVersions(versions) },
    });
  } catch (error) {
    next(error);
  }
}

export async function createAttendancePolicyService(req: any, res: Response, next: NextFunction) {
  let createdPolicyId: mongoose.Types.ObjectId | null = null;
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.body.company,
      true
    );
    const actorId = getPolicyActorId(req);
    const name = normalizeText(req.body.name);
    const code = normalizeText(req.body.code).toUpperCase();
    if (!name || !code) {
      throw generateError("Policy name and code are required", 422);
    }

    const rules = normalizeAttendanceRules(req.body.rules || {});
    const effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date", false);
    const policy = await AttendancePolicy.create({
      company: companyObjectId,
      name,
      code,
      description: normalizeText(req.body.description),
      latestVersionNumber: 1,
      createdBy: actorId,
    });
    createdPolicyId = policy._id as mongoose.Types.ObjectId;
    const version = await AttendancePolicyVersion.create({
      company: companyObjectId,
      policy: policy._id,
      versionNumber: 1,
      status: "draft",
      effectiveFrom,
      changeReason: normalizeText(req.body.changeReason) || "Initial policy configuration",
      rules,
      createdBy: actorId,
    });
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "attendance_policy",
      entityId: policy._id as mongoose.Types.ObjectId,
      action: "created",
      actor: actorId,
      details: { code, initialVersionId: version._id, effectiveFrom },
    });

    return res.status(201).json({
      success: true,
      message: "Attendance policy draft created",
      data: { policy, version },
    });
  } catch (error: any) {
    if (createdPolicyId) {
      await AttendancePolicy.deleteOne({ _id: createdPolicyId }).catch(() => undefined);
    }
    if (error?.code === 11000) {
      return next(generateError("An attendance policy with this code already exists", 409));
    }
    next(error);
  }
}

export async function updateAttendancePolicyService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const policy = await findAttendancePolicy(companyObjectId, req.params.policyId);
    if (policy.status === "archived") {
      throw generateError("Archived attendance policies cannot be edited", 409);
    }

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
    if (req.body.description !== undefined) {
      policy.description = normalizeText(req.body.description);
    }
    await policy.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "attendance_policy",
      entityId: policy._id as mongoose.Types.ObjectId,
      action: "metadata_updated",
      actor: actorId,
      details: { name: policy.name, code: policy.code },
    });

    return res.status(200).json({ success: true, message: "Attendance policy updated", data: policy });
  } catch (error: any) {
    if (error?.code === 11000) {
      return next(generateError("An attendance policy with this code already exists", 409));
    }
    next(error);
  }
}

export async function createAttendancePolicyVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const policy = await findAttendancePolicy(companyObjectId, req.params.policyId);
    if (policy.status === "archived") {
      throw generateError("Archived attendance policies cannot receive new versions", 409);
    }
    const existingDraft = await AttendancePolicyVersion.findOne({
      company: companyObjectId,
      policy: policy._id,
      status: "draft",
    });
    if (existingDraft) {
      throw generateError("Finish or cancel the existing draft before creating another version", 409);
    }

    const sourceVersion = await AttendancePolicyVersion.findOne({
      company: companyObjectId,
      policy: policy._id,
      status: "published",
    }).sort({ effectiveFrom: -1, versionNumber: -1 });
    const rules = normalizeAttendanceRules(req.body.rules || {}, sourceVersion?.rules || DEFAULT_RULES);
    const effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date", false);
    const updatedPolicy = await AttendancePolicy.findOneAndUpdate(
      { _id: policy._id, company: companyObjectId, status: "active" },
      { $inc: { latestVersionNumber: 1 } },
      { new: true }
    );
    if (!updatedPolicy) {
      throw generateError("Attendance policy is no longer active", 409);
    }
    const version = await AttendancePolicyVersion.create({
      company: companyObjectId,
      policy: policy._id,
      versionNumber: updatedPolicy.latestVersionNumber,
      status: "draft",
      effectiveFrom,
      changeReason: normalizeText(req.body.changeReason),
      rules,
      createdBy: actorId,
    });
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "attendance_version",
      entityId: version._id as mongoose.Types.ObjectId,
      action: "draft_created",
      actor: actorId,
      details: { policyId: policy._id, versionNumber: version.versionNumber, effectiveFrom },
    });

    return res.status(201).json({
      success: true,
      message: "Attendance policy version draft created",
      data: version,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateAttendancePolicyVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const policy = await findAttendancePolicy(companyObjectId, req.params.policyId);
    const versionId = validateObjectId(req.params.versionId, "attendance policy version id");
    const version = await AttendancePolicyVersion.findOne({
      _id: new mongoose.Types.ObjectId(versionId),
      company: companyObjectId,
      policy: policy._id,
    });
    if (!version) throw generateError("Attendance policy version not found", 404);
    if (version.status !== "draft") {
      throw generateError("Published attendance policy versions are immutable", 409);
    }

    version.rules = normalizeAttendanceRules(req.body.rules || {}, version.rules) as any;
    if (req.body.effectiveFrom !== undefined) {
      version.effectiveFrom = parseEffectiveDate(
        req.body.effectiveFrom,
        "effective from date",
        false
      );
    }
    if (req.body.changeReason !== undefined) {
      version.changeReason = normalizeText(req.body.changeReason);
    }
    await version.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "attendance_version",
      entityId: version._id as mongoose.Types.ObjectId,
      action: "draft_updated",
      actor: actorId,
      details: { policyId: policy._id, versionNumber: version.versionNumber },
    });

    return res.status(200).json({ success: true, message: "Attendance policy draft updated", data: version });
  } catch (error) {
    next(error);
  }
}

export async function publishAttendancePolicyVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const policy = await findAttendancePolicy(companyObjectId, req.params.policyId);
    if (policy.status !== "active") throw generateError("Archived policies cannot be published", 409);
    const versionId = validateObjectId(req.params.versionId, "attendance policy version id");
    const version = await AttendancePolicyVersion.findOne({
      _id: new mongoose.Types.ObjectId(versionId),
      company: companyObjectId,
      policy: policy._id,
    });
    if (!version) throw generateError("Attendance policy version not found", 404);
    if (version.status !== "draft") {
      throw generateError("Only draft attendance policy versions can be published", 409);
    }

    const effectiveFrom = parseEffectiveDate(
      req.body.effectiveFrom || version.effectiveFrom,
      "effective from date"
    ) as Date;
    const changeReason = normalizeText(req.body.changeReason || version.changeReason);
    if (version.versionNumber > 1 && changeReason.length < 3) {
      throw generateError("A change reason is required when publishing a new version", 422);
    }
    const duplicateEffectiveDate = await AttendancePolicyVersion.findOne({
      company: companyObjectId,
      policy: policy._id,
      status: "published",
      effectiveFrom,
      _id: { $ne: version._id },
    }).lean();
    if (duplicateEffectiveDate) {
      throw generateError("Another published version already starts on this date", 409);
    }

    version.rules = normalizeAttendanceRules({}, version.rules) as any;
    version.effectiveFrom = effectiveFrom;
    version.changeReason = changeReason || "Initial policy publication";
    version.status = "published";
    version.publishedAt = new Date();
    version.publishedBy = actorId;
    await version.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "attendance_version",
      entityId: version._id as mongoose.Types.ObjectId,
      action: "published",
      actor: actorId,
      details: {
        policyId: policy._id,
        versionNumber: version.versionNumber,
        effectiveFrom,
        changeReason: version.changeReason,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Attendance policy version published",
      data: version,
      meta: { historicalRecalculationRequired: effectiveFrom.getTime() < Date.now() },
    });
  } catch (error) {
    next(error);
  }
}

export async function archiveAttendancePolicyService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const policy = await findAttendancePolicy(companyObjectId, req.params.policyId);
    if (policy.status === "archived") {
      return res.status(200).json({ success: true, message: "Attendance policy is already archived", data: policy });
    }
    const reason = normalizeText(req.body.reason || req.body.archiveReason);
    if (reason.length < 3) throw generateError("Archive reason must be at least 3 characters", 422);
    const activeAssignments = await WorkforcePolicyAssignment.countDocuments({
      company: companyObjectId,
      resourceType: "attendance_policy",
      resource: policy._id,
      $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }],
    });
    if (activeAssignments > 0) {
      throw generateError(
        `End ${activeAssignments} active or scheduled assignment${activeAssignments === 1 ? "" : "s"} before archiving this policy`,
        409
      );
    }

    policy.status = "archived";
    policy.archivedAt = new Date();
    policy.archivedBy = actorId;
    policy.archiveReason = reason;
    await policy.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "attendance_policy",
      entityId: policy._id as mongoose.Types.ObjectId,
      action: "archived",
      actor: actorId,
      details: { reason },
    });

    return res.status(200).json({ success: true, message: "Attendance policy archived", data: policy });
  } catch (error) {
    next(error);
  }
}
