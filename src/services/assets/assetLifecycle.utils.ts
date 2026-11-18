import { createHash } from "crypto";
import { generateError } from "../../config/Error/functions";
import { ASSET_CURRENCIES } from "../../schemas/Assets/Asset.schema";
import { DISPOSAL_METHODS } from "../../schemas/Assets/AssetLifecycle.schema";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { AssetContext, canManageAssets, expectedReturnDate, idString, text } from "./asset.utils";

export const lifecycleHash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
export const utcAssetDay = (date = new Date()) => date.toISOString().slice(0, 10);
export function minorAmount(value: unknown, currency: unknown, optional = false) {
  if (!ASSET_CURRENCIES.includes(currency as any) || !(optional && value === null) && (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1000000000000)) throw generateError("Use a supported currency and a nonnegative integer minor-unit amount, or null for an unknown purchase cost", 422);
  return value as number | null;
}
export function purchaseInput(body: any) {
  if (typeof body.remindersEnabled !== "boolean" || !Number.isSafeInteger(body.reminderDays) || body.reminderDays < 0 || body.reminderDays > 90) throw generateError("Set warranty reminders and a lead time of 0-90 days", 422);
  const warrantyStart = expectedReturnDate(body.warrantyStart, "Warranty start"), warrantyEnd = expectedReturnDate(body.warrantyEnd, "Warranty end");
  if (warrantyStart && warrantyEnd && warrantyStart > warrantyEnd) throw generateError("Warranty end cannot be before warranty start", 422);
  return { vendor: text(body.vendor ?? "", "Vendor", 0, 200), invoiceReference: text(body.invoiceReference ?? "", "Invoice reference", 0, 150), purchaseDate: expectedReturnDate(body.purchaseDate, "Purchase date"), costMinor: minorAmount(body.costMinor ?? null, body.currency, true), currency: body.currency,
    warrantyStart, warrantyEnd, warrantyNotes: text(body.warrantyNotes ?? "", "Warranty notes", 0, 2000), remindersEnabled: body.remindersEnabled, reminderDays: body.reminderDays };
}
export function warrantyState(row: any, day = utcAssetDay()) {
  if (!row?.warrantyEnd) return { status: "not_recorded", daysRemaining: null };
  const daysRemaining = Math.round((Date.parse(`${row.warrantyEnd}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
  return { status: row.warrantyStart && row.warrantyStart > day ? "not_started" : daysRemaining < 0 ? "expired" : daysRemaining <= row.reminderDays ? "expiring" : "active", daysRemaining };
}
export function purchaseDto(row: any) {
  if (!row) return { revision: 0, vendor: "", invoiceReference: "", purchaseDate: "", costMinor: null, currency: "INR", warrantyStart: "", warrantyEnd: "", warrantyNotes: "", remindersEnabled: true, reminderDays: 30, warranty: warrantyState(null) };
  const { revision, vendor, invoiceReference, purchaseDate, costMinor, currency, warrantyStart, warrantyEnd, warrantyNotes, remindersEnabled, reminderDays, updaterName, updatedAt } = row;
  return { revision, vendor, invoiceReference, purchaseDate, costMinor, currency, warrantyStart, warrantyEnd, warrantyNotes, remindersEnabled, reminderDays, updaterName, updatedAt, warranty: warrantyState(row) };
}
export const canApproveDisposal = (ctx: AssetContext) => canManageAssets(ctx) && hasPermission(ctx.actor, PERMISSION_KEYS.APPROVE_ASSET_DISPOSALS);
export function disposalTerms(body: any) {
  if (!DISPOSAL_METHODS.includes(body.method)) throw generateError("Choose sale, scrap or donation", 422);
  const proceedsMinor = minorAmount(body.proceedsMinor, body.currency)!;
  if (body.method === "sale" && proceedsMinor < 1 || body.method === "donation" && proceedsMinor !== 0) throw generateError("Sale proceeds must be positive; donations have zero proceeds", 422);
  return { method: body.method, recipient: text(body.recipient, "Buyer / recycler / recipient", 2, 200), proceedsMinor, currency: body.currency };
}
export function disposalDto(ctx: AssetContext, row: any, asset?: any) {
  const manageable = canManageAssets(ctx), held = asset?.status === "retired" && idString(asset.openDisposal) === idString(row) && !asset.currentAssignment && !asset.openIncident && !asset.openService && !asset.openWriteOff && !asset.writtenOffRecord && !asset.disposedRecord;
  const linked = asset && idString(asset.openDisposal) === idString(row);
  const independent = canApproveDisposal(ctx) && idString(row.requestedBy) !== idString(ctx.actor);
  const { _id, asset: assetId, reference, assetSnapshot, purchaseSnapshot, method, recipient, proceedsMinor, currency, reason, requesterName, status, revision, createdAt, deciderName, decidedAt, decisionReason, completerName, completedAt, evidenceReference, completionReason, completionChecks, withdrawnByName, withdrawnAt, withdrawalReason } = row;
  return { _id, asset: assetId, reference, assetSnapshot, purchaseSnapshot, method, recipient, proceedsMinor, currency, reason, requesterName, status, revision, createdAt, deciderName, decidedAt, decisionReason, completerName, completedAt, evidenceReference, completionReason, completionChecks, withdrawnByName, withdrawnAt, withdrawalReason,
    ...(asset ? { assetRevision: asset.revision } : {}), canApprove: Boolean(held && independent && status === "pending"), canReject: Boolean(linked && independent && status === "pending"), canWithdraw: Boolean(linked && manageable && ["pending", "approved"].includes(status) && (idString(row.requestedBy) === idString(ctx.actor) || canApproveDisposal(ctx))), canComplete: Boolean(held && manageable && status === "approved") };
}
