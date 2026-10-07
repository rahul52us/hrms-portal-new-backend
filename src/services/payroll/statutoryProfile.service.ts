import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import StatutoryProfile from "../../schemas/Payroll/StatutoryProfile.schema";
import StatutoryProfileVersion from "../../schemas/Payroll/StatutoryProfileVersion.schema";
import {
  ensurePayrollConfigurationManager,
  ensurePayrollViewer,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";
import { getStatutoryProvider, listStatutoryProviders } from "./statutory/statutoryProvider.registry";

const text = (value: unknown) => String(value ?? "").trim();

function objectId(value: unknown, label: string) {
  const normalized = text(value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function requiredRevision(value: unknown) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) throw generateError("Expected draft revision is required", 422);
  return revision;
}

function requiredReason(value: unknown, label: string) {
  const reason = text(value);
  if (reason.length < 3 || reason.length > 500) throw generateError(`${label} must contain 3 to 500 characters`, 422);
  return reason;
}

function parseDate(value: unknown, label: string) {
  const normalized = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw generateError(`${label} must use YYYY-MM-DD`, 422);
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw generateError(`${label} is invalid`, 422);
  }
  return date;
}

function previousDay(value: Date) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() - 1);
  return date;
}

function validateIdentity(body: any) {
  const name = text(body?.name);
  const code = text(body?.code).toUpperCase();
  const description = text(body?.description);
  if (name.length < 2 || name.length > 100) throw generateError("Profile name must contain 2 to 100 characters", 422);
  if (!/^[A-Z][A-Z0-9_]{1,29}$/.test(code)) throw generateError("Profile code must contain 2 to 30 uppercase letters, numbers, or underscores", 422);
  if (description.length > 500) throw generateError("Description cannot exceed 500 characters", 422);
  return { name, code, description };
}

function normalizedProviderPayload(providerKey: unknown, body: any, forPublish: boolean) {
  const provider = getStatutoryProvider(providerKey);
  if (!provider) throw generateError("Unsupported statutory provider", 422);
  const result = provider.validateAndNormalize({
    configuration: body?.configuration,
    enabledModules: body?.enabledModules,
    forPublish,
  });
  if (result.errors.length) throw generateError(result.errors.join("; "), 422);
  return { provider, ...result };
}

async function profileDetail(company: mongoose.Types.ObjectId, profileId: mongoose.Types.ObjectId | string) {
  const profile = await StatutoryProfile.findOne({ _id: profileId, company })
    .populate("createdBy updatedBy", "name username code role")
    .populate("latestPublishedVersion")
    .lean();
  if (!profile) return null;
  const versions = await StatutoryProfileVersion.find({ company, statutoryProfile: profile._id })
    .sort({ versionNumber: -1 })
    .populate("createdBy publishedBy cancelledBy", "name username code role")
    .lean();
  return { profile, versions, draftVersion: versions.find((version) => version.status === "draft") || null };
}

export async function listStatutoryProvidersService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollViewer(req);
    await resolvePayrollCompany(req, req.query?.companyId);
    return res.status(200).json({ success: true, data: listStatutoryProviders() });
  } catch (error) {
    next(error);
  }
}

export async function listStatutoryProfilesService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollViewer(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const profiles: any[] = await StatutoryProfile.find({ company: companyObjectId })
      .sort({ createdAt: 1 })
      .populate("latestPublishedVersion")
      .lean();
    const profileIds = profiles.map((profile) => profile._id);
    const drafts: any[] = profileIds.length
      ? await StatutoryProfileVersion.find({ company: companyObjectId, statutoryProfile: { $in: profileIds }, status: "draft" }).lean()
      : [];
    const draftByProfile = new Map(drafts.map((version) => [String(version.statutoryProfile), version]));
    return res.status(200).json({
      success: true,
      data: profiles.map((profile) => ({ ...profile, draftVersion: draftByProfile.get(String(profile._id)) || null })),
    });
  } catch (error) {
    next(error);
  }
}

export async function getStatutoryProfileService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollViewer(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const profileId = objectId(req.params.profileId, "statutory profile id");
    const detail = await profileDetail(companyObjectId, profileId);
    if (!detail) throw generateError("Statutory profile not found", 404);
    return res.status(200).json({ success: true, data: detail });
  } catch (error) {
    next(error);
  }
}

