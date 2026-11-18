import { randomUUID } from "crypto";
import mongoose from "mongoose";
import { Asset, AssetAssignment as Assignment, AssetAudit as Audit } from "../../schemas/Assets/Asset.schema";
import { AssetDisposal as Disposal, AssetDisposalEvent as Event, AssetPurchase as Purchase, DISPOSAL_STATES } from "../../schemas/Assets/AssetLifecycle.schema";
import { AssetIncident as Incident } from "../../schemas/Assets/AssetIncident.schema";
import { AssetServiceOrder as Service } from "../../schemas/Assets/AssetServiceOrder.schema";
import { AssetWriteOff as WriteOff } from "../../schemas/Assets/AssetWriteOff.schema";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import Notification from "../../schemas/Notification/notification.schema";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { attachEffectivePermissions, ensurePermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { upsertRequestNotifications } from "../notification/notification.service";
import { assetContext, AssetContext, assetDto, idString, objectId, pagination, revision, searchRegex, text } from "./asset.utils";
import { canApproveDisposal, disposalDto, disposalTerms, lifecycleHash, purchaseDto } from "./assetLifecycle.utils";
import { exportKey } from "./assetExport.utils";

async function record(ctx: AssetContext, value: string, session?: mongoose.ClientSession) { const row: any = await Disposal.findOne({ _id: objectId(value, "disposal id"), company: ctx.company }).session(session || null).lean(); if (!row) throw generateError("Disposal request not found", 404); return row; }
async function current(ctx: AssetContext, value: string) { const row = await record(ctx, value), asset = await Asset.findOne({ _id: row.asset, company: ctx.company }).lean(); return disposalDto(ctx, row, asset); }
/** Never turn retirement, orphaned custody or loss into a fabricated physical disposal. */
async function companyCustody(ctx: AssetContext, asset: any, session: mongoose.ClientSession, request?: any) {
  if (asset.status !== "retired" || asset.currentAssignment || asset.holder || asset.openIncident || asset.openService || asset.openWriteOff || asset.writtenOffRecord || asset.disposedRecord || (request ? idString(asset.openDisposal) !== idString(request) : asset.openDisposal)) throw generateError("Use a retired unit in company custody without open incident, service, loss or disposal holds", 409);
  if (await Assignment.exists({ company: ctx.company, asset: asset._id, active: true }).session(session) || await Service.exists({ company: ctx.company, asset: asset._id, active: true }).session(session) || await Incident.exists({ company: ctx.company, asset: asset._id, active: true }).session(session) || await WriteOff.exists({ company: ctx.company, asset: asset._id, status: "pending" }).session(session)) throw generateError("Reconcile unexpected active custody, service or investigation records before disposal", 409);
}
async function notify(ctx: AssetContext, row: any, action: string, session: mongoose.ClientSession) {
  const company: any = await Company.findById(ctx.company).select("rolePermissions").session(session).lean();
  const roles = ["admin", "hradmin", ...Object.entries(company?.rolePermissions || {}).filter(([, value]: any) => value?.approve_asset_disposals === true).map(([key]) => key)];
  const people = await User.find({ company: ctx.company, deletedAt: null, is_enabled: true, ...(action === "created" ? { $or: [{ role: { $in: roles } }, { accessRole: { $in: roles } }, { "permissions.approve_asset_disposals": true }] } : { _id: row.requestedBy }) }).select("role accessRole permissions company").sort({ _id: 1 }).limit(50).session(session).lean();
  const recipients = people.filter(person => { const actor = attachEffectivePermissions({ user: person, company }); return action === "created" ? idString(person) !== idString(row.requestedBy) && canApproveDisposal({ actor, company: ctx.company }) : actor.effectivePermissions?.view_assets; }).map(person => person._id);
  await upsertRequestNotifications({ company: ctx.company, actor: ctx.actor._id, recipients, entityType: "asset_disposal", entityId: row._id, eventType: `assets.disposal_${action}`, title: action === "created" ? "Asset disposal needs independent approval" : "Asset disposal updated", message: `${row.reference}: ${row.assetSnapshot.tag} - ${row.status}.`, category: "system", priority: action === "created" ? "high" : "medium", actionUrl: `/dashboard/assets?disposalId=${row._id}`, dedupeEventKey: `disposal:${action}:${row.revision}` }, session);
}
export const listAssetDisposals = async (req: any, res: any, next: any) => {
  try { const ctx = assetContext(req, "view"), { page, limit, skip } = pagination(req.query), status = req.query.status || "all", search = searchRegex(req.query.search); if (status !== "all" && !DISPOSAL_STATES.includes(status)) throw generateError("Invalid disposal status", 400);
    const match = { company: ctx.company, ...(status === "all" ? {} : { status }), ...(req.query.assetId ? { asset: objectId(req.query.assetId, "asset id") } : {}), ...(search ? { $or: [{ reference: search }, { "assetSnapshot.tag": search }, { "assetSnapshot.name": search }, { recipient: search }] } : {}) };
    const rows = await Disposal.find(match).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Disposal.countDocuments(match); res.json({ success: true, data: rows.map(row => disposalDto(ctx, row)), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const getAssetDisposal = async (req: any, res: any, next: any) => { try { res.json({ success: true, data: await current(assetContext(req, "view"), req.params.disposalId) }); } catch (error) { next(error); } };
export const assetDisposalHistory = async (req: any, res: any, next: any) => {
  try { const ctx = assetContext(req, "view"), row = await record(ctx, req.params.disposalId), { page, limit, skip } = pagination(req.query), match = { company: ctx.company, disposal: row._id }; const data = await Event.find(match).select("actorName action reason before after createdAt").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Event.countDocuments(match); res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } }); } catch (error) { next(error); }
};
type Action = "created" | "approve" | "reject" | "withdraw" | "complete";
export const mutateAssetDisposal = (action: Action) => async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "manage"), body = req.body || {};
    if (["approve", "reject"].includes(action)) ensurePermission(ctx.actor, PERMISSION_KEYS.APPROVE_ASSET_DISPOSALS);
    await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: idString(ctx.company), actionLabel: "manage physical asset disposal" });
    for (const model of [Asset, Assignment, Audit, Purchase, Disposal, Event, Incident, Service, WriteOff, Notification]) await model.init();
    if (action !== "created" && ["method", "recipient", "proceedsMinor", "currency", "assetId", "status", "completedAt", "purchaseSnapshot"].some(field => body[field] !== undefined)) throw generateError("Approved disposal terms and source snapshots cannot be changed. Withdraw and submit a new proposal.", 422);
    const input: any = { action, target: idString(objectId(action === "created" ? body.assetId : req.params.disposalId, action === "created" ? "asset id" : "disposal id")), assetRevision: revision(body.assetRevision), ...(action !== "created" ? { revision: revision(body.revision) } : {}), reason: text(body.reason, "Disposal reason", action === "created" ? 10 : 3, action === "created" ? 2000 : 1000) };
    if (action === "created") { if (body.confirmCompanyCustody !== true) throw generateError("Confirm the retired unit is physically held by the company", 422); Object.assign(input, disposalTerms(body), { confirmCompanyCustody: true }); }
    if (action === "approve") { if (body.confirmTerms !== true) throw generateError("Confirm the recipient, method and agreed proceeds before approving", 422); input.confirmTerms = true; }
    if (action === "complete") { if (body.confirmPhysicalTransfer !== true || body.confirmDataCleared !== true || body.confirmTerms !== true) throw generateError("Confirm physical transfer, data sanitization and unchanged approved terms", 422); Object.assign(input, { confirmPhysicalTransfer: true, confirmDataCleared: true, confirmTerms: true, evidenceReference: text(body.evidenceReference, "Disposal certificate / receipt reference", 3, 200) }); }
    const key = exportKey(body.requestId), hash = lifecycleHash(input); let resultId: any, replayed = false;
    const original = async (session?: mongoose.ClientSession) => { const prior: any = await Event.findOne({ company: ctx.company, actor: ctx.actor._id, requestId: key }).select("+requestHash").session(session || null).lean(); if (prior && prior.requestHash !== hash) throw generateError("Request id already used for another disposal operation", 409); return prior; };
    try { await mongoose.connection.transaction(async session => {
      const prior = await original(session); if (prior) { resultId = prior.disposal; replayed = true; return; }
      let row: any = action === "created" ? null : await record(ctx, input.target, session);
      const asset: any = await Asset.findOne({ _id: row?.asset || input.target, company: ctx.company }).session(session).lean(); if (!asset) throw generateError("Asset not found", 404);
      if (asset.revision !== input.assetRevision || row && row.revision !== input.revision) throw generateError("Asset or disposal changed. Reload both before continuing.", 409);
      const before = row ? disposalDto(ctx, row, asset) : null; let changes: any = {}, assetChanges: any;
      if (action === "created") {
        await companyCustody(ctx, asset, session);
        const purchase = await Purchase.findOne({ company: ctx.company, asset: asset._id }).session(session).lean();
        row = (await Disposal.create([{ company: ctx.company, asset: asset._id, reference: `DSP-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`, assetSnapshot: { tag: asset.tag, name: asset.name, serialNumber: asset.serialNumber, condition: asset.condition }, purchaseSnapshot: purchase ? purchaseDto(purchase) : null, method: input.method, recipient: input.recipient, proceedsMinor: input.proceedsMinor, currency: input.currency, reason: input.reason, requestedBy: ctx.actor._id, requesterName: ctx.actor.name || "Asset manager" }], { session }))[0].toObject();
        assetChanges = { openDisposal: row._id, lastDisposal: row._id };
      } else {
        const caps = disposalDto(ctx, row, asset), capability = action === "approve" ? caps.canApprove : action === "reject" ? caps.canReject : action === "withdraw" ? caps.canWithdraw : caps.canComplete;
        if (["approve", "reject"].includes(action) && idString(row.requestedBy) === idString(ctx.actor)) throw generateError("A different authorized approver must decide your disposal request", 403);
        if (!capability) throw generateError("This disposal action is not allowed in the current state", 409);
        if (["approve", "complete"].includes(action)) await companyCustody(ctx, asset, session, row);
        if (action === "approve" || action === "reject") changes = { status: action === "approve" ? "approved" : "rejected", active: action === "approve", decidedBy: ctx.actor._id, deciderName: ctx.actor.name || "Disposal approver", decidedAt: new Date(), decisionReason: input.reason };
        if (action === "withdraw") changes = { status: "withdrawn", active: false, withdrawnByName: ctx.actor.name || "Asset manager", withdrawnAt: new Date(), withdrawalReason: input.reason };
        if (action === "complete") changes = { status: "completed", active: false, completedBy: ctx.actor._id, completerName: ctx.actor.name || "Asset manager", completedAt: new Date(), evidenceReference: input.evidenceReference, completionReason: input.reason, completionChecks: { physicalTransfer: true, dataCleared: true, approvedTerms: true } };
        assetChanges = action === "complete" ? { status: "disposed", openDisposal: null, disposedRecord: row._id, lastDisposal: row._id } : action === "approve" ? { openDisposal: row._id } : { openDisposal: null, lastDisposal: row._id };
        row = await Disposal.findOneAndUpdate({ _id: row._id, company: ctx.company, revision: input.revision, active: true }, { $set: changes, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean(); if (!row) throw generateError("Disposal changed during this action", 409);
      }
      const savedAsset = await Asset.findOneAndUpdate({ _id: asset._id, company: ctx.company, revision: input.assetRevision, ...(action === "created" ? { openDisposal: null, status: "retired" } : { openDisposal: row._id }) }, { $set: { ...assetChanges, updatedBy: ctx.actor._id }, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
      if (!savedAsset) throw generateError("Inventory changed during disposal; no partial transition was saved", 409);
      const eventId = new mongoose.Types.ObjectId(), after = disposalDto(ctx, row, savedAsset);
      await Event.create([{ _id: eventId, company: ctx.company, disposal: row._id, asset: asset._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", action, reason: input.reason, requestId: key, requestHash: hash, before, after }], { session });
      await Audit.create([{ company: ctx.company, asset: asset._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", action: `disposal_${action}`, reason: input.reason, requestId: `disposal-${eventId}`, requestHash: hash, before: { asset: assetDto(ctx, asset), disposal: before }, after: { asset: assetDto(ctx, savedAsset), disposal: after } }], { session });
      await notify(ctx, row, action, session); resultId = row._id;
    }); } catch (error: any) { if (error.code !== 11000) throw error; const prior = await original(); if (!prior) throw generateError("An active disposal or inventory change was saved concurrently. Reload before retrying.", 409); resultId = prior.disposal; replayed = true; }
    res.status(action === "created" && !replayed ? 201 : 200).json({ success: true, data: await current(ctx, idString(resultId)), replayed });
  } catch (error) { next(error); }
};
