import { generateError } from "../../config/Error/functions";
import { idString, objectId } from "./asset.utils";

export const ASSET_LABEL_LIMIT = 100, ASSET_LABELS_PER_SHEET = 12;
export type AssetLabelOptions = { assetIds: string[]; layout: "a4" | "single"; startPosition: number };

/** The QR is an identifier, never a public URL, login token or custody command. */
export function assetLabelCode(company: any, asset: any) {
  return `HRMS-ASSET:1:${objectId(idString(company), "company id")}:${objectId(idString(asset), "asset id")}`;
}

export function assetScanMatch(company: any, value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) throw generateError("Scan an HRMS asset QR or enter the exact asset tag", 422);
  const code = value.trim(), qr = /^HRMS-ASSET:1:([a-f\d]{24}):([a-f\d]{24})$/i.exec(code);
  if (qr) {
    if (qr[1].toLowerCase() !== idString(company).toLowerCase()) throw generateError("Asset not found", 404);
    return { company, _id: objectId(qr[2], "asset id") };
  }
  if (code.length > 40 || !/^[A-Z0-9][A-Z0-9._/-]*$/i.test(code)) throw generateError("Use an HRMS asset QR or exact asset tag, not a URL or serial number", 422);
  return { company, tag: code.toUpperCase() };
}

export function assetLabelOptions(body: any): AssetLabelOptions {
  if (!Array.isArray(body?.assetIds) || !body.assetIds.length || body.assetIds.length > ASSET_LABEL_LIMIT) throw generateError(`Select 1-${ASSET_LABEL_LIMIT} assets for labels`, 422);
  const assetIds = body.assetIds.map((value: unknown) => idString(objectId(value, "label asset id")));
  if (new Set(assetIds).size !== assetIds.length) throw generateError("Choose each asset only once in a label download", 422);
  const layout = body.layout ?? "a4", startPosition = body.startPosition ?? 1;
  if (!["a4", "single"].includes(layout)) throw generateError("Choose A4 sheet or single-label layout", 422);
  if (!Number.isSafeInteger(startPosition) || startPosition < 1 || startPosition > ASSET_LABELS_PER_SHEET) throw generateError("First label position must be 1-12", 422);
  if (layout === "single" && (assetIds.length !== 1 || startPosition !== 1)) throw generateError("Single-label layout needs exactly one asset and first position 1", 422);
  return { assetIds, layout, startPosition };
}
