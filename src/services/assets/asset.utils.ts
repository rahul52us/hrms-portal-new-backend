import mongoose from "mongoose";
import { randomUUID } from "crypto";
import { generateError } from "../../config/Error/functions";
import { ASSET_CONDITIONS, ASSET_STATES } from "../../schemas/Assets/Asset.schema";
import { ASSET_CATEGORY_PATTERN, BUILTIN_ASSET_CATEGORIES } from "../../schemas/Assets/AssetCategory.schema";
import { getEmployeeRequestActor, resolveEmployeeRequestCompanyId } from "../leave/leaveAccess.utils";
import { ensurePermission, hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";

export const idString = (value: any) => String(value?._id || value || "");
export function objectId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(value);
}
export function text(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw generateError(`${label} must be ${min}-${max} characters`, 422);
  return value.trim();
}
export function revision(value: any) {
  if (!Number.isSafeInteger(value) || value < 1) throw generateError("Load the current asset or assignment revision first", 422);
  return value as number;
}
export function pagination(query: any) {
  const number = (value: any, fallback: number, max: number) => { const result = value === undefined ? fallback : Number(value); if (!Number.isSafeInteger(result) || result < 1 || result > max) throw generateError("Invalid asset pagination", 400); return result; };
  const page = number(query.page, 1, 10000), limit = number(query.limit, 20, 50);
  return { page, limit, skip: (page - 1) * limit };
}
export function searchRegex(value: any) {
  return value === undefined || value === "" ? null : new RegExp(text(value, "Search", 1, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}
export function expectedReturnDate(value: any, label = "Expected return") {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw generateError(`${label} must be a valid YYYY-MM-DD date`, 422);
  return value;
}
export const generatedTag = () => `AST-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
export function normalizedAsset(body: any) {
  const tag = text(body.tag ?? "", "Asset tag", 0, 40).toUpperCase();
  if (tag && !/^[A-Z0-9][A-Z0-9._/-]*$/.test(tag)) throw generateError("Asset tag may contain letters, numbers, dots, underscores, slashes and hyphens", 422);
  const category = text(body.category, "Asset category code", 1, 40).toLowerCase();
  if (!ASSET_CATEGORY_PATTERN.test(category)) throw generateError("Choose a valid asset category code", 422);
  if (!ASSET_CONDITIONS.includes(body.condition)) throw generateError("Choose an asset condition", 422);
  return { tag, name: text(body.name, "Asset name", 2, 150), category, condition: body.condition,
    brand: text(body.brand ?? "", "Brand", 0, 100), model: text(body.model ?? "", "Model", 0, 100), serialNumber: text(body.serialNumber ?? "", "Serial number", 0, 100),
    officeLocation: body.officeLocation ? objectId(body.officeLocation, "inventory location") : null, internalNotes: text(body.internalNotes ?? "", "Internal notes", 0, 2000) };
}
export function assetContext(req: any, access: "self" | "view" | "manage" = "self") {
  const actor = getEmployeeRequestActor(req);
  if (actor.role === "superadmin") throw generateError("Assets are managed from company accounts", 403);
  if (access !== "self") ensurePermission(actor, PERMISSION_KEYS.VIEW_ASSETS);
  if (access === "manage") ensurePermission(actor, PERMISSION_KEYS.MANAGE_ASSETS);
  return { actor, company: resolveEmployeeRequestCompanyId(actor, req.body?.companyId || req.query?.companyId, "assets") };
}
export type AssetContext = ReturnType<typeof assetContext>;
/** Inventory pages and exports share exactly the same validated company/filter boundary. */
export function inventoryMatch(ctx: AssetContext, query: any) {
  const search = searchRegex(query.search), status = query.status || "all", category = query.category || "all";
  if (status !== "all" && !ASSET_STATES.includes(status) || typeof category !== "string" || category !== "all" && !ASSET_CATEGORY_PATTERN.test(category)) throw generateError("Invalid asset filter", 400);
  return { company: ctx.company, ...(status === "all" ? {} : { status }), ...(category === "all" ? {} : { category }),
    ...(query.officeLocation ? { officeLocation: objectId(query.officeLocation, "inventory location") } : {}),
    ...(search ? { $or: [{ name: search }, { tag: search }, { serialNumber: search }, { "holder.name": search }, { "holder.code": search }] } : {}) };
}
export const canViewAssets = (ctx: AssetContext) => hasPermission(ctx.actor, PERMISSION_KEYS.VIEW_ASSETS);
export const canManageAssets = (ctx: AssetContext) => canViewAssets(ctx) && hasPermission(ctx.actor, PERMISSION_KEYS.MANAGE_ASSETS);
export function assetDto(ctx: AssetContext, asset: any) {
  const manageable = canManageAssets(ctx), free = !asset.currentAssignment && asset.status !== "issued" && !asset.openIncident && !asset.openService && !asset.openWriteOff && !asset.writtenOffRecord && !asset.openDisposal && !asset.disposedRecord;
  const { _id, tag, name, category, brand, model, serialNumber, officeLocation, locationName, condition, status, currentAssignment, openIncident, holder, internalNotes, revision, createdAt, updatedAt } = asset;
  return { _id, tag, name, category, categoryName: asset.categoryName || BUILTIN_ASSET_CATEGORIES[category] || category, brand, model, serialNumber, officeLocation, locationName, condition, status, currentAssignment, openIncident: openIncident || null, holder, internalNotes, revision, createdAt, updatedAt,
    openService: asset.openService || null, lastService: asset.lastService || null, maintenanceReleaseBlocked: asset.maintenanceReleaseBlocked || false, lastInspection: asset.lastInspection || null,
    openWriteOff: asset.openWriteOff || null, writtenOffRecord: asset.writtenOffRecord || null, lastWriteOff: asset.lastWriteOff || null,
    openDisposal: asset.openDisposal || null, disposedRecord: asset.disposedRecord || null, lastDisposal: asset.lastDisposal || null, canRequestDisposal: manageable && free && status === "retired",
    canOpenService: manageable && !currentAssignment && !asset.openService && !asset.openWriteOff && !asset.writtenOffRecord && !asset.openDisposal && !asset.disposedRecord && ["available", "maintenance"].includes(status),
    canReportIncident: manageable && !openIncident && !asset.openWriteOff && !asset.writtenOffRecord && !asset.openDisposal && !asset.disposedRecord && ["available", "maintenance", "issued"].includes(status),
    canEdit: manageable && free && ["available", "maintenance"].includes(status), canIssue: manageable && free && status === "available" && condition !== "damaged" && !asset.maintenanceReleaseBlocked,
    canMaintain: manageable && free && status === "available", canMakeAvailable: manageable && free && status === "maintenance" && !asset.maintenanceReleaseBlocked,
    canRetire: manageable && free && ["available", "maintenance"].includes(status), canRestore: manageable && free && status === "retired" };
}
/** Employee DTOs contain their own handover evidence only, never inventory's internal notes or other holders. */
export function assignmentDto(ctx: AssetContext, record: any, asset?: any) {
  const self = idString(record.employee) === idString(ctx.actor), active = record.active && !["returned", "voided", "written_off"].includes(record.status);
  const current = Boolean(asset && idString(asset.currentAssignment) === idString(record)), incident = current ? asset?.openIncident || null : null;
  const { _id, assetSnapshot, employee, employeeName, employeeCode, issuerName, issuedAt, conditionOut, handoverNotes, expectedReturnDate, status, acknowledgedAt, acknowledgementNote,
    returnRequestedAt, returnRequestReason, returnedAt, receiverName, conditionIn, returnNotes, voidedAt, voiderName, voidReason, revision } = record;
  return { _id, asset: record.asset, assetSnapshot, employee, employeeName, employeeCode, issuerName, issuedAt, conditionOut, handoverNotes, expectedReturnDate, status, active,
    acknowledgedAt, acknowledgementNote, returnRequestedAt, returnRequestReason, returnedAt, receiverName, conditionIn, returnNotes, voidedAt, voiderName, voidReason, revision,
    writtenOffAt: record.writtenOffAt || null, writtenOffByName: record.writtenOffByName || "", writtenOffReason: record.writtenOffReason || "", writtenOffRecoveredAt: record.writtenOffRecoveredAt || null,
    openIncident: incident, canReportIncident: Boolean((self || canManageAssets(ctx)) && active && current && !incident),
    canAcknowledge: self && active && status === "issued" && !acknowledgedAt, canRequestReturn: self && active && status === "issued",
    canReturn: canManageAssets(ctx) && !self && active && Boolean(asset && idString(asset.currentAssignment) === idString(record)),
    canVoid: canManageAssets(ctx) && !self && active && status === "issued" && !acknowledgedAt && current && !incident && !asset?.openWriteOff,
    ...(canViewAssets(ctx) && asset ? { assetRevision: asset.revision, officeLocation: asset.officeLocation, locationName: asset.locationName } : {}) };
}