export async function createStatutoryProfileService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true, "manage statutory profiles");
    const actorId = getPayrollActorId(req);
    const identity = validateIdentity(req.body);
    const normalized = normalizedProviderPayload(req.body?.providerKey, req.body, false);
    let profileId: mongoose.Types.ObjectId | null = null;

    await mongoose.connection.transaction(async (session) => {
      const existing = await StatutoryProfile.findOne({ company: companyObjectId }).session(session).lean();
      if (existing) throw generateError("This company already has a statutory profile", 409);
      const [profile]: any[] = await StatutoryProfile.create([{
        company: companyObjectId,
        ...identity,
        countryCode: normalized.provider.countryCode,
        providerKey: normalized.provider.key,
        latestVersionNumber: 1,
        revision: 1,
        createdBy: actorId,
        updatedBy: actorId,
      }], { session });
      await StatutoryProfileVersion.create([{
        company: companyObjectId,
        statutoryProfile: profile._id,
        versionNumber: 1,
        status: "draft",
        countryCode: normalized.provider.countryCode,
        providerKey: normalized.provider.key,
        providerImplementationVersion: normalized.provider.implementationVersion,
        enabledModules: normalized.enabledModules,
        configuration: normalized.configuration,
        revision: 1,
        createdBy: actorId,
      }], { session });
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "statutory_profile",
        entityId: profile._id,
        action: "created",
        actor: actorId,
        reason: text(req.body?.changeReason) || "Initial statutory profile draft",
        details: {
          code: identity.code,
          countryCode: normalized.provider.countryCode,
          providerKey: normalized.provider.key,
          versionNumber: 1,
        },
      }, session);
      profileId = profile._id;
    });

    if (!profileId) throw generateError("Statutory profile could not be created", 500);
    return res.status(201).json({
      success: true,
      message: "Statutory profile draft created",
      data: await profileDetail(companyObjectId, profileId),
    });
  } catch (error: any) {
    if (error?.code === 11000) return next(generateError("This company already has a statutory profile", 409));
    next(error);
  }
}

export async function updateStatutoryProfileDraftService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true, "manage statutory profiles");
    const actorId = getPayrollActorId(req);
    const profileId = objectId(req.params.profileId, "statutory profile id");
    const versionId = objectId(req.params.versionId, "statutory profile version id");
    const revision = requiredRevision(req.body?.expectedRevision);

    await mongoose.connection.transaction(async (session) => {
      const profile: any = await StatutoryProfile.findOne({ _id: profileId, company: companyObjectId }).session(session).lean();
      const version: any = await StatutoryProfileVersion.findOne({ _id: versionId, company: companyObjectId, statutoryProfile: profileId }).session(session).lean();
      if (!profile) throw generateError("Statutory profile not found", 404);
      if (!version) throw generateError("Statutory profile version not found", 404);
      if (version.status !== "draft") throw generateError("Only a draft statutory profile version can be edited", 409);
      if (Number(version.revision) !== revision) throw generateError("Statutory profile draft changed. Refresh and try again", 409);
      const normalized = normalizedProviderPayload(profile.providerKey, req.body, false);
      const update = await StatutoryProfileVersion.updateOne(
        { _id: versionId, company: companyObjectId, status: "draft", revision },
        {
          $set: {
            providerImplementationVersion: normalized.provider.implementationVersion,
            enabledModules: normalized.enabledModules,
            configuration: normalized.configuration,
            changeReason: text(req.body?.changeReason),
          },
          $inc: { revision: 1 },
        },
        { session }
      );
      if (update.modifiedCount !== 1) throw generateError("Statutory profile draft changed while it was being saved", 409);
      await StatutoryProfile.updateOne(
        { _id: profileId, company: companyObjectId },
        { $set: { updatedBy: actorId }, $inc: { revision: 1 } },
        { session }
      );
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "statutory_profile",
        entityId: profileId,
        action: "draft_updated",
        actor: actorId,
        reason: text(req.body?.changeReason) || "Statutory profile draft updated",
        details: { versionNumber: version.versionNumber, enabledModules: normalized.enabledModules },
      }, session);
    });

    return res.status(200).json({ success: true, message: "Statutory profile draft updated", data: await profileDetail(companyObjectId, profileId) });
  } catch (error) {
    next(error);
  }
}

