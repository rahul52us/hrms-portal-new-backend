import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import WorkSchedule from "../../schemas/WorkforcePolicy/WorkSchedule.schema";
import WorkScheduleVersion, {
  WorkScheduleRules,
  WORK_SCHEDULE_DAYS,
  WORK_SCHEDULE_SATURDAY_RULES,
} from "../../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
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

const DEFAULT_RULES: WorkScheduleRules = {
  timezone: "Asia/Kolkata",
  workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  saturdayRule: "all_off",
  customSaturdayOffWeeks: [],
  startTime: "09:30",
  endTime: "18:30",
  unpaidBreakMinutes: 60,
};

function normalizeNumber(value: unknown, fallback: number, label: string, minimum = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw generateError(`${label} must be at least ${minimum}`, 400);
  }
  return Math.round(parsed);
}

function validateTime(value: unknown, label: string, fallback: string) {
  const normalized = normalizeText(value || fallback);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
    throw generateError(`${label} must use HH:mm 24-hour format`, 400);
  }
  return normalized;
}

function validateTimezone(value: unknown, fallback: string) {
  const timezone = normalizeText(value || fallback);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw generateError("Invalid IANA timezone", 400);
  }
  return timezone;
}

function timeToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function normalizeWorkScheduleRules(input: any = {}, current?: any): WorkScheduleRules {
  const base: any = {
    ...DEFAULT_RULES,
    ...(current?.toObject ? current.toObject() : current || {}),
  };
  const requestedWorkingDays = Array.isArray(input.workingDays)
    ? Array.from(new Set<string>(input.workingDays.map((day: unknown) => normalizeText(day))))
    : base.workingDays;
  const invalidDay = requestedWorkingDays.find(
    (day: string) => !WORK_SCHEDULE_DAYS.includes(day as any) || day === "Saturday"
  );
  if (invalidDay) {
    throw generateError(
      invalidDay === "Saturday"
        ? "Configure Saturdays with saturdayRule instead of workingDays"
        : "Select only valid working days",
      400
    );
  }

  const saturdayRule = normalizeText(input.saturdayRule || base.saturdayRule);
  if (!WORK_SCHEDULE_SATURDAY_RULES.includes(saturdayRule as any)) {
    throw generateError("Invalid Saturday rule", 400);
  }
  if (!requestedWorkingDays.length && saturdayRule === "all_off") {
    throw generateError("Select at least one working day", 400);
  }

  const customSaturdayOffWeeks = Array.isArray(input.customSaturdayOffWeeks)
    ? Array.from(
        new Set<number>(
          input.customSaturdayOffWeeks.map((week: unknown) =>
            normalizeNumber(week, 0, "Saturday week number", 1)
          )
        )
      ).sort((left, right) => left - right)
    : base.customSaturdayOffWeeks || [];
  if (customSaturdayOffWeeks.some((week: number) => week > 5)) {
    throw generateError("Saturday week numbers must be between 1 and 5", 400);
  }
  if (saturdayRule === "custom_weeks_off" && customSaturdayOffWeeks.length === 0) {
    throw generateError("Select at least one Saturday week for the custom rule", 400);
  }

  const startTime = validateTime(input.startTime, "Schedule start time", base.startTime);
  const endTime = validateTime(input.endTime, "Schedule end time", base.endTime);
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);
  if (startMinutes === endMinutes) {
    throw generateError("Schedule start and end time cannot be the same", 400);
  }
  const shiftDurationMinutes =
    endMinutes > startMinutes ? endMinutes - startMinutes : 24 * 60 - startMinutes + endMinutes;
  const unpaidBreakMinutes = normalizeNumber(
    input.unpaidBreakMinutes,
    base.unpaidBreakMinutes,
    "Unpaid break minutes"
  );
  if (unpaidBreakMinutes >= shiftDurationMinutes) {
    throw generateError("Unpaid break must be shorter than the scheduled shift", 400);
  }

  return {
    timezone: validateTimezone(input.timezone, base.timezone),
    workingDays: requestedWorkingDays,
    saturdayRule: saturdayRule as WorkScheduleRules["saturdayRule"],
    customSaturdayOffWeeks:
      saturdayRule === "custom_weeks_off" ? customSaturdayOffWeeks : [],
    startTime,
    endTime,
    unpaidBreakMinutes,
  };
}

