import ExcelJS from "exceljs";
import { Readable } from "stream";
import { TextDecoder } from "util";
import { generateError } from "../../config/Error/functions";
import { BUILTIN_ASSET_CATEGORIES } from "../../schemas/Assets/AssetCategory.schema";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { AssetContext, canManageAssets, canViewAssets, generatedTag, idString, normalizedAsset } from "./asset.utils";

export const ASSET_IMPORT_LIMIT = 200, ASSET_FILE_LIMIT = 1024 * 1024, ASSET_EXPORT_LIMIT = 5000;
export const IMPORT_COLUMNS = [
  ["tag", "Asset tag"], ["name", "Asset name"], ["category", "Category"], ["condition", "Condition"], ["brand", "Brand"], ["model", "Model"], ["serialNumber", "Serial number"], ["locationCode", "Location code"], ["internalNotes", "Internal notes"],
] as const;
export type ImportSource = Record<typeof IMPORT_COLUMNS[number][0], string>;
export type ImportInput = { rowNumber: number; source: ImportSource };
export const canImportAssets = (ctx: AssetContext) => canManageAssets(ctx) && hasPermission(ctx.actor, PERMISSION_KEYS.IMPORT_ASSETS);
export const canExportAssets = (ctx: AssetContext) => canViewAssets(ctx) && hasPermission(ctx.actor, PERMISSION_KEYS.EXPORT_ASSETS);
export const batchSnapshot = (row: any) => ({ status: row.status, revision: row.revision, totalRows: row.totalRows, validRows: row.validRows, invalidRows: row.invalidRows, appliedRows: row.appliedRows });
export function importBatchDto(ctx: AssetContext, row: any) {
  const { _id, fileName, status, revision, totalRows, validRows, invalidRows, appliedRows, creatorName, createdAt, validUntil, appliedAt, appliedByName, applyReason, cancelledAt, cancellerName, cancellationReason } = row;
  const owner = canImportAssets(ctx) && idString(row.createdBy) === idString(ctx.actor), isExpired = new Date(validUntil).getTime() < Date.now();
  return { _id, fileName, status, revision, totalRows, validRows, invalidRows, appliedRows, creatorName, createdAt, validUntil, appliedAt, appliedByName, applyReason, cancelledAt, cancellerName, cancellationReason, isExpired,
    canApply: Boolean(owner && status === "ready" && !isExpired), canCancel: Boolean(owner && ["ready", "invalid"].includes(status)) };
}

