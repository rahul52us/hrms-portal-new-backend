import mongoose from "mongoose";
import { Asset, AssetAudit as Audit } from "../../schemas/Assets/Asset.schema";
import { AssetPurchase as Purchase, AssetPurchaseEvent as Event } from "../../schemas/Assets/AssetLifecycle.schema";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { assetContext, AssetContext, canManageAssets, idString, objectId, pagination, searchRegex, text } from "./asset.utils";
import { lifecycleHash, purchaseDto, purchaseInput, utcAssetDay } from "./assetLifecycle.utils";
import { exportKey } from "./assetExport.utils";
import { runAssetWarrantyReminders } from "./assetWarranty.worker";

async function unit(ctx: AssetContext, id: string, session?: mongoose.ClientSession) { const row: any = await Asset.findOne({ _id: objectId(id, "asset id"), company: ctx.company }).select("_id status").session(session || null).lean(); if (!row) throw generateError("Asset not found", 404); return row; }
export const getAssetPurchase = async (req: any, res: any, next: any) => {
  try { const ctx = assetContext(req, "view"), asset = await unit(ctx, req.params.assetId), row = await Purchase.findOne({ company: ctx.company, asset: asset._id }).lean(); res.json({ success: true, data: purchaseDto(row), canManage: canManageAssets(ctx) }); } catch (error) { next(error); }
};
export const assetPurchaseHistory = async (req: any, res: any, next: any) => {
  try { const ctx = assetContext(req, "view"), asset = await unit(ctx, req.params.assetId), { page, limit, skip } = pagination(req.query), match = { company: ctx.company, asset: asset._id }; const data = await Event.find(match).select("actorName reason before after createdAt").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Event.countDocuments(match); res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } }); } catch (error) { next(error); }
};
export const saveAssetPurchase = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "manage"), body = req.body || {}, asset = await unit(ctx, req.params.assetId);
    await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: idString(ctx.company), actionLabel: "update asset purchase and warranty details" });
    for (const model of [Purchase, Event, Audit]) await model.init();
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw generateError("Load the current purchase/warranty revision first", 422);
    const input = { asset: idString(asset), revision: body.revision, ...purchaseInput(body), reason: text(body.reason, "Purchase/warranty change reason", 3, 1000) }, key = exportKey(body.requestId), hash = lifecycleHash(input); let replayed = false;
    const original = async (session?: mongoose.ClientSession) => { const event: any = await Event.findOne({ company: ctx.company, actor: ctx.actor._id, requestId: key }).select("+requestHash").session(session || null).lean(); if (event && event.requestHash !== hash) throw generateError("Request id already used for another purchase/warranty change", 409); return event; };
    try { await mongoose.connection.transaction(async session => {
      if (await original(session)) { replayed = true; return; }
      const current: any = await Purchase.findOne({ company: ctx.company, asset: asset._id }).session(session).lean();
      if ((current?.revision || 0) !== input.revision) throw generateError("Purchase/warranty details changed. Reload before saving.", 409);
      const { revision: _revision, asset: _asset, reason: _reason, ...content } = input, before = current ? purchaseDto(current) : null, noticeKey = lifecycleHash({ end: content.warrantyEnd, lead: content.reminderDays, enabled: content.remindersEnabled });
      let saved: any;
      if (!current) saved = (await Purchase.create([{ company: ctx.company, asset: asset._id, ...content, noticeKey, updatedBy: ctx.actor._id, updaterName: ctx.actor.name || "Asset manager" }], { session }))[0].toObject();
      else saved = await Purchase.findOneAndUpdate({ _id: current._id, company: ctx.company, revision: input.revision }, { $set: { ...content, noticeKey, noRecipientDay: "", updatedBy: ctx.actor._id, updaterName: ctx.actor.name || "Asset manager" }, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
      if (!saved) throw generateError("Purchase profile changed during save", 409);
      const eventId = new mongoose.Types.ObjectId(), after = purchaseDto(saved);
      await Event.create([{ _id: eventId, company: ctx.company, asset: asset._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", reason: input.reason, requestId: key, requestHash: hash, before, after }], { session });
      await Audit.create([{ company: ctx.company, asset: asset._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", action: "purchase_warranty_updated", reason: input.reason, requestId: `purchase-${eventId}`, requestHash: hash, before, after }], { session });
    }); } catch (error: any) { if (error.code !== 11000) throw error; if (!await original()) throw generateError("Purchase profile changed concurrently. Reload before retrying.", 409); replayed = true; }
    res.json({ success: true, data: purchaseDto(await Purchase.findOne({ company: ctx.company, asset: asset._id }).lean()), canManage: true, replayed });
  } catch (error) { next(error); }
};
export const listAssetPurchases = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "view"), { page, limit, skip } = pagination(req.query), state = req.query.state || "all", search = searchRegex(req.query.search), day = utcAssetDay(), horizon = utcAssetDay(new Date(Date.now() + 30 * 86400000));
    if (!["all", "expiring", "expired", "not_recorded"].includes(state)) throw generateError("Invalid warranty filter", 400);
    const [result] = await Purchase.aggregate([{ $match: { company: ctx.company, ...(state === "expiring" ? { warrantyEnd: { $gte: day, $lte: horizon } } : state === "expired" ? { warrantyEnd: { $gt: "", $lt: day } } : state === "not_recorded" ? { warrantyEnd: "" } : {}) } },
      { $lookup: { from: Asset.collection.name, localField: "asset", foreignField: "_id", pipeline: [{ $match: { company: ctx.company } }, { $project: { name: 1, tag: 1, status: 1 } }], as: "unit" } }, { $unwind: "$unit" }, ...(search ? [{ $match: { $or: [{ vendor: search }, { invoiceReference: search }, { "unit.name": search }, { "unit.tag": search }] } }] : []),
      { $facet: { data: [{ $sort: { updatedAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit }, { $project: { noticeKey: 0, soonNoticeKey: 0, expiredNoticeKey: 0 } }], total: [{ $count: "value" }] } }]);
    const total = result?.total[0]?.value || 0; res.json({ success: true, data: (result?.data || []).map((row: any) => ({ ...purchaseDto(row), asset: row.unit })), canManage: canManageAssets(ctx), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const checkAssetWarrantyReminders = async (req: any, res: any, next: any) => { try { const ctx = assetContext(req, "manage"); await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: idString(ctx.company), actionLabel: "run asset warranty reminders" }); res.json({ success: true, data: await runAssetWarrantyReminders(ctx.company, 100) }); } catch (error) { next(error); } };
