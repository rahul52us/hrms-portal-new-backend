import { createHash } from "crypto";
import mongoose from "mongoose";
import { Asset, AssetAudit as Audit } from "../../schemas/Assets/Asset.schema";
import { AssetDocument as Document, AssetDocumentVersion as Version, AssetDocumentEvent as Event, AssetDocumentControl as Control, ASSET_DOCUMENT_KINDS, ASSET_DOCUMENT_LIMITS as LIMITS } from "../../schemas/Assets/AssetDocument.schema";
import File from "../../schemas/Storage/PrivateStoredFile.schema";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { attachPrivateStoredFile, privateStoredFileBytes, privateUploadRequestId, queuePrivateStoredFileCleanup, sendPrivateFile, stagePrivateStoredFile } from "../storage/privateStoredFile.service";
import { assetContext, AssetContext, idString, objectId, pagination, revision, searchRegex, text } from "./asset.utils";
import { assertAssetDocumentKind, assetDocumentDto, assetDocumentMetadata, assetDocumentVersionDto, canManageAssetDocuments, validateAssetDocumentUpload } from "./assetDocument.utils";

async function asset(ctx: AssetContext, value: string, session?: mongoose.ClientSession) {
  const row: any = await Asset.findOne({ _id: objectId(value, "asset id"), company: ctx.company }).select("tag name").session(session || null).lean();
  if (!row) throw generateError("Asset not found", 404); return row;
}
async function document(ctx: AssetContext, assetId: any, value: string, session?: mongoose.ClientSession) {
  const row: any = await Document.findOne({ _id: objectId(value, "asset document id"), company: ctx.company, asset: assetId }).session(session || null).lean();
  if (!row) throw generateError("Asset document not found", 404); return row;
}
async function manager(req: any) {
  const ctx = assetContext(req, "view"); if (!canManageAssetDocuments(ctx)) throw generateError("Manage Asset Documents permission is required", 403);
  await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: idString(ctx.company), actionLabel: "manage private asset documents" });
  for (const model of [Document, Version, Event, Control, File, Audit]) await model.init();
  return ctx;
}
export const assetDocumentUploadAccess = async (req: any, _res: any, next: any) => {
  try { const ctx = await manager(req), unit = await asset(ctx, req.params.assetId); if (req.params.documentId) await document(ctx, unit._id, req.params.documentId); next(); } catch (error) { next(error); }
};
async function capacity(ctx: AssetContext, assetId: any, session?: mongoose.ClientSession) {
  const match = { company: ctx.company, asset: assetId };
  const active = await Document.countDocuments({ ...match, state: "active" }).session(session || null);
  const documents = await Document.countDocuments(match).session(session || null), versions = await Version.countDocuments(match).session(session || null);
  return { active, documents, versions };
}
async function fence(ctx: AssetContext, assetId: any, session: mongoose.ClientSession) {
  await Control.findOneAndUpdate({ company: ctx.company, asset: assetId }, { $inc: { revision: 1 } }, { session, upsert: true, new: true, setDefaultsOnInsert: false });
}
async function original(ctx: AssetContext, requestId: string, requestHash: string, session?: mongoose.ClientSession) {
  const prior: any = await Event.findOne({ company: ctx.company, actor: ctx.actor._id, requestId }).select("+requestHash").session(session || null).lean();
  if (prior && prior.requestHash !== requestHash) throw generateError("Request id already used for another asset document change", 409);
  return prior;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileSnapshot = (stored: any) => ({ privateFile: stored._id, name: stored.name, type: stored.type, size: stored.size, sha256: stored.sha256, scan: stored.scan });
async function audit(ctx: AssetContext, row: any, action: string, reason: string, requestId: string, requestHash: string, before: any, session: mongoose.ClientSession) {
  const _id = new mongoose.Types.ObjectId(), after = assetDocumentDto(ctx, row);
  await Event.create([{ _id, company: ctx.company, asset: row.asset, document: row._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Document manager", action, reason, requestId, requestHash, before, after }], { session });
  await Audit.create([{ company: ctx.company, asset: row.asset, actor: ctx.actor._id, actorName: ctx.actor.name || "Document manager", action: `document_${action}`, reason, requestId: `document-${_id}`, requestHash, before, after }], { session });
}
async function assertUploadCapacity(ctx: AssetContext, assetId: any, previous: any, hash: string, session?: mongoose.ClientSession) {
  const counts = await capacity(ctx, assetId, session);
  if (!previous && (counts.active >= LIMITS.active || counts.documents >= LIMITS.documents)) throw generateError("This asset reached its active or retained document limit. Archive an active entry or review retention before adding more.", 409);
  if (counts.versions >= LIMITS.versionsPerAsset || previous && previous.currentVersion >= LIMITS.versionsPerDocument) throw generateError("Retained file-version limit reached. Review document retention before uploading more.", 409);
  if (previous?.state === "archived") throw generateError("Restore this document before replacing its file", 409);
  if (previous?.currentFile.sha256 === hash) throw generateError("That file is already current. Edit document details without creating another version.", 409);
  if (await Document.exists({ company: ctx.company, asset: assetId, state: "active", "currentFile.sha256": hash, ...(previous ? { _id: { $ne: previous._id } } : {}) }).session(session || null)) throw generateError("This file is already attached to an active document for the asset", 409);
}
export const listAssetDocuments = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "view"), unit = await asset(ctx, req.params.assetId), { page, limit, skip } = pagination(req.query), state = req.query.state || "active", kind = req.query.kind || "all", search = searchRegex(req.query.search);
    if (!["active", "archived", "all"].includes(state) || kind !== "all" && !ASSET_DOCUMENT_KINDS.includes(kind)) throw generateError("Invalid asset document filter", 400);
    const match = { company: ctx.company, asset: unit._id, ...(state === "all" ? {} : { state }), ...(kind === "all" ? {} : { kind }), ...(search ? { $or: [{ title: search }, { "currentFile.name": search }] } : {}) };
    const counts = await capacity(ctx, unit._id), rows = await Document.find(match).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Document.countDocuments(match), canManage = canManageAssetDocuments(ctx);
    res.json({ success: true, data: rows.map((row) => assetDocumentDto(ctx, row, counts)), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }, capacity: counts, limits: LIMITS, canManage, canUpload: canManage && counts.active < LIMITS.active && counts.documents < LIMITS.documents && counts.versions < LIMITS.versionsPerAsset });
  } catch (error) { next(error); }
};
export const getAssetDocument = async (req: any, res: any, next: any) => {
  try { const ctx = assetContext(req, "view"), unit = await asset(ctx, req.params.assetId), row = await document(ctx, unit._id, req.params.documentId); res.json({ success: true, data: assetDocumentDto(ctx, row, await capacity(ctx, unit._id)) }); } catch (error) { next(error); }
};
export const assetDocumentHistory = (kind: "versions" | "events") => async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "view"), unit = await asset(ctx, req.params.assetId), row = await document(ctx, unit._id, req.params.documentId), { page, limit, skip } = pagination(req.query), match = { company: ctx.company, asset: unit._id, document: row._id }, model = kind === "versions" ? Version : Event;
    const rows: any[] = await model.find(match).select(kind === "events" ? "actorName action reason before after createdAt" : "").sort(kind === "versions" ? { version: -1 } : { createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await model.countDocuments(match);
    res.json({ success: true, data: kind === "versions" ? rows.map(assetDocumentVersionDto) : rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
/** R2/scan happens once outside retried database transactions; the domain link, version and audit commit together. */
export const uploadAssetDocument = (action: "uploaded" | "replaced") => async (req: any, res: any, next: any) => {
  let staged: any = null;
  try {
    const ctx = await manager(req), unit = await asset(ctx, req.params.assetId), body = req.body || {}, metadata = assetDocumentMetadata(body), requestId = privateUploadRequestId(body.requestId), reason = text(body.reason, "Document upload reason", 3, 1000);
    if (action === "uploaded" && body.revision !== undefined) throw generateError("Only replacement uploads use a document revision", 422);
    if (action === "replaced" && !/^[1-9]\d*$/.test(String(body.revision ?? ""))) throw generateError("Load the current document revision before replacing its file", 422);
    const currentRevision = action === "replaced" ? revision(Number(body.revision)) : null, upload = validateAssetDocumentUpload(req.file, metadata.kind), sha256 = createHash("sha256").update(upload.buffer).digest("hex");
    const input = { action, asset: idString(unit), document: action === "replaced" ? idString(objectId(req.params.documentId, "asset document id")) : null, revision: currentRevision, ...metadata, reason, file: { name: upload.name, type: upload.mimeType, size: upload.size, sha256 } }, requestHash = digest(input);
    let resultId: any, replayed = false;
    const prior = await original(ctx, requestId, requestHash);
    if (prior) { resultId = prior.document; replayed = true; }
    else {
      const previous = action === "replaced" ? await document(ctx, unit._id, req.params.documentId) : null;
      if (previous && previous.revision !== currentRevision) throw generateError("Document changed. Reload before uploading.", 409);
      await assertUploadCapacity(ctx, unit._id, previous, sha256);
      staged = await stagePrivateStoredFile({ company: ctx.company, asset: unit._id, uploadedBy: ctx.actor._id, purpose: "asset_document", name: upload.name, type: upload.mimeType, bytes: upload.buffer });
      await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: idString(ctx.company), actionLabel: "attach private asset documents" });
      try { await mongoose.connection.transaction(async (session) => {
        const retry = await original(ctx, requestId, requestHash, session); if (retry) { resultId = retry.document; replayed = true; return; }
        await asset(ctx, idString(unit), session); await fence(ctx, unit._id, session);
        const latest = action === "replaced" ? await document(ctx, unit._id, req.params.documentId, session) : null;
        if (latest && latest.revision !== currentRevision) throw generateError("Document changed during upload. Reload before continuing.", 409);
        await assertUploadCapacity(ctx, unit._id, latest, sha256, session);
        const before = latest ? assetDocumentDto(ctx, latest) : null, file = fileSnapshot(staged), version = latest ? latest.currentVersion + 1 : 1;
        await attachPrivateStoredFile(staged, session);
        let row: any;
        if (!latest) row = (await Document.create([{ company: ctx.company, asset: unit._id, ...metadata, currentFile: file, currentVersion: version, createdBy: ctx.actor._id, creatorName: ctx.actor.name || "Document manager", updatedByName: ctx.actor.name || "Document manager" }], { session }))[0].toObject();
        else row = await Document.findOneAndUpdate({ _id: latest._id, company: ctx.company, asset: unit._id, revision: currentRevision, state: "active" }, { $set: { ...metadata, currentFile: file, currentVersion: version, updatedByName: ctx.actor.name || "Document manager" }, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
        if (!row) throw generateError("Document changed during replacement. Reload before continuing.", 409);
        await Version.create([{ company: ctx.company, asset: unit._id, document: row._id, version, ...metadata, file, uploadedBy: ctx.actor._id, uploaderName: ctx.actor.name || "Document manager", reason }], { session });
        await audit(ctx, row, action, reason, requestId, requestHash, before, session); resultId = row._id;
      }, { readConcern: { level: "snapshot" } }); } catch (error: any) {
        if (error.code !== 11000) throw error;
        const retry = await original(ctx, requestId, requestHash); if (!retry) throw generateError("Document, file content or capacity changed concurrently. Reload before retrying.", 409); resultId = retry.document; replayed = true;
      }
    }
    const row = await document(ctx, unit._id, idString(resultId));
    res.status(action === "uploaded" && !replayed ? 201 : 200).json({ success: true, data: assetDocumentDto(ctx, row, await capacity(ctx, unit._id)), replayed });
  } catch (error) { next(error); }
  finally { if (staged) await queuePrivateStoredFileCleanup(staged._id).catch(() => console.warn("Unattached asset upload cleanup is pending.")); }
};
export const mutateAssetDocument = (action: "updated" | "archived" | "restored") => async (req: any, res: any, next: any) => {
  try {
    const ctx = await manager(req), unit = await asset(ctx, req.params.assetId), target = objectId(req.params.documentId, "asset document id"), body = req.body || {}, requestId = privateUploadRequestId(body.requestId);
    if (action === "archived" && body.confirmArchive !== true) throw generateError("Confirm archive retains file versions and is not physical erasure", 422);
    const input = { action, asset: idString(unit), document: idString(target), revision: revision(body.revision), reason: text(body.reason, "Document change reason", 3, 1000), ...(action === "updated" ? assetDocumentMetadata(body) : {}), ...(action === "archived" ? { confirmArchive: true } : {}) }, requestHash = digest(input);
    let replayed = false;
    try { await mongoose.connection.transaction(async (session) => {
      if (await original(ctx, requestId, requestHash, session)) { replayed = true; return; }
      await fence(ctx, unit._id, session); const row = await document(ctx, unit._id, idString(target), session);
      if (row.revision !== input.revision) throw generateError("Document changed. Reload before saving.", 409);
      if (action === "restored" ? row.state !== "archived" : row.state !== "active") throw generateError("Restore archived documents before changing them, or choose a valid transition", 409);
      const before = assetDocumentDto(ctx, row); let changes: any;
      if (action === "updated") { assertAssetDocumentKind(input.kind!, row.currentFile.type); changes = { title: input.title, kind: input.kind }; }
      else if (action === "archived") changes = { state: "archived", archivedAt: new Date(), archiverName: ctx.actor.name || "Document manager", archiveReason: input.reason };
      else {
        const counts = await capacity(ctx, unit._id, session);
        if (counts.active >= LIMITS.active || await Document.exists({ company: ctx.company, asset: unit._id, state: "active", "currentFile.sha256": row.currentFile.sha256 }).session(session)) throw generateError("Active document limit reached or the same file is already active. Archive the other entry before restoring.", 409);
        changes = { state: "active", archivedAt: null, archiverName: "", archiveReason: "" };
      }
      const saved: any = await Document.findOneAndUpdate({ _id: target, company: ctx.company, asset: unit._id, revision: input.revision, state: row.state }, { $set: { ...changes, updatedByName: ctx.actor.name || "Document manager" }, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
      if (!saved) throw generateError("Document changed during this action. Reload before continuing.", 409);
      await audit(ctx, saved, action, input.reason, requestId, requestHash, before, session);
    }, { readConcern: { level: "snapshot" } }); } catch (error: any) { if (error.code !== 11000) throw error; if (!await original(ctx, requestId, requestHash)) throw generateError("Document changed concurrently. Reload before continuing.", 409); replayed = true; }
    res.json({ success: true, data: assetDocumentDto(ctx, await document(ctx, unit._id, idString(target)), await capacity(ctx, unit._id)), replayed });
  } catch (error) { next(error); }
};
export const downloadAssetDocumentVersion = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "view"), unit = await asset(ctx, req.params.assetId), row = await document(ctx, unit._id, req.params.documentId), number = req.params.versionNumber;
    if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) throw generateError("Invalid document version number", 400);
    const version: any = await Version.findOne({ company: ctx.company, asset: unit._id, document: row._id, version: Number(number) }).lean();
    if (!version) throw generateError("Document version not found", 404);
    const file: any = await File.findOne({ _id: version.file.privateFile, company: ctx.company, asset: unit._id, purpose: "asset_document", storageStatus: "attached", sha256: version.file.sha256, type: version.file.type, size: version.file.size }).select("+bytes").lean();
    if (!file) throw generateError("Document version not found", 404);
    sendPrivateFile(res, file, await privateStoredFileBytes(file));
  } catch (error) { next(error); }
};