/** ExcelJS's default CSV mapper coerces identifiers into numbers/dates; preserve every input cell as text. */
export async function parseAssetImportFile(file: any): Promise<ImportInput[]> {
  if (!Buffer.isBuffer(file?.buffer)) throw generateError("Choose a UTF-8 CSV inventory file", 400);
  if (file.buffer.length > ASSET_FILE_LIMIT) throw generateError("Asset CSV must not exceed 1 MB", 413);
  if (!String(file.originalname || "").toLowerCase().endsWith(".csv")) throw generateError("Asset import accepts CSV files only", 422);
  let csv: string;
  try { csv = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer); } catch { throw generateError("Save this file as UTF-8 CSV before uploading", 422); }
  if (csv.includes("\0")) throw generateError("The CSV contains unsupported binary data", 422);
  const workbook = new ExcelJS.Workbook(); let worksheet: ExcelJS.Worksheet;
  try { worksheet = await workbook.csv.read(Readable.from([csv.replace(/^\uFEFF/, "")]), { map: (value: string) => value, parserOptions: { ignoreEmpty: true, maxRows: ASSET_IMPORT_LIMIT + 2 } }); }
  catch { throw generateError("Unable to read CSV. Check quoted values and comma-separated columns.", 422); }
  if (worksheet.rowCount < 2) throw generateError("The import has no equipment rows", 422);
  if (worksheet.rowCount > ASSET_IMPORT_LIMIT + 1) throw generateError(`Import at most ${ASSET_IMPORT_LIMIT} rows at a time`, 422);
  const headerKey = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases = new Map(IMPORT_COLUMNS.flatMap(([key, label]) => [[headerKey(key), key], [headerKey(label), key]] as Array<[string, typeof key]>));
  const columns = new Map<number, typeof IMPORT_COLUMNS[number][0]>(), seen = new Set<string>();
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, number) => {
    const label = String(cell.value ?? ""), key = aliases.get(headerKey(label));
    if (!key) throw generateError(`Unsupported CSV column: ${label.slice(0, 80) || "blank header"}. Use the inventory template; employee, status and custody columns are not imported.`, 422);
    if (seen.has(key)) throw generateError(`Duplicate CSV column: ${label.slice(0, 80)}`, 422);
    seen.add(key); columns.set(number, key);
  });
  for (const key of ["name", "category", "condition"]) if (!seen.has(key)) throw generateError(`Missing required CSV column: ${key}`, 422);
  const result: ImportInput[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    if (row.cellCount > columns.size) throw generateError(`CSV row ${rowNumber} has more columns than the header`, 422);
    const source = Object.fromEntries(IMPORT_COLUMNS.map(([key]) => [key, ""])) as ImportSource;
    columns.forEach((key, column) => { const value = String(row.getCell(column).value ?? "").trim(); if (value.length > 4000) throw generateError(`CSV row ${rowNumber} contains a cell longer than 4000 characters`, 422); source[key] = value; });
    if (Object.values(source).some(Boolean)) result.push({ rowNumber, source });
  });
  if (!result.length) throw generateError("The import has no equipment rows", 422);
  return result;
}
export function prepareImportRows(rows: ImportInput[]) {
  const prepared = rows.map(({ rowNumber, source }) => {
    let content: (ReturnType<typeof normalizedAsset> & { categoryName?: string }) | null = null; const errors: string[] = [];
    try { content = normalizedAsset({ ...source, category: source.category.toLowerCase(), condition: source.condition.toLowerCase(), officeLocation: null }); if (!content.tag) content.tag = generatedTag(); }
    catch (error: any) { errors.push(String(error.message || "Invalid inventory data")); }
    if (!source.tag && !source.serialNumber) errors.push("Provide an asset tag or serial number so repeated imports cannot create duplicate units");
    return { rowNumber, source, content, categoryRevision: null as number | null, locationCode: source.locationCode.toUpperCase(), locationName: "", errors };
  });
  for (const [key, label] of [["tag", "Asset tag"], ["serialNumber", "Serial number"]] as const) {
    const groups = new Map<string, typeof prepared>();
    for (const row of prepared) { const value = row.source[key].trim().toUpperCase(); if (value) groups.set(value, [...(groups.get(value) || []), row]); }
    for (const group of groups.values()) if (group.length > 1) for (const row of group) row.errors.push(`${label} is repeated in this file (rows ${group.map((item) => item.rowNumber).join(", ")})`);
  }
  return prepared;
}
/** CSV escaping alone does not stop spreadsheet formulas; XLSX exports keep explicit string cell types. */
export function assetCsvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f\u007f\uFEFF]*[=+\-@]/.test(text) || /^[\u0000-\u001f\u007f]/.test(text) || /^(0\d+|\d{15,})$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export const assetCsv = (rows: unknown[][]) => "\uFEFF" + rows.map((row) => row.map(assetCsvCell).join(",")).join("\r\n") + "\r\n";
export const ASSET_INVENTORY_HEADERS = ["Asset tag", "Asset name", "Category code", "Category name", "Condition", "Status", "Brand", "Model", "Serial number", "Inventory location", "Current custodian code", "Current custodian name", "Incident hold", "Service hold", "Write-off hold", "Internal notes", "Created at (UTC)", "Updated at (UTC)"];
export const assetInventoryValues = (asset: any) => [asset.tag, asset.name, asset.category, asset.categoryName || BUILTIN_ASSET_CATEGORIES[asset.category] || asset.category, asset.condition, asset.status, asset.brand, asset.model, asset.serialNumber, asset.locationName, asset.holder?.code || "", asset.holder?.name || "", asset.openIncident ? "Yes" : "No", asset.openService ? "Yes" : "No", asset.openWriteOff || asset.writtenOffRecord ? "Yes" : "No", asset.internalNotes, asset.createdAt?.toISOString() || "", asset.updatedAt?.toISOString() || ""];
