import mongoose from "mongoose";
import { AssetExportJob as Job, AssetExportArtifact as Artifact, AssetExportChunk as Chunk, AssetExportEvent as Event, AssetExportControl as Control, ASSET_EXPORT_STATES } from "../../schemas/Assets/AssetExport.schema";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { assetContext, AssetContext, idString, objectId, pagination, revision, text } from "./asset.utils";
import { canExportAssets } from "./assetTransfer.utils";
import { ASYNC_EXPORT_LIMITS as LIMITS, assertExportOwner, exportEvent, exportFilters, exportHash, exportJobDto, exportKey } from "./assetExport.utils";
import { EXPORT_ARTIFACT_FIELDS, streamExportArtifact } from "./assetExport.storage";
import { wakeAssetExports } from "./assetExport.worker";
import Location from "../../schemas/OfficeLocation/OfficeLocation.schema";
import { AssetCategory, BUILTIN_ASSET_CATEGORIES } from "../../schemas/Assets/AssetCategory.schema";

function access(req: any) { const ctx = assetContext(req, "view"); if (!canExportAssets(ctx)) throw generateError("Export Asset Inventory permission is required", 403); return ctx; }
async function owned(ctx: AssetContext, id: string, session?: mongoose.ClientSession) {
  const job: any = await Job.findOne({ _id: objectId(id, "export job id"), company: ctx.company, requestedBy: ctx.actor._id }).select("+artifact").session(session || null).lean();
  if (!job) throw generateError("Export job not found", 404); return job;
}
async function initialize() { for (const model of [Job, Artifact, Chunk, Event, Control]) await model.init(); }
async function replay(ctx: AssetContext, key: string, hash: string, session?: mongoose.ClientSession) {
  const event: any = await Event.findOne({ company: ctx.company, actor: ctx.actor._id, requestId: key }).select("+requestHash").session(session || null).lean();
  if (event && event.requestHash !== hash) throw generateError("Request id already used for another export operation", 409); return event;
}
export const listAssetExports = async (req: any, res: any, next: any) => {
  try {
    const ctx = access(req), { page, limit, skip } = pagination(req.query), state = req.query.state || "all";
    if (state !== "all" && !ASSET_EXPORT_STATES.includes(state)) throw generateError("Invalid export status", 400);
    const time = new Date(), match = { company: ctx.company, requestedBy: ctx.actor._id, ...(state === "all" ? {} : state === "expired" ? { $or: [{ state: "expired" }, { state: "ready", expiresAt: { $lte: time } }] } : state === "ready" ? { state, expiresAt: { $gt: time } } : { state }) };
    const data = await Job.find(match).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Job.countDocuments(match);
    res.json({ success: true, data: data.map(exportJobDto), limits: LIMITS, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const getAssetExport = async (req: any, res: any, next: any) => { try { const ctx = access(req); res.json({ success: true, data: exportJobDto(await owned(ctx, req.params.exportId)) }); } catch (error) { next(error); } };
export const assetExportHistory = async (req: any, res: any, next: any) => {
  try {
    const ctx = access(req), job = await owned(ctx, req.params.exportId), { page, limit, skip } = pagination(req.query), match = { company: ctx.company, job: job._id };
    const data = await Event.find(match).select("actorName action reason state rows createdAt").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Event.countDocuments(match);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const createAssetExport = async (req: any, res: any, next: any) => {
  try {
    const ctx = access(req), body = req.body || {};
    await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: idString(ctx.company), actionLabel: "queue inventory exports" }); await initialize();
    if (body.format !== undefined && body.format !== "csv") throw generateError("Background inventory export supports CSV only", 422);
    const input = { action: "queued", format: "csv", filters: exportFilters(ctx, body.filters ?? {}), reason: text(body.reason, "Export reason", 3, 1000) }, key = exportKey(body.requestId), hash = exportHash(input);
    const category: any = input.filters.category !== "all" && !BUILTIN_ASSET_CATEGORIES[input.filters.category] ? await AssetCategory.findOne({ company: ctx.company, code: input.filters.category }).select("name").lean() : null;
    const location: any = input.filters.officeLocation ? await Location.findOne({ company: ctx.company, _id: input.filters.officeLocation }).select("name").lean() : null;
    const filterLabels = { category: input.filters.category === "all" ? "All categories" : BUILTIN_ASSET_CATEGORIES[input.filters.category] || category?.name || input.filters.category, location: input.filters.officeLocation ? location?.name || "Missing inventory location" : "All locations" };
    let id: any, replayed = false;
    try { await mongoose.connection.transaction(async session => {
      const prior = await replay(ctx, key, hash, session); if (prior) { id = prior.job; replayed = true; return; }
      // Serialize quota reads even when an earlier export completes during two concurrent queue attempts.
      await Control.findOneAndUpdate({ company: ctx.company, actor: ctx.actor._id }, { $inc: { revision: 1 } }, { session, upsert: true, setDefaultsOnInsert: false });
      if (await Job.countDocuments({ company: ctx.company, requestedBy: ctx.actor._id, createdAt: { $gt: new Date(Date.now() - 24 * 3600000) } }).session(session) >= LIMITS.daily) throw generateError("Daily export limit reached. Reuse a ready file or wait before creating another job.", 429);
      if (await Job.exists({ company: ctx.company, requestedBy: ctx.actor._id, active: true }).session(session)) throw generateError("An inventory export is already queued or running. Finish or cancel it first.", 409);
      const job: any = (await Job.create([{ company: ctx.company, requestedBy: ctx.actor._id, requesterName: ctx.actor.name || "Inventory exporter", ...input, filterLabels, requestId: key, requestHash: hash }], { session }))[0].toObject();
      await exportEvent(job, "queued", input.reason, session, ctx.actor, key, hash); id = job._id;
    }); } catch (error: any) { if (error.code !== 11000) throw error; const prior = await replay(ctx, key, hash); if (!prior) throw generateError("An export was queued concurrently. Open export history before retrying.", 409); id = prior.job; replayed = true; }
    wakeAssetExports(); res.status(replayed ? 200 : 202).json({ success: true, data: exportJobDto(await owned(ctx, idString(id))), replayed });
  } catch (error) { next(error); }
};
export const changeAssetExport = (action: "cancel" | "retry") => async (req: any, res: any, next: any) => {
  try {
    const ctx = access(req), body = req.body || {}, target = objectId(req.params.exportId, "export job id"), key = exportKey(body.requestId), input = { action, target: idString(target), revision: revision(body.revision), reason: text(body.reason, "Export change reason", 3, 1000) }, hash = exportHash(input); let replayed = false;
    if (action === "retry") await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: idString(ctx.company), actionLabel: "retry inventory exports" });
    await initialize();
    try { await mongoose.connection.transaction(async session => {
      if (await replay(ctx, key, hash, session)) { replayed = true; return; }
      const job = await owned(ctx, idString(target), session);
      if (job.revision !== input.revision) throw generateError("Export changed. Reload before continuing.", 409);
      if (action === "retry" ? job.state !== "failed" || !job.retryable || job.attempts >= LIMITS.attempts : !["queued", "running", "ready"].includes(job.state) || job.state === "ready" && job.expiresAt <= new Date()) throw generateError("This export cannot be retried or cancelled in its current state", 409);
      if (action === "retry" && await Job.exists({ company: ctx.company, requestedBy: ctx.actor._id, active: true }).session(session)) throw generateError("Another inventory export is already active", 409);
      const saved: any = await Job.findOneAndUpdate({ _id: target, company: ctx.company, requestedBy: ctx.actor._id, revision: input.revision, state: job.state }, { $set: { state: action === "retry" ? "queued" : "cancelled", active: action === "retry", lease: null, leaseUntil: null, error: "", ...(action === "retry" ? { rows: 0, bytes: 0, completedAt: null, artifact: null } : { completedAt: new Date() }) }, $inc: { revision: 1 } }, { session, new: true }).lean();
      if (!saved) throw generateError("Export changed during this action", 409);
      if (action === "cancel" && job.artifact) await Artifact.updateOne({ _id: job.artifact, company: ctx.company, state: "attached" }, { $set: { state: "cleanup_pending", cleanupAfter: new Date(Date.now() + 15 * 60000) } }, { session });
      await exportEvent(saved, action === "retry" ? "retried" : "cancelled", input.reason, session, ctx.actor, key, hash);
    }); } catch (error: any) { if (error.code !== 11000) throw error; if (!await replay(ctx, key, hash)) throw generateError("Export changed concurrently. Reload before retrying.", 409); replayed = true; }
    if (action === "retry") wakeAssetExports(); res.json({ success: true, data: exportJobDto(await owned(ctx, idString(target))), replayed });
  } catch (error) { next(error); }
};
export const downloadAssetExport = async (req: any, res: any, next: any) => {
  try {
    const ctx = access(req), job = await owned(ctx, req.params.exportId); await assertExportOwner(job);
    if (job.state === "ready" && job.expiresAt <= new Date() || job.state === "expired") throw generateError("Export download expired. Create a new export.", 410);
    if (job.state !== "ready") throw generateError("Export is not ready for download", 409);
    const file = await Artifact.findOne({ _id: job.artifact, company: ctx.company, job: job._id, state: "attached" }).select(EXPORT_ARTIFACT_FIELDS).lean();
    if (!file) throw generateError("Export file is unavailable", 503); await streamExportArtifact(file, res);
  } catch (error) { next(error); }
};