export async function createStatutoryProfileVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true, "manage statutory profiles");
    const actorId = getPayrollActorId(req);
    const profileId = objectId(req.params.profileId, "statutory profile id");

    await mongoose.connection.transaction(async (session) => {
      const profile: any = await StatutoryProfile.findOne({ _id: profileId, company: companyObjectId }).session(session).lean();
      if (!profile) throw generateError("Statutory profile not found", 404);
      const existingDraft = await StatutoryProfileVersion.findOne({ company: companyObjectId, statutoryProfile: profileId, status: "draft" }).session(session).lean();
      if (existingDraft) throw generateError("Finish or cancel the existing statutory profile draft first", 409);
      const latestPublished: any = await StatutoryProfileVersion.findOne({
        company: companyObjectId,
        statutoryProfile: profileId,
        status: "published",
      }).sort({ versionNumber: -1 }).session(session).lean();
      const base: any = latestPublished || await StatutoryProfileVersion.findOne({
        company: companyObjectId,
        statutoryProfile: profileId,
        status: "cancelled",
      }).sort({ versionNumber: -1 }).session(session).lean();
      if (!base) throw generateError("No statutory profile version is available to copy", 409);
      const versionNumber = Number(profile.latestVersionNumber || 0) + 1;
      await StatutoryProfileVersion.create([{
        company: companyObjectId,
        statutoryProfile: profileId,
        versionNumber,
        status: "draft",
        countryCode: profile.countryCode,
        providerKey: profile.providerKey,
        providerImplementationVersion: base.providerImplementationVersion,
        enabledModules: base.enabledModules || [],
        configuration: base.configuration || {},
        revision: 1,
        changeReason: text(req.body?.changeReason),
        createdBy: actorId,
      }], { session });
      const updated = await StatutoryProfile.updateOne(
        { _id: profileId, company: companyObjectId, latestVersionNumber: profile.latestVersionNumber },
        { $set: { latestVersionNumber: versionNumber, updatedBy: actorId }, $inc: { revision: 1 } },
        { session }
      );
      if (updated.modifiedCount !== 1) throw generateError("Statutory profile changed while the new version was being created", 409);
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "statutory_profile",
        entityId: profileId,
        action: "version_created",
        actor: actorId,
        reason: text(req.body?.changeReason) || "New statutory profile version",
        details: { versionNumber, copiedFromVersion: base.versionNumber },
      }, session);
    });

    return res.status(201).json({ success: true, message: "New statutory profile draft created", data: await profileDetail(companyObjectId, profileId) });
  } catch (error: any) {
    if (error?.code === 11000) return next(generateError("This statutory profile already has a draft version", 409));
    next(error);
  }
}

export async function publishStatutoryProfileVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true, "manage statutory profiles");
    const actorId = getPayrollActorId(req);
    const profileId = objectId(req.params.profileId, "statutory profile id");
    const versionId = objectId(req.params.versionId, "statutory profile version id");
    const revision = requiredRevision(req.body?.expectedRevision);
    const effectiveFrom = parseDate(req.body?.effectiveFrom, "Effective date");
    const reason = requiredReason(req.body?.reason, "Publication reason");

    await mongoose.connection.transaction(async (session) => {
      const profile: any = await StatutoryProfile.findOne({ _id: profileId, company: companyObjectId }).session(session).lean();
      const version: any = await StatutoryProfileVersion.findOne({ _id: versionId, company: companyObjectId, statutoryProfile: profileId }).session(session).lean();
      if (!profile) throw generateError("Statutory profile not found", 404);
      if (!version) throw generateError("Statutory profile version not found", 404);
      if (version.status !== "draft") throw generateError("Only a draft statutory profile version can be published", 409);
      if (Number(version.revision) !== revision) throw generateError("Statutory profile draft changed. Refresh and try again", 409);
      const normalized = normalizedProviderPayload(profile.providerKey, version, true);
      const published: any[] = await StatutoryProfileVersion.find({
        company: companyObjectId,
        statutoryProfile: profileId,
        status: "published",
      }).sort({ effectiveFrom: 1 }).session(session).lean();
      if (published.some((item) => item.effectiveFrom && new Date(item.effectiveFrom).getTime() === effectiveFrom.getTime())) {
        throw generateError("A statutory profile version already starts on this date", 409);
      }
      const previous = [...published].reverse().find((item) => item.effectiveFrom && new Date(item.effectiveFrom) < effectiveFrom);
      const nextVersion = published.find((item) => item.effectiveFrom && new Date(item.effectiveFrom) > effectiveFrom);
      if (previous) {
        await StatutoryProfileVersion.updateOne(
          { _id: previous._id, company: companyObjectId, status: "published" },
          { $set: { effectiveTo: previousDay(effectiveFrom) } },
          { session }
        );
      }
      const publishedAt = new Date();
      const update = await StatutoryProfileVersion.updateOne(
        { _id: versionId, company: companyObjectId, status: "draft", revision },
        {
          $set: {
            status: "published",
            effectiveFrom,
            effectiveTo: nextVersion?.effectiveFrom ? previousDay(new Date(nextVersion.effectiveFrom)) : null,
            providerImplementationVersion: normalized.provider.implementationVersion,
            enabledModules: normalized.enabledModules,
            configuration: normalized.configuration,
            changeReason: reason,
            publishedAt,
            publishedBy: actorId,
          },
          $inc: { revision: 1 },
        },
        { session }
      );
      if (update.modifiedCount !== 1) throw generateError("Statutory profile changed while it was being published", 409);
      const latestPublished = [...published, { _id: versionId, effectiveFrom }]
        .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime())[0];
      await StatutoryProfile.updateOne(
        { _id: profileId, company: companyObjectId },
        { $set: { latestPublishedVersion: latestPublished._id, updatedBy: actorId }, $inc: { revision: 1 } },
        { session }
      );
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "statutory_profile",
        entityId: profileId,
        action: "version_published",
        actor: actorId,
        reason,
        details: {
          versionNumber: version.versionNumber,
          effectiveFrom: effectiveFrom.toISOString().slice(0, 10),
          providerKey: profile.providerKey,
          providerImplementationVersion: normalized.provider.implementationVersion,
          enabledModules: normalized.enabledModules,
        },
      }, session);
    });

    return res.status(200).json({ success: true, message: "Statutory profile version published", data: await profileDetail(companyObjectId, profileId) });
  } catch (error) {
    next(error);
  }
}

