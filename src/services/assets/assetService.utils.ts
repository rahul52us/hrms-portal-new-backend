import { generateError } from "../../config/Error/functions";
import { SERVICE_CURRENCIES } from "../../schemas/Assets/AssetServiceOrder.schema";
import { AssetContext, canManageAssets, idString } from "./asset.utils";

/** Money is an optional integer in minor units, not a floating-point payroll or payment instruction. */
export function serviceCost(value: any, currency: any) {
  if (!SERVICE_CURRENCIES.includes(currency)) throw generateError("Choose a supported service-cost currency", 422);
  if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 1000000000000)) throw generateError("Service cost must be a non-negative integer in minor units, or null when unknown", 422);
  return { actualCostMinor: value, currency };
}
export function serviceDto(ctx: AssetContext, order: any, asset?: any) {
  const active = Boolean(order.active && asset && idString(asset.openService) === idString(order) && !asset.currentAssignment && !asset.openWriteOff && !asset.writtenOffRecord && asset.status === "maintenance");
  const manage = canManageAssets(ctx) && active;
  const { _id, asset: assetId, reference, assetSnapshot, incident, incidentReference, kind, issueDescription, providerType, providerName, providerReference, expectedCompletionDate, status, revision, cycle,
    externalDispatched, dispatchedAt, dispatcherName, receivedAt, receiverName, startedAt, starterName, workCompletedAt, workCompletedName, workPerformed, actualCostMinor, currency,
    inspectedAt, inspectorName, inspectionResult, inspectionCondition, inspectionReason, closedAt, closerName, closeReason, creatorName, createdAt } = order;
  return { _id, asset: assetId, reference, assetSnapshot, incident, incidentReference, kind, issueDescription, providerType, providerName, providerReference, expectedCompletionDate, status, active: order.active, revision, cycle,
    externalDispatched, dispatchedAt, dispatcherName, receivedAt, receiverName, startedAt, starterName, workCompletedAt, workCompletedName, workPerformed, actualCostMinor, currency,
    inspectedAt, inspectorName, inspectionResult, inspectionCondition, inspectionReason, closedAt, closerName, closeReason, creatorName, createdAt,
    writeOffRecord: order.writeOffRecord || null, recoveredAfterWriteOffAt: order.recoveredAfterWriteOffAt || null,
    ...(asset ? { assetRevision: asset.revision, openIncident: order.active ? asset.openIncident || null : null, openWriteOff: order.active && idString(asset.openService) === idString(order) ? asset.openWriteOff || null : null, assetStatus: asset.status } : {}),
    canStart: Boolean(manage && status === "open" && !externalDispatched), canCompleteWork: Boolean(manage && status === "in_progress"),
    canReceiveUnrepaired: Boolean(manage && status === "in_progress" && providerType === "external" && externalDispatched),
    canInspect: Boolean(manage && status === "awaiting_inspection" && !externalDispatched), canCancel: Boolean(manage && status === "open" && !externalDispatched), canAddNote: Boolean(manage) };
}
