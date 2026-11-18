import { createHash, randomUUID } from "crypto";
import mongoose from "mongoose";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import { AssetExportEvent as Event } from "../../schemas/Assets/AssetExport.schema";
import { generateError } from "../../config/Error/functions";
import { attachEffectivePermissions } from "../permissions/permission.utils";
import { ACTIVE_USER_PASSWORD_MATCH } from "../auth/utils/userAccountStatus";
import { AssetContext, idString, inventoryMatch, text } from "./asset.utils";
import { canExportAssets } from "./assetTransfer.utils";

export const ASYNC_EXPORT_LIMITS = { rows: 100000, bytes: 128 * 1024 * 1024, daily: 5, attempts: 3, expiresHours: 24, chunkBytes: 512 * 1024 } as const;
export const exportHash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
export function exportKey(value: unknown) { const key = text(value, "Request id", 8, 100); if (!/^[A-Za-z0-9_-]+$/.test(key)) throw generateError("Invalid export request id", 422); return key; }
export function exportFilters(ctx: AssetContext, value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw generateError("Provide inventory filters", 422);
  inventoryMatch(ctx, value);
  return { search: value.search ? text(value.search, "Search", 1, 100) : "", status: value.status || "all", category: value.category || "all", officeLocation: value.officeLocation ? idString(inventoryMatch(ctx, value).officeLocation) : "" };
}
export function exportJobDto(row: any) {
  const { _id, state, filters, filterLabels, reason, requesterName, revision, attempts, rows, bytes, startedAt, completedAt, expiresAt, createdAt, updatedAt, error } = row;
  const expired = state === "ready" && (!expiresAt || new Date(expiresAt).getTime() <= Date.now());
  return { _id, state: expired ? "expired" : state, filters, filterLabels, reason, requesterName, revision, attempts, rows, bytes, startedAt, completedAt, expiresAt, createdAt, updatedAt, error,
    canCancel: ["queued", "running", "ready"].includes(state) && !expired, canRetry: state === "failed" && row.retryable && attempts < ASYNC_EXPORT_LIMITS.attempts, canDownload: state === "ready" && !expired };
}
/** A job must not keep a revoked delegated grant or a disabled employee alive in a background worker. */
export async function assertExportOwner(job: any) {
  const user: any = await User.findOne({ _id: job.requestedBy, company: job.company, is_enabled: true, deletedAt: null, password: ACTIVE_USER_PASSWORD_MATCH }).select("name role accessRole permissions company").lean();
  const company: any = await Company.findOne({ _id: job.company, is_active: true, deletedAt: null }).select("rolePermissions").lean();
  const ctx = { actor: attachEffectivePermissions({ user, company }), company: job.company };
  if (!user || !company || user.role === "superadmin" || !canExportAssets(ctx)) throw generateError("Export access is no longer available for the requesting account", 403);
  return ctx;
}
export async function exportEvent(job: any, action: string, reason: string, session: mongoose.ClientSession, actor?: any, requestId: string = randomUUID(), requestHash = exportHash({ action, requestId })) {
  await Event.create([{ company: job.company, job: job._id, actor: actor?._id || null, actorName: actor?.name || "Export worker", action, reason, requestId, requestHash, state: job.state, rows: job.rows || 0 }], { session });
}
