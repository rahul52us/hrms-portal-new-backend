import cron from "node-cron";
import mongoose from "mongoose";
import { Asset } from "../../schemas/Assets/Asset.schema";
import { AssetPurchase as Purchase } from "../../schemas/Assets/AssetLifecycle.schema";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import Notification from "../../schemas/Notification/notification.schema";
import { attachEffectivePermissions } from "../permissions/permission.utils";
import { upsertRequestNotifications } from "../notification/notification.service";
import { canManageAssets, idString } from "./asset.utils";
import { utcAssetDay } from "./assetLifecycle.utils";

/** Notify the current profile maintainer and authorized company Admin/HR Admin accounts, never the employee roster. */
export async function runAssetWarrantyReminders(companyId?: any, maximum = 500) {
  for (const model of [Purchase, Notification]) await model.init();
  const day = utcAssetDay(), horizon = utcAssetDay(new Date(Date.now() + 90 * 86400000)); let after: any = null, checked = 0, notices = 0;
  while (checked < maximum) {
    const match = { ...(companyId ? { company: companyId } : { noRecipientDay: { $ne: day } }), remindersEnabled: true, warrantyEnd: { $gt: "", $lte: horizon }, ...(after ? { _id: { $gt: after } } : {}), $or: [{ warrantyEnd: { $lt: day }, $expr: { $ne: ["$expiredNoticeKey", "$noticeKey"] } }, { warrantyEnd: { $gte: day }, $expr: { $and: [{ $ne: ["$soonNoticeKey", "$noticeKey"] }, { $lte: [{ $subtract: [{ $dateFromString: { dateString: "$warrantyEnd", onError: null, onNull: null } }, new Date(`${day}T00:00:00Z`)] }, { $multiply: ["$reminderDays", 86400000] }] }] } }] };
    // Filter inactive tenants before the bound so they cannot starve due reminders in later companies.
    const rows: any[] = await Purchase.aggregate([{ $match: match }, { $lookup: { from: Company.collection.name, localField: "company", foreignField: "_id", pipeline: [{ $match: { is_active: true, deletedAt: null } }, { $project: { _id: 1 } }], as: "tenant" } }, { $unwind: "$tenant" }, { $sort: { _id: 1 } }, { $limit: Math.min(100, maximum - checked) }]);
    if (!rows.length) break;
    for (const row of rows) {
      checked++; after = row._id;
      const expired = row.warrantyEnd < day, distance = Math.round((Date.parse(`${row.warrantyEnd}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
      if (!expired && distance > row.reminderDays) continue;
      let sent = false;
      await mongoose.connection.transaction(async session => {
        sent = false;
        const company: any = await Company.findOne({ _id: row.company, is_active: true, deletedAt: null }).select("rolePermissions").session(session).lean(); if (!company) return;
        const asset: any = await Asset.findOne({ _id: row.asset, company: row.company }).select("name tag status").session(session).lean(); if (!asset) return;
        const field = expired ? "expiredNoticeKey" : "soonNoticeKey";
        const owner: any = asset.status === "disposed" ? null : await User.findOne({ _id: row.updatedBy, company: row.company, deletedAt: null, is_enabled: true }).select("role accessRole permissions company").session(session).lean();
        const admins: any[] = asset.status === "disposed" ? [] : await User.find({ _id: { $ne: row.updatedBy }, company: row.company, deletedAt: null, is_enabled: true, role: { $in: ["admin", "hradmin"] } }).select("role accessRole permissions company").sort({ _id: 1 }).limit(49).session(session).lean();
        const people: any[] = [...(owner ? [owner] : []), ...admins];
        const recipients = people.filter(person => canManageAssets({ actor: attachEffectivePermissions({ user: person, company }), company: row.company })).map(person => person._id);
        if (!recipients.length && asset.status !== "disposed") { await Purchase.updateOne({ _id: row._id, revision: row.revision }, { $set: { noRecipientDay: day } }, { session, timestamps: false }); return; }
        const changed = await Purchase.updateOne({ _id: row._id, company: row.company, revision: row.revision, noticeKey: row.noticeKey, [field]: { $ne: row.noticeKey } }, { $set: { [field]: row.noticeKey } }, { session, timestamps: false }); if (!changed.matchedCount) return;
        if (!recipients.length) return;
        await upsertRequestNotifications({ company: row.company, recipients, entityType: "asset_warranty", entityId: row.asset, eventType: expired ? "assets.warranty_expired" : "assets.warranty_expiring", title: expired ? "Asset warranty expired" : "Asset warranty is expiring", message: `${asset.tag}: ${asset.name}. Warranty valid through ${row.warrantyEnd}.`, actionUrl: `/dashboard/assets?assetId=${row.asset}&assetTab=purchase`, category: "system", priority: expired ? "high" : "medium", dedupeEventKey: `warranty:${row.asset}:${row.noticeKey}:${expired ? "expired" : "soon"}` }, session); sent = true;
      });
      if (sent) notices++;
    }
  }
  return { checked, notices };
}
let started = false, running = false;
export function startAssetWarrantyWorker() {
  if (started || process.env.NODE_ENV === "test" || process.env.ASSET_WARRANTY_REMINDERS_ENABLED === "false") return false;
  started = true; cron.schedule("15 * * * *", () => { if (running) return; running = true; void runAssetWarrantyReminders().catch(() => console.error("Asset warranty reminders need attention")).finally(() => { running = false; }); }, { timezone: "UTC" }); return true;
}
