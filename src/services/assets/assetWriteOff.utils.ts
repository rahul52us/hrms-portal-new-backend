import { generateError } from "../../config/Error/functions";
import { ASSET_CURRENCIES } from "../../schemas/Assets/Asset.schema";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { AssetContext, canManageAssets, idString } from "./asset.utils";

export const canApproveAssetLoss = (ctx: AssetContext) => canManageAssets(ctx) && hasPermission(ctx.actor, PERMISSION_KEYS.APPROVE_ASSET_WRITE_OFFS);
export function lossAmount(value: any, currency: any, receipt = false) {
  if (!ASSET_CURRENCIES.includes(currency) || (value === null ? receipt : !Number.isSafeInteger(value) || value < (receipt ? 1 : 0) || value > 1000000000000)) throw generateError("Choose a supported currency and integer minor-unit amount (loss value may be null; receipts must be positive)", 422);
  return value as number | null;
}
export function writeOffDto(ctx: AssetContext, record: any, asset?: any) {
  const independent = idString(ctx.actor) !== idString(record.employee), manage = canManageAssets(ctx) && independent, finance = canApproveAssetLoss(ctx) && independent;
  const pending = record.status === "pending" && asset && idString(asset.openWriteOff) === idString(record);
  const unchanged = pending && idString(asset.currentAssignment) === idString(record.assignment) && idString(asset.openService) === idString(record.serviceOrder) && idString(asset.openIncident) === idString(record.incident) && !asset.writtenOffRecord;
  const independentDecision = finance && idString(ctx.actor) !== idString(record.requestedBy);
  const settled = ["approved", "recovered"].includes(record.status);
  const { _id, asset: assetId, incident, assignment, serviceOrder, reference, incidentReference, assetSnapshot, employeeName, employeeCode, lastKnownCustody, providerName, kind, reason, evidenceReference, amountMinor, currency, recoveredAmountMinor, requesterName, status, revision, createdAt, deciderName, decidedAt, decisionReason, recovererName, recoveredAt, recoveredCondition, recoveryReason } = record;
  return { _id, asset: assetId, incident, assignment, serviceOrder, reference, incidentReference, assetSnapshot, employeeName, employeeCode, lastKnownCustody, providerName, kind, reason, evidenceReference, amountMinor, currency, recoveredAmountMinor, requesterName, status, revision, createdAt, deciderName, decidedAt, decisionReason, recovererName, recoveredAt, recoveredCondition, recoveryReason,
    outstandingAmountMinor: amountMinor === null ? null : Math.max(0, amountMinor - recoveredAmountMinor), excessRecoveryMinor: amountMinor === null ? null : Math.max(0, recoveredAmountMinor - amountMinor),
    ...(asset ? { assetRevision: asset.revision } : {}), approvalBlockedReason: pending && !unchanged ? "Custody or incident changed; withdraw and investigate again before requesting a new write-off." : "",
    canApprove: Boolean(unchanged && independentDecision), canReject: Boolean(pending && independentDecision), canWithdraw: Boolean(pending && manage && (idString(ctx.actor) === idString(record.requestedBy) || finance)),
    canRecoverUnit: Boolean(manage && record.status === "approved" && asset?.status === "written_off" && idString(asset.writtenOffRecord) === idString(record)), canRecordReceipt: Boolean(finance && settled) };
}
