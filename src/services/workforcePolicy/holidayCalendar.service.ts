import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import HolidayCalendar from "../../schemas/WorkforcePolicy/HolidayCalendar.schema";
import HolidayCalendarVersion from "../../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
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

function validateTimezone(value: unknown, fallback = "Asia/Kolkata") {
  const timezone = normalizeText(value || fallback);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw generateError("Invalid IANA timezone", 400);
  }
  return timezone;
}

function normalizeHolidays(input: any) {
  if (!Array.isArray(input)) {
    throw generateError("Holidays must be an array", 400);
  }

  const seenDates = new Set<string>();
  return input
    .map((holiday: any, index: number) => {
      const date = parseEffectiveDate(holiday?.date, `holiday date at row ${index + 1}`) as Date;
      const dateKey = date.toISOString().slice(0, 10);
      if (seenDates.has(dateKey)) {
        throw generateError(`Duplicate holiday date ${dateKey}`, 409);
      }
      seenDates.add(dateKey);
      const name = normalizeText(holiday?.name);
      if (!name) throw generateError(`Holiday name is required at row ${index + 1}`, 422);
      const type = normalizeText(holiday?.type || "mandatory");
      if (!["mandatory", "optional"].includes(type)) {
        throw generateError(`Invalid holiday type at row ${index + 1}`, 400);
      }

      return {
        date,
        name,
        type,
        isHalfDay: holiday?.isHalfDay === true,
        description: normalizeText(holiday?.description),
      };
    })
    .sort((left, right) => left.date.getTime() - right.date.getTime());
}

function serializeVersions(versions: any[]) {
  const publishedVersions = versions.filter((version) => version.status === "published");
  return versions.map((version) => ({
    ...version,
    effectiveTo: getVersionEffectiveTo(version, publishedVersions),
  }));
}

async function findHolidayCalendar(companyId: mongoose.Types.ObjectId, calendarIdInput: unknown) {
  const calendarId = validateObjectId(calendarIdInput, "holiday calendar id");
  const calendar = await HolidayCalendar.findOne({
    _id: new mongoose.Types.ObjectId(calendarId),
    company: companyId,
  });
  if (!calendar) throw generateError("Holiday calendar not found", 404);
  return calendar;
}

export async function listHolidayCalendarsService(req: any, res: Response, next: NextFunction) {
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

    const [calendars, total] = await Promise.all([
      HolidayCalendar.find(match)
        .sort({ status: 1, name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      HolidayCalendar.countDocuments(match),
    ]);
    const calendarIds = calendars.map((calendar) => calendar._id);
    const versions = calendarIds.length
      ? await HolidayCalendarVersion.find({ company: companyObjectId, calendar: { $in: calendarIds } })
          .sort({ versionNumber: -1 })
          .lean()
      : [];
    const assignments = calendarIds.length
      ? await WorkforcePolicyAssignment.aggregate([
          {
            $match: {
              company: companyObjectId,
              resourceType: "holiday_calendar",
              resource: { $in: calendarIds },
              $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }],
            },
          },
          { $group: { _id: "$resource", count: { $sum: 1 } } },
        ])
      : [];
    const assignmentCountByCalendar = new Map(
      assignments.map((item: any) => [String(item._id), item.count])
    );
    const versionsByCalendar = versions.reduce<Map<string, any[]>>((map, version: any) => {
      const key = String(version.calendar);
      map.set(key, [...(map.get(key) || []), version]);
      return map;
    }, new Map());
    const data = calendars.map((calendar: any) => {
      const calendarVersions = versionsByCalendar.get(String(calendar._id)) || [];
      return {
        ...calendar,
        draftVersion: calendarVersions.find((version) => version.status === "draft") || null,
        latestPublishedVersion:
          calendarVersions
            .filter((version) => version.status === "published")
            .sort((left, right) => right.versionNumber - left.versionNumber)[0] || null,
        assignmentCount: assignmentCountByCalendar.get(String(calendar._id)) || 0,
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

export async function getHolidayCalendarService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.query.companyId);
    const calendar = await findHolidayCalendar(companyObjectId, req.params.calendarId);
    const versions = await HolidayCalendarVersion.find({
      company: companyObjectId,
      calendar: calendar._id,
    })
      .sort({ versionNumber: -1 })
      .lean();
    return res.status(200).json({
      success: true,
      data: { calendar: calendar.toObject(), versions: serializeVersions(versions) },
    });
  } catch (error) {
    next(error);
  }
}

export async function createHolidayCalendarService(req: any, res: Response, next: NextFunction) {
  let createdCalendarId: mongoose.Types.ObjectId | null = null;
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
    if (!name || !code) throw generateError("Calendar name and code are required", 422);
    const effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date", false);
    const holidays = normalizeHolidays(req.body.holidays || []);
    const calendar = await HolidayCalendar.create({
      company: companyObjectId,
      name,
      code,
      description: normalizeText(req.body.description),
      latestVersionNumber: 1,
      createdBy: actorId,
    });
    createdCalendarId = calendar._id as mongoose.Types.ObjectId;
    const version = await HolidayCalendarVersion.create({
      company: companyObjectId,
      calendar: calendar._id,
      versionNumber: 1,
      status: "draft",
      effectiveFrom,
      timezone: validateTimezone(req.body.timezone),
      holidays,
      changeReason: normalizeText(req.body.changeReason) || "Initial holiday calendar",
      createdBy: actorId,
    });
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "holiday_calendar",
      entityId: calendar._id as mongoose.Types.ObjectId,
      action: "created",
      actor: actorId,
      details: { code, initialVersionId: version._id, holidayCount: holidays.length },
    });

    return res.status(201).json({
      success: true,
      message: "Holiday calendar draft created",
      data: { calendar, version },
    });
  } catch (error: any) {
    if (createdCalendarId) {
      await HolidayCalendar.deleteOne({ _id: createdCalendarId }).catch(() => undefined);
    }
    if (error?.code === 11000) {
      return next(generateError("A holiday calendar with this code already exists", 409));
    }
    next(error);
  }
}