function serializeVersions(versions: any[]) {
  const publishedVersions = versions.filter((version) => version.status === "published");
  return versions.map((version) => ({
    ...version,
    effectiveTo: getVersionEffectiveTo(version, publishedVersions),
  }));
}

async function findWorkSchedule(companyId: mongoose.Types.ObjectId, scheduleIdInput: unknown) {
  const scheduleId = validateObjectId(scheduleIdInput, "work schedule id");
  const schedule = await WorkSchedule.findOne({
    _id: new mongoose.Types.ObjectId(scheduleId),
    company: companyId,
  });
  if (!schedule) throw generateError("Work schedule not found", 404);
  return schedule;
}

export async function listWorkSchedulesService(req: any, res: Response, next: NextFunction) {
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

    const [schedules, total] = await Promise.all([
      WorkSchedule.find(match)
        .sort({ status: 1, name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WorkSchedule.countDocuments(match),
    ]);
    const scheduleIds = schedules.map((schedule) => schedule._id);
    const versions = scheduleIds.length
      ? await WorkScheduleVersion.find({
          company: companyObjectId,
          schedule: { $in: scheduleIds },
        })
          .sort({ versionNumber: -1 })
          .lean()
      : [];
    const assignments = scheduleIds.length
      ? await WorkforcePolicyAssignment.aggregate([
          {
            $match: {
              company: companyObjectId,
              resourceType: "work_schedule",
              resource: { $in: scheduleIds },
              $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }],
            },
          },
          { $group: { _id: "$resource", count: { $sum: 1 } } },
        ])
      : [];
    const assignmentCountBySchedule = new Map(
      assignments.map((item: any) => [String(item._id), item.count])
    );
    const versionsBySchedule = versions.reduce<Map<string, any[]>>((map, version: any) => {
      const key = String(version.schedule);
      map.set(key, [...(map.get(key) || []), version]);
      return map;
    }, new Map());
    const data = schedules.map((schedule: any) => {
      const scheduleVersions = versionsBySchedule.get(String(schedule._id)) || [];
      return {
        ...schedule,
        draftVersion:
          scheduleVersions.find((version) => version.status === "draft") || null,
        latestPublishedVersion:
          scheduleVersions
            .filter((version) => version.status === "published")
            .sort((left, right) => right.versionNumber - left.versionNumber)[0] || null,
        assignmentCount: assignmentCountBySchedule.get(String(schedule._id)) || 0,
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

export async function getWorkScheduleService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.query.companyId);
    const schedule = await findWorkSchedule(companyObjectId, req.params.scheduleId);
    const versions = await WorkScheduleVersion.find({
      company: companyObjectId,
      schedule: schedule._id,
    })
      .sort({ versionNumber: -1 })
      .lean();
    return res.status(200).json({
      success: true,
      data: { schedule: schedule.toObject(), versions: serializeVersions(versions) },
    });
  } catch (error) {
    next(error);
  }
}

export async function createWorkScheduleService(req: any, res: Response, next: NextFunction) {
  let createdScheduleId: mongoose.Types.ObjectId | null = null;
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
    if (!name || !code) throw generateError("Schedule name and code are required", 422);
    const rules = normalizeWorkScheduleRules(req.body.rules || {});
    const effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date", false);
    const schedule = await WorkSchedule.create({
      company: companyObjectId,
      name,
      code,
      description: normalizeText(req.body.description),
      latestVersionNumber: 1,
      createdBy: actorId,
    });
    createdScheduleId = schedule._id as mongoose.Types.ObjectId;
    const version = await WorkScheduleVersion.create({
      company: companyObjectId,
      schedule: schedule._id,
      versionNumber: 1,
      status: "draft",
      effectiveFrom,
      changeReason: normalizeText(req.body.changeReason) || "Initial work schedule",
      rules,
      createdBy: actorId,
    });
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "work_schedule",
      entityId: schedule._id as mongoose.Types.ObjectId,
      action: "created",
      actor: actorId,
      details: { code, initialVersionId: version._id, effectiveFrom },
    });
    return res.status(201).json({
      success: true,
      message: "Work schedule draft created",
      data: { schedule, version },
    });
  } catch (error: any) {
    if (createdScheduleId) {
      await WorkSchedule.deleteOne({ _id: createdScheduleId }).catch(() => undefined);
    }
    if (error?.code === 11000) {
      return next(generateError("A work schedule with this code already exists", 409));
    }
    next(error);
  }
}

