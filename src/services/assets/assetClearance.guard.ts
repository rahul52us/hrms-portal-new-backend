import mongoose from "mongoose";
import { AssetClearance as Clearance, AssetEmployeeControl as Control } from "../../schemas/Assets/AssetClearance.schema";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import { generateError } from "../../config/Error/functions";
import { attachEffectivePermissions, hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { upsertRequestNotifications } from "../notification/notification.service";
import { AssetContext, canManageAssets, idString } from "./asset.utils";

export const canManageClearances = (ctx: AssetContext) => canManageAssets(ctx) && hasPermission(ctx.actor, PERMISSION_KEYS.MANAGE_ASSET_CLEARANCES);
/** Every supported source change writes this same row, preventing phantom new issues during a zero-custody decision. */
export async function fenceAssetEmployee(company: any, employee: any, session: mongoose.ClientSession, issuing = false, sourceChange = true) {
  if (!employee) return null;
  const control: any = await Control.findOneAndUpdate({ company, employee }, { $inc: { revision: 1, ...(sourceChange ? { sourceRevision: 1 } : {}) }, $setOnInsert: { clearance: null, issueBlocked: false, ...(!sourceChange ? { sourceRevision: 0 } : {}) } }, { session, upsert: true, new: true, setDefaultsOnInsert: false }).lean();
  if (issuing && control.issueBlocked) throw generateError("New equipment cannot be issued while this employee has an active asset clearance. Cancel the clearance with an authorised operator if offboarding is no longer proceeding.", 409);
  return control;
}
/** Source notices ask HR to recheck; they never claim clearance has automatically been granted. */
export async function notifyClearanceChange(ctx: AssetContext, employee: any, action: string, eventKey: string, session: mongoose.ClientSession) {
  if (!employee) return;
  const control: any = await Control.findOne({ company: ctx.company, employee, issueBlocked: true }).session(session).lean();
  if (!control?.clearance) return;
  const clearance: any = await Clearance.findOne({ _id: control.clearance, company: ctx.company, employee, isCurrent: true }).session(session).lean();
  if (!clearance) return;
  const person: any = await User.findOne({ _id: clearance.createdBy, company: ctx.company, deletedAt: null, is_enabled: { $ne: false } }).select("_id role company permissions accessRole").session(session).lean();
  const company = await Company.findById(ctx.company).select("rolePermissions").session(session).lean();
  if (!person || !hasPermission(attachEffectivePermissions({ user: person, company }), PERMISSION_KEYS.VIEW_ASSETS)) return;
  await upsertRequestNotifications({ company: ctx.company, actor: ctx.actor._id, recipients: [person._id], entityType: "asset_clearance", entityId: clearance._id, eventType: "assets.clearance_source_updated", title: "Recheck employee asset clearance", message: `${clearance.employeeName}: ${action.replace(/_/g, " ")}. Review current custody and administrative checks before clearance.`, category: "system", priority: "medium", actionUrl: `/dashboard/assets?clearanceId=${idString(clearance)}`, dedupeEventKey: `clearance-source:${eventKey}` }, session);
}