export async function createHolidayCalendarVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const calendar = await findHolidayCalendar(companyObjectId, req.params.calendarId);
    if (calendar.status === "archived") throw generateError("Archived calendars cannot receive new versions", 409);
    const existingDraft = await HolidayCalendarVersion.findOne({
      company: companyObjectId,
      calendar: calendar._id,
      status: "draft",
    });
    if (existingDraft) {
      throw generateError("Finish or cancel the existing calendar draft first", 409);
    }
    const source = await HolidayCalendarVersion.findOne({
      company: companyObjectId,
      calendar: calendar._id,
      status: "published",
    }).sort({ effectiveFrom: -1, versionNumber: -1 });
    const updatedCalendar = await HolidayCalendar.findOneAndUpdate(
      { _id: calendar._id, company: companyObjectId, status: "active" },
      { $inc: { latestVersionNumber: 1 } },
      { new: true }
    );
    if (!updatedCalendar) throw generateError("Holiday calendar is no longer active", 409);
    const version = await HolidayCalendarVersion.create({
      company: companyObjectId,
      calendar: calendar._id,
      versionNumber: updatedCalendar.latestVersionNumber,
      status: "draft",
      effectiveFrom: parseEffectiveDate(req.body.effectiveFrom, "effective from date", false),
      timezone: validateTimezone(req.body.timezone, source?.timezone),
      holidays: normalizeHolidays(
        req.body.holidays !== undefined ? req.body.holidays : source?.holidays || []
      ),
      changeReason: normalizeText(req.body.changeReason),
      createdBy: actorId,
    });
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "holiday_version",
      entityId: version._id as mongoose.Types.ObjectId,
      action: "draft_created",
      actor: actorId,
      details: { calendarId: calendar._id, versionNumber: version.versionNumber },
    });
    return res.status(201).json({
      success: true,
      message: "Holiday calendar version draft created",
      data: version,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateHolidayCalendarVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const calendar = await findHolidayCalendar(companyObjectId, req.params.calendarId);
    const versionId = validateObjectId(req.params.versionId, "holiday calendar version id");
    const version = await HolidayCalendarVersion.findOne({
      _id: new mongoose.Types.ObjectId(versionId),
      company: companyObjectId,
      calendar: calendar._id,
    });
    if (!version) throw generateError("Holiday calendar version not found", 404);
    if (version.status !== "draft") throw generateError("Published holiday calendar versions are immutable", 409);
    if (req.body.effectiveFrom !== undefined) {
      version.effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date", false);
    }
    if (req.body.timezone !== undefined) version.timezone = validateTimezone(req.body.timezone, version.timezone);
    if (req.body.holidays !== undefined) version.holidays = normalizeHolidays(req.body.holidays) as any;
    if (req.body.changeReason !== undefined) version.changeReason = normalizeText(req.body.changeReason);
    await version.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "holiday_version",
      entityId: version._id as mongoose.Types.ObjectId,
      action: "draft_updated",
      actor: actorId,
      details: { calendarId: calendar._id, holidayCount: version.holidays.length },
    });
    return res.status(200).json({ success: true, message: "Holiday calendar draft updated", data: version });
  } catch (error) {
    next(error);
  }
}

