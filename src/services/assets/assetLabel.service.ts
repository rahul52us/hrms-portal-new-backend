import { Asset } from "../../schemas/Assets/Asset.schema";
import Company from "../../schemas/company/Company";
import { generateError } from "../../config/Error/functions";
import { assetContext, idString, objectId } from "./asset.utils";
import { canExportAssets } from "./assetTransfer.utils";
import { assetLabelOptions, assetScanMatch } from "./assetLabel.utils";
import { renderAssetLabels } from "./assetLabelPdf";

export const lookupAssetLabel = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "view"), match = assetScanMatch(ctx.company, req.body?.code);
    const data = await Asset.findOne(match).select("_id tag name status").lean();
    if (!data) throw generateError("Asset not found", 404);
    res.json({ success: true, data });
  } catch (error) { next(error); }
};

/** Read-only, bounded extraction: no job, stored PDF, custody/audit mutation or idempotency command is created. */
export const downloadAssetLabels = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "view");
    if (!canExportAssets(ctx)) throw generateError("Export Asset Inventory permission is required to download labels", 403);
    const options = assetLabelOptions(req.body), rows: any[] = await Asset.find({ company: ctx.company, _id: { $in: options.assetIds.map(value => objectId(value, "label asset id")) } }).select("_id tag name").lean();
    if (rows.length !== options.assetIds.length) throw generateError("One or more selected assets were not found in this company. No partial label file was generated.", 404);
    const byId = new Map(rows.map(row => [idString(row), row])), ordered = options.assetIds.map(value => byId.get(value)!);
    const company: any = await Company.findById(ctx.company).select("company_name").lean();
    if (!company) throw generateError("Company not found", 404);
    const result = await renderAssetLabels(idString(ctx.company), company.company_name, ordered, options);
    res.setHeader("Content-Disposition", 'attachment; filename="asset-labels.pdf"');
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader("X-Asset-Label-Count", String(ordered.length)); res.setHeader("X-Asset-Label-Pages", String(result.pages));
    res.type("application/pdf").send(result.bytes);
  } catch (error) { next(error); }
};