export async function updateWorkScheduleService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const schedule = await findWorkSchedule(companyObjectId, req.params.scheduleId);
    if (schedule.status === "archived") {
      throw generateError("Archived work schedules cannot be edited", 409);
    }
    if (req.body.name !== undefined) {
      const name = normalizeText(req.body.name);
      if (!name) throw generateError("Schedule name is required", 422);
      schedule.name = name;
    }
    if (req.body.code !== undefined) {
      const code = normalizeText(req.body.code).toUpperCase();
      if (!code) throw generateError("Schedule code is required", 422);
      schedule.code = code;
    }
    if (req.body.description !== undefined) {
      schedule.description = normalizeText(req.body.description);
    }
    await schedule.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "work_schedule",
      entityId: schedule._id as mongoose.Types.ObjectId,
      action: "metadata_updated",
      actor: actorId,
      details: { name: schedule.name, code: schedule.code },
    });
    return res.status(200).json({
      success: true,
      message: "Work schedule updated",
      data: schedule,
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      return next(generateError("A work schedule with this code already exists", 409));
    }
    next(error);
  }
}

export async function createWorkScheduleVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const schedule = await findWorkSchedule(companyObjectId, req.params.scheduleId);
    if (schedule.status === "archived") {
      throw generateError("Archived work schedules cannot receive new versions", 409);
    }
    const existingDraft = await WorkScheduleVersion.findOne({
      company: companyObjectId,
      schedule: schedule._id,
      status: "draft",
    });
    if (existingDraft) {
      throw generateError("Finish or cancel the existing schedule draft first", 409);
    }
    const source = await WorkScheduleVersion.findOne({
      company: companyObjectId,
      schedule: schedule._id,
      status: "published",
    }).sort({ effectiveFrom: -1, versionNumber: -1 });
    const rules = normalizeWorkScheduleRules(req.body.rules || {}, source?.rules || DEFAULT_RULES);
    const effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date", false);
    const updatedSchedule = await WorkSchedule.findOneAndUpdate(
      { _id: schedule._id, company: companyObjectId, status: "active" },
      { $inc: { latestVersionNumber: 1 } },
      { new: true }
    );
    if (!updatedSchedule) throw generateError("Work schedule is no longer active", 409);
    const version = await WorkScheduleVersion.create({
      company: companyObjectId,
      schedule: schedule._id,
      versionNumber: updatedSchedule.latestVersionNumber,
      status: "draft",
      effectiveFrom,
      changeReason: normalizeText(req.body.changeReason),
      rules,
      createdBy: actorId,
    });
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "work_schedule_version",
      entityId: version._id as mongoose.Types.ObjectId,
      action: "draft_created",
      actor: actorId,
      details: { scheduleId: schedule._id, versionNumber: version.versionNumber, effectiveFrom },
    });
    return res.status(201).json({
      success: true,
      message: "Work schedule version draft created",
      data: version,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateWorkScheduleVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const schedule = await findWorkSchedule(companyObjectId, req.params.scheduleId);
    const versionId = validateObjectId(req.params.versionId, "work schedule version id");
    const version = await WorkScheduleVersion.findOne({
      _id: new mongoose.Types.ObjectId(versionId),
      company: companyObjectId,
      schedule: schedule._id,
    });
    if (!version) throw generateError("Work schedule version not found", 404);
    if (version.status !== "draft") {
      throw generateError("Published work schedule versions are immutable", 409);
    }
    version.rules = normalizeWorkScheduleRules(req.body.rules || {}, version.rules) as any;
    if (req.body.effectiveFrom !== undefined) {
      version.effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date", false);
    }
    if (req.body.changeReason !== undefined) {
      version.changeReason = normalizeText(req.body.changeReason);
    }
    await version.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "work_schedule_version",
      entityId: version._id as mongoose.Types.ObjectId,
      action: "draft_updated",
      actor: actorId,
      details: { scheduleId: schedule._id, versionNumber: version.versionNumber },
    });
    return res.status(200).json({
      success: true,
      message: "Work schedule draft updated",
      data: version,
    });
  } catch (error) {
    next(error);
  }
}