export async function publishHolidayCalendarVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const calendar = await findHolidayCalendar(companyObjectId, req.params.calendarId);
    if (calendar.status !== "active") throw generateError("Archived calendars cannot be published", 409);
    const versionId = validateObjectId(req.params.versionId, "holiday calendar version id");
    const version = await HolidayCalendarVersion.findOne({
      _id: new mongoose.Types.ObjectId(versionId),
      company: companyObjectId,
      calendar: calendar._id,
    });
    if (!version) throw generateError("Holiday calendar version not found", 404);
    if (version.status !== "draft") throw generateError("Only draft calendar versions can be published", 409);
    const effectiveFrom = parseEffectiveDate(
      req.body.effectiveFrom || version.effectiveFrom,
      "effective from date"
    ) as Date;
    const changeReason = normalizeText(req.body.changeReason || version.changeReason);
    if (version.versionNumber > 1 && changeReason.length < 3) {
      throw generateError("A change reason is required when publishing a new calendar version", 422);
    }
    const duplicate = await HolidayCalendarVersion.findOne({
      company: companyObjectId,
      calendar: calendar._id,
      status: "published",
      effectiveFrom,
      _id: { $ne: version._id },
    }).lean();
    if (duplicate) throw generateError("Another published calendar version starts on this date", 409);
    version.holidays = normalizeHolidays(version.holidays) as any;
    version.effectiveFrom = effectiveFrom;
    version.changeReason = changeReason || "Initial holiday calendar publication";
    version.status = "published";
    version.publishedAt = new Date();
    version.publishedBy = actorId;
    await version.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "holiday_version",
      entityId: version._id as mongoose.Types.ObjectId,
      action: "published",
      actor: actorId,
      details: { calendarId: calendar._id, versionNumber: version.versionNumber, effectiveFrom },
    });
    return res.status(200).json({
      success: true,
      message: "Holiday calendar version published",
      data: version,
      meta: { historicalRecalculationRequired: effectiveFrom.getTime() < Date.now() },
    });
  } catch (error) {
    next(error);
  }
}

export async function archiveHolidayCalendarService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const actorId = getPolicyActorId(req);
    const calendar = await findHolidayCalendar(companyObjectId, req.params.calendarId);
    if (calendar.status === "archived") {
      return res.status(200).json({ success: true, message: "Holiday calendar is already archived", data: calendar });
    }
    const reason = normalizeText(req.body.reason || req.body.archiveReason);
    if (reason.length < 3) throw generateError("Archive reason must be at least 3 characters", 422);
    const activeAssignments = await WorkforcePolicyAssignment.countDocuments({
      company: companyObjectId,
      resourceType: "holiday_calendar",
      resource: calendar._id,
      $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }],
    });
    if (activeAssignments > 0) {
      throw generateError(
        `End ${activeAssignments} active or scheduled assignment${activeAssignments === 1 ? "" : "s"} before archiving this calendar`,
        409
      );
    }
    calendar.status = "archived";
    calendar.archivedAt = new Date();
    calendar.archivedBy = actorId;
    calendar.archiveReason = reason;
    await calendar.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "holiday_calendar",
      entityId: calendar._id as mongoose.Types.ObjectId,
      action: "archived",
      actor: actorId,
      details: { reason },
    });
    return res.status(200).json({ success: true, message: "Holiday calendar archived", data: calendar });
  } catch (error) {
    next(error);
  }
}
