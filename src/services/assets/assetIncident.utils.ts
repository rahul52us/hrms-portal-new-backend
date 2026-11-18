import { generateError } from "../../config/Error/functions";
import { AssetContext, canManageAssets, canViewAssets, idString } from "./asset.utils";

/** Require a real offset-qualified timestamp; native Date alone normalizes invalid dates such as February 30. */
export function incidentOccurredAt(value: any, now = new Date()) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw generateError("Provide an incident date/time with a timezone", 422);
  if (Number(value.slice(11, 13)) > 23 || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) throw generateError("Provide a valid incident date and time", 422);
  const result = new Date(value);
  if (result.getTime() > now.getTime() + 5 * 60000) throw generateError("An incident cannot be reported in the future", 422);
  return result;
}
export const canReadIncident = (ctx: AssetContext, incident: any) => canViewAssets(ctx) || [incident.employee, incident.reportedBy].some((id) => idString(id) === idString(ctx.actor));
/** Inventory management never permits an employee to clear the hold on their own custody. */
export function incidentDto(ctx: AssetContext, incident: any, asset?: any) {
  const live = incident.active && asset && idString(asset.openIncident) === idString(incident);
  const review = Boolean(live && canManageAssets(ctx) && idString(incident.employee) !== idString(ctx.actor));
  const { _id, asset: assetId, assignment, reference, assetSnapshot, employee, employeeName, employeeCode, reporterName, kind, occurredAt, description, status, active, revision, createdAt, reviewerName, reviewedAt, closerName, closedAt, resolutionReason, conditionAfter } = incident;
  return { _id, asset: assetId, assignment, reference, assetSnapshot, employee, employeeName, employeeCode, reporterName, kind, occurredAt, description, status, active, revision, createdAt,
    reviewerName, reviewedAt, closerName, closedAt, resolutionReason, conditionAfter, recoveredAfterWriteOffAt: incident.recoveredAfterWriteOffAt || null,
    canReview: review, canResolve: review && !asset?.openService && !asset?.openWriteOff, canDismiss: review && !asset?.openWriteOff,
    canRequestWriteOff: Boolean(review && status === "under_review" && !asset?.openWriteOff && !asset?.writtenOffRecord),
    ...(canViewAssets(ctx) && asset ? { assetRevision: asset.revision, assetStatus: asset.status, openService: live ? asset.openService || null : null, openWriteOff: live ? asset.openWriteOff || null : null, writeOffRecord: incident.writeOffRecord || null } : {}) };
}