export async function publishWorkScheduleVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const schedule = await findWorkSchedule(companyObjectId, req.params.scheduleId);
    if (schedule.status !== "active") throw generateError("Archived schedules cannot be published", 409);
    const versionId = validateObjectId(req.params.versionId, "work schedule version id");
    const version = await WorkScheduleVersion.findOne({
      _id: new mongoose.Types.ObjectId(versionId),
      company: companyObjectId,
      schedule: schedule._id,
    });
    if (!version) throw generateError("Work schedule version not found", 404);
    if (version.status !== "draft") {
      throw generateError("Only draft work schedule versions can be published", 409);
    }
    const effectiveFrom = parseEffectiveDate(
      req.body.effectiveFrom || version.effectiveFrom,
      "effective from date"
    ) as Date;
    const changeReason = normalizeText(req.body.changeReason || version.changeReason);
    if (version.versionNumber > 1 && changeReason.length < 3) {
      throw generateError("A change reason is required when publishing a new schedule version", 422);
    }
    const duplicate = await WorkScheduleVersion.findOne({
      company: companyObjectId,
      schedule: schedule._id,
      status: "published",
      effectiveFrom,
      _id: { $ne: version._id },
    }).lean();
    if (duplicate) throw generateError("Another published schedule version starts on this date", 409);
    version.rules = normalizeWorkScheduleRules({}, version.rules) as any;
    version.effectiveFrom = effectiveFrom;
    version.changeReason = changeReason || "Initial work schedule publication";
    version.status = "published";
    version.publishedAt = new Date();
    version.publishedBy = actorId;
    await version.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "work_schedule_version",
      entityId: version._id as mongoose.Types.ObjectId,
      action: "published",
      actor: actorId,
      details: { scheduleId: schedule._id, versionNumber: version.versionNumber, effectiveFrom },
    });
    return res.status(200).json({
      success: true,
      message: "Work schedule version published",
      data: version,
      meta: { historicalRecalculationRequired: effectiveFrom.getTime() < Date.now() },
    });
  } catch (error) {
    next(error);
  }
}

export async function archiveWorkScheduleService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const schedule = await findWorkSchedule(companyObjectId, req.params.scheduleId);
    if (schedule.status === "archived") {
      return res.status(200).json({
        success: true,
        message: "Work schedule is already archived",
        data: schedule,
      });
    }
    const reason = normalizeText(req.body.reason || req.body.archiveReason);
    if (reason.length < 3) throw generateError("Archive reason must be at least 3 characters", 422);
    const activeAssignments = await WorkforcePolicyAssignment.countDocuments({
      company: companyObjectId,
      resourceType: "work_schedule",
      resource: schedule._id,
      $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }],
    });
    if (activeAssignments > 0) {
      throw generateError(
        `End ${activeAssignments} active or scheduled assignment${activeAssignments === 1 ? "" : "s"} before archiving this schedule`,
        409
      );
    }
    schedule.status = "archived";
    schedule.archivedAt = new Date();
    schedule.archivedBy = actorId;
    schedule.archiveReason = reason;
    await schedule.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "work_schedule",
      entityId: schedule._id as mongoose.Types.ObjectId,
      action: "archived",
      actor: actorId,
      details: { reason },
    });
    return res.status(200).json({
      success: true,
      message: "Work schedule archived",
      data: schedule,
    });
  } catch (error) {
    next(error);
  }
}