export async function cancelStatutoryProfileDraftService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true, "manage statutory profiles");
    const actorId = getPayrollActorId(req);
    const profileId = objectId(req.params.profileId, "statutory profile id");
    const versionId = objectId(req.params.versionId, "statutory profile version id");
    const revision = requiredRevision(req.body?.expectedRevision);
    const reason = requiredReason(req.body?.reason, "Cancellation reason");
    await mongoose.connection.transaction(async (session) => {
      const cancelledAt = new Date();
      const update = await StatutoryProfileVersion.updateOne(
        { _id: versionId, company: companyObjectId, statutoryProfile: profileId, status: "draft", revision },
        { $set: { status: "cancelled", cancelledAt, cancelledBy: actorId, cancelReason: reason }, $inc: { revision: 1 } },
        { session }
      );
      if (update.modifiedCount !== 1) throw generateError("Draft not found or changed. Refresh and try again", 409);
      const profileUpdate = await StatutoryProfile.updateOne(
        { _id: profileId, company: companyObjectId },
        { $set: { updatedBy: actorId }, $inc: { revision: 1 } },
        { session }
      );
      if (profileUpdate.matchedCount !== 1) throw generateError("Statutory profile not found", 404);
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "statutory_profile",
        entityId: profileId,
        action: "draft_cancelled",
        actor: actorId,
        reason,
        details: { versionId },
      }, session);
    });
    return res.status(200).json({ success: true, message: "Statutory profile draft cancelled", data: await profileDetail(companyObjectId, profileId) });
  } catch (error) {
    next(error);
  }
}

export async function resolveCompanyStatutorySnapshot(
  company: mongoose.Types.ObjectId,
  asOfDate: string,
  session?: mongoose.ClientSession
) {
  const profileQuery = StatutoryProfile.findOne({ company }).lean();
  if (session) profileQuery.session(session);
  const profile: any = await profileQuery;
  if (!profile) return null;
  const asOf = parseDate(asOfDate, "Payroll cycle end date");
  const versionQuery = StatutoryProfileVersion.findOne({
    company,
    statutoryProfile: profile._id,
    status: "published",
    effectiveFrom: { $lte: asOf },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: asOf } }],
  }).sort({ effectiveFrom: -1 }).lean();
  if (session) versionQuery.session(session);
  const version: any = await versionQuery;
  if (!version) return null;
  return {
    statutoryProfile: profile._id,
    statutoryProfileVersion: version._id,
    statutoryProfileVersionNumber: version.versionNumber,
    statutoryCountryCode: version.countryCode,
    statutoryProviderKey: version.providerKey,
    statutoryProviderImplementationVersion: version.providerImplementationVersion,
    statutoryEnabledModules: version.enabledModules || [],
    statutoryConfigurationSnapshot: version.configuration || {},
  };
}
