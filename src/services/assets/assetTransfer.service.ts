import { createHash, randomUUID } from "crypto";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { Asset, AssetAudit as Audit } from "../../schemas/Assets/Asset.schema";
import { AssetImportBatch as Batch, AssetImportRow as Row, AssetTransferEvent as Event } from "../../schemas/Assets/AssetImport.schema";
import Location from "../../schemas/OfficeLocation/OfficeLocation.schema";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { assetContext, AssetContext, assetDto, idString, inventoryMatch, objectId, pagination, revision, text } from "./asset.utils";
import { ASSET_EXPORT_LIMIT, ASSET_FILE_LIMIT, ASSET_IMPORT_LIMIT, ASSET_INVENTORY_HEADERS, assetInventoryValues, assetCsv, batchSnapshot, canExportAssets, canImportAssets, IMPORT_COLUMNS, importBatchDto, parseAssetImportFile, prepareImportRows } from "./assetTransfer.utils";
import { AssetCategory, BUILTIN_ASSET_CATEGORIES } from "../../schemas/Assets/AssetCategory.schema";
import { categoryValues, resolveAssetCategories } from "./assetCategory.utils";

const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
function requestKey(value: unknown) { const result = text(value, "Request id", 8, 100); if (!/^[A-Za-z0-9_-]+$/.test(result)) throw generateError("Invalid request id", 422); return result; }
async function manager(req: any) {
  const ctx = assetContext(req, "manage");
  if (!canImportAssets(ctx)) throw generateError("Import Asset Inventory permission is required", 403);
  await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: idString(ctx.company), actionLabel: "import asset inventory" });
  for (const model of [Asset, Audit, Batch, Row, Event, Location, AssetCategory]) await model.init();
  return ctx;
}
async function findBatch(ctx: AssetContext, value: string, session?: mongoose.ClientSession) {
  const batch: any = await Batch.findOne({ _id: objectId(value, "asset import id"), company: ctx.company }).select("+fileHash").session(session || null).lean();
  if (!batch) throw generateError("Asset import not found", 404);
  return batch;
}
async function original(ctx: AssetContext, key: string, intentHash: string, session?: mongoose.ClientSession) {
  const event: any = await Event.findOne({ company: ctx.company, actor: ctx.actor._id, requestId: key }).select("+requestHash").session(session || null).lean();
  if (event && event.requestHash !== intentHash) throw generateError("Request id already used for another inventory transfer", 409);
  return event;
}
async function validatePreview(ctx: AssetContext, inputs: Awaited<ReturnType<typeof parseAssetImportFile>>, session: mongoose.ClientSession) {
  const rows = prepareImportRows(inputs), codes = [...new Set(rows.map((row) => row.locationCode).filter(Boolean))];
  const locations = await Location.find({ company: ctx.company, code: { $in: codes }, is_active: true, deletedAt: null }).select("name code").session(session).lean();
  const tags = rows.flatMap((row) => row.content ? [row.content.tag] : []), serials = rows.map((row) => row.source.serialNumber.toUpperCase()).filter(Boolean);
  const existing: any[] = await Asset.find({ company: ctx.company, $or: [{ tag: { $in: tags } }, { serialKey: { $in: serials } }] }).select("tag serialKey").session(session).lean();
  const categories = await categoryValues(ctx.company, rows.flatMap((row) => row.content ? [row.content.category] : []), session);
  return rows.map((row) => {
    const location = locations.find((place) => place.code === row.locationCode);
    if (row.locationCode && !location) row.errors.push("Location code must identify an active office in this company");
    if (row.content) {
      const category = categories.get(row.content.category);
      if (!category) row.errors.push("Category code must identify a built-in or active custom category in this company");
      else { row.content.categoryName = category.name; row.categoryRevision = category.revision; }
      if (existing.some((asset) => asset.tag === row.content!.tag)) row.errors.push("Asset tag already exists; imports never overwrite inventory");
      if (row.content.serialNumber && existing.some((asset) => asset.serialKey === row.content!.serialNumber.toUpperCase())) row.errors.push("Serial number already exists in this company");
      row.content.officeLocation = location?._id || null; row.locationName = location?.name || "";
    }
    return { ...row, validationStatus: row.errors.length ? "invalid" : "valid" };
  });
}
export const assetImportTemplate = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "manage"); if (!canImportAssets(ctx)) throw generateError("Import Asset Inventory permission is required", 403);
    res.setHeader("Content-Disposition", 'attachment; filename="asset-inventory-template.csv"'); res.type("text/csv; charset=utf-8"); res.send(assetCsv([IMPORT_COLUMNS.map(([, label]) => label)]));
  } catch (error) { next(error); }
};
/** Preview stores a reviewed plan only. No equipment/custody is created until a separate confirmed apply transaction. */
export const previewAssetImport = async (req: any, res: any, next: any) => {
  try {
    const ctx = await manager(req), key = requestKey(req.body?.requestId), file = req.file;
    if (!Buffer.isBuffer(file?.buffer)) throw generateError("Choose a CSV inventory file", 400);
    if (file.buffer.length > ASSET_FILE_LIMIT) throw generateError("Asset CSV must not exceed 1 MB", 413);
    const fileName = String(file.originalname || "").split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 150), fileHash = hash(file.buffer), intentHash = hash({ action: "preview", fileName, fileHash });
    let batchId: any, replayed = false;
    const prior = await original(ctx, key, intentHash);
    if (prior) { batchId = prior.batch; replayed = true; }
    else {
      const inputs = await parseAssetImportFile(file);
      try { await mongoose.connection.transaction(async (session) => {
        const retry = await original(ctx, key, intentHash, session); if (retry) { batchId = retry.batch; replayed = true; return; }
        if (await Batch.exists({ company: ctx.company, fileHash, status: "applied" }).session(session)) throw generateError("This exact CSV was already imported. Open its existing import instead of creating duplicate equipment.", 409);
        const rows = await validatePreview(ctx, inputs, session), invalidRows = rows.filter((row) => row.validationStatus === "invalid").length;
        const batch = (await Batch.create([{ company: ctx.company, createdBy: ctx.actor._id, creatorName: ctx.actor.name || "Asset manager", fileName, fileHash, status: invalidRows ? "invalid" : "ready", totalRows: rows.length, validRows: rows.length - invalidRows, invalidRows, validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000) }], { session }))[0];
        await Row.insertMany(rows.map((row) => ({ ...row, company: ctx.company, batch: batch._id })), { session, ordered: true });
        await Event.create([{ company: ctx.company, batch: batch._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", action: "preview", reason: "Prepared create-only inventory preview", requestId: key, requestHash: intentHash, after: batchSnapshot(batch) }], { session });
        batchId = batch._id;
      }, { readConcern: { level: "snapshot" } }); } catch (error: any) {
        if (error.code !== 11000) throw error;
        const retry = await original(ctx, key, intentHash); if (!retry) throw generateError("Inventory import changed concurrently. Reload before creating another preview.", 409); batchId = retry.batch; replayed = true;
      }
    }
    res.status(replayed ? 200 : 201).json({ success: true, data: importBatchDto(ctx, await findBatch(ctx, idString(batchId))), replayed });
  } catch (error) { next(error); }
};
export const listAssetImports = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "view"), { page, limit, skip } = pagination(req.query), status = req.query.status || "all";
    if (!["all", "ready", "invalid", "applied", "cancelled"].includes(status)) throw generateError("Invalid import status", 400);
    const match = { company: ctx.company, ...(status === "all" ? {} : { status }) };
    const data = await Batch.find(match).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Batch.countDocuments(match);
    res.json({ success: true, data: data.map((row) => importBatchDto(ctx, row)), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const getAssetImport = async (req: any, res: any, next: any) => {
  try { const ctx = assetContext(req, "view"); res.json({ success: true, data: importBatchDto(ctx, await findBatch(ctx, req.params.importId)) }); } catch (error) { next(error); }
};
export const assetImportHistory = (kind: "rows" | "events") => async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "view"), batch = await findBatch(ctx, req.params.importId), { page, limit, skip } = pagination(req.query);
    const state = req.query.state || "all"; if (kind === "rows" && !["all", "valid", "invalid"].includes(state)) throw generateError("Invalid import row filter", 400);
    const model = kind === "rows" ? Row : Event, match = { company: ctx.company, batch: batch._id, ...(kind === "rows" && state !== "all" ? { validationStatus: state } : {}) };
    const data = await model.find(match).select(kind === "rows" ? "rowNumber source content categoryRevision locationCode locationName validationStatus errors asset" : "actorName action reason before after createdAt").sort(kind === "rows" ? { rowNumber: 1 } : { createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await model.countDocuments(match);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
/** All rows create atomically; source conflicts, location changes and any failed row abort the complete batch. */
export const mutateAssetImport = (action: "apply" | "cancel") => async (req: any, res: any, next: any) => {
  try {
    const ctx = await manager(req), body = req.body || {}, key = requestKey(body.requestId), target = objectId(req.params.importId, "asset import id");
    const input = { action, target: idString(target), revision: revision(body.revision), reason: text(body.reason, "Import reason", 3, 1000), ...(action === "apply" ? { confirmCreateOnly: body.confirmCreateOnly === true } : {}) };
    if (action === "apply" && !input.confirmCreateOnly) throw generateError("Confirm this creates new equipment only, without employee custody", 422);
    const intentHash = hash(input); let replayed = false;
    try { await mongoose.connection.transaction(async (session) => {
      if (await original(ctx, key, intentHash, session)) { replayed = true; return; }
      const batch = await findBatch(ctx, idString(target), session);
      if (idString(batch.createdBy) !== idString(ctx.actor)) throw generateError("Only the preview creator may apply or cancel this import", 403);
      if (batch.revision !== input.revision || !["ready", "invalid"].includes(batch.status)) throw generateError("This import changed or is already closed. Reload before continuing.", 409);
      const before = batchSnapshot(batch); let changes: any;
      if (action === "apply") {
        if (batch.status !== "ready" || batch.invalidRows || new Date(batch.validUntil).getTime() < Date.now()) throw generateError("Use an unexpired preview with every row valid. Correct the CSV and prepare a new preview.", 409);
        const rows: any[] = await Row.find({ company: ctx.company, batch: batch._id }).sort({ rowNumber: 1 }).limit(ASSET_IMPORT_LIMIT + 1).session(session).lean();
        if (!rows.length || rows.length !== batch.totalRows || rows.length > ASSET_IMPORT_LIMIT || rows.some((row) => row.validationStatus !== "valid" || !row.content || row.asset)) throw generateError("The reviewed import plan is inconsistent. Prepare a new preview.", 409);
        if (await Batch.exists({ company: ctx.company, fileHash: batch.fileHash, status: "applied" }).session(session)) throw generateError("This exact file was already imported by another preview", 409);
        const tags = rows.map((row) => row.content.tag), serials = rows.map((row) => row.content.serialNumber.toUpperCase()).filter(Boolean);
        if (await Asset.exists({ company: ctx.company, $or: [{ tag: { $in: tags } }, { serialKey: { $in: serials } }] }).session(session)) throw generateError("A reviewed tag or serial now exists. Prepare a new preview; no rows were imported.", 409);
        const uniqueCategories = new Map(rows.map((row) => [row.content.category, row]));
        await resolveAssetCategories(ctx.company, [...uniqueCategories.keys()], session, new Map([...uniqueCategories.values()].map((row) => [row.content.category, { revision: row.categoryRevision ?? null, name: row.content.categoryName || BUILTIN_ASSET_CATEGORIES[row.content.category] || row.content.category }])));
        const locationRows = rows.filter((row) => row.content.officeLocation), uniqueLocations = new Map(locationRows.map((row) => [idString(row.content.officeLocation), row]));
        for (const row of uniqueLocations.values()) {
          const locked = await Location.updateOne({ _id: row.content.officeLocation, company: ctx.company, code: row.locationCode, name: row.locationName, is_active: true, deletedAt: null }, { $inc: { assetImportFence: 1 } }, { session, timestamps: false });
          if (!locked.matchedCount) throw generateError("A reviewed inventory location changed or was archived. Prepare a new preview; nothing was imported.", 409);
        }
        const eventId = new mongoose.Types.ObjectId(), now = new Date();
        const equipment = rows.map((row) => ({ _id: new mongoose.Types.ObjectId(), company: ctx.company, ...row.content, categoryName: row.content.categoryName || BUILTIN_ASSET_CATEGORIES[row.content.category] || row.content.category, locationName: row.locationName, ...(row.content.serialNumber ? { serialKey: row.content.serialNumber.toUpperCase() } : {}), status: row.content.condition === "damaged" ? "maintenance" : "available", createdBy: ctx.actor._id, updatedBy: ctx.actor._id }));
        const created = await Asset.insertMany(equipment, { session, ordered: true });
        await Audit.insertMany(created.map((document: any, index: number) => { const asset = document.toObject(); return { company: ctx.company, asset: asset._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", action: "imported", reason: input.reason, requestId: `import-${eventId}-${rows[index].rowNumber}`, requestHash: intentHash, after: { asset: assetDto(ctx, asset), importBatch: batch._id, rowNumber: rows[index].rowNumber } }; }), { session, ordered: true });
        const linked = await Row.bulkWrite(rows.map((row, index) => ({ updateOne: { filter: { _id: row._id, company: ctx.company, batch: batch._id, asset: null }, update: { $set: { asset: equipment[index]._id } } } })), { session, ordered: true });
        if (linked.modifiedCount !== rows.length) throw generateError("Import provenance changed. No equipment was partially registered.", 409);
        changes = { status: "applied", appliedRows: rows.length, appliedAt: now, appliedByName: ctx.actor.name || "Asset manager", applyReason: input.reason };
      } else changes = { status: "cancelled", cancelledAt: new Date(), cancellerName: ctx.actor.name || "Asset manager", cancellationReason: input.reason };
      const updated: any = await Batch.findOneAndUpdate({ _id: target, company: ctx.company, revision: input.revision, status: batch.status }, { $set: changes, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
      if (!updated) throw generateError("The import changed during confirmation. Reload before continuing.", 409);
      await Event.create([{ company: ctx.company, batch: target, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", action, reason: input.reason, requestId: key, requestHash: intentHash, before, after: batchSnapshot(updated) }], { session });
    }, { readConcern: { level: "snapshot" } }); } catch (error: any) {
      if (error.code !== 11000) throw error;
      if (!await original(ctx, key, intentHash)) throw generateError("Duplicate tag, serial or already-applied file. Nothing was partially imported; prepare a new preview.", 409);
      replayed = true;
    }
    res.json({ success: true, data: importBatchDto(ctx, await findBatch(ctx, idString(target))), replayed });
  } catch (error) { next(error); }
};
export const exportAssetInventory = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "view"); if (!canExportAssets(ctx)) throw generateError("Export Asset Inventory permission is required", 403);
    const format = req.query.format || "xlsx"; if (!["csv", "xlsx"].includes(format)) throw generateError("Choose CSV or XLSX export", 400);
    const match = inventoryMatch(ctx, req.query), exportedAt = new Date(); let data: any[] = [];
    await Event.init();
    await mongoose.connection.transaction(async (session) => {
      data = await Asset.find(match).sort({ tag: 1, _id: 1 }).limit(ASSET_EXPORT_LIMIT + 1).session(session).lean();
      if (data.length > ASSET_EXPORT_LIMIT) throw generateError(`Narrow the inventory filters to export at most ${ASSET_EXPORT_LIMIT} assets; no partial file was generated`, 422);
      await Event.create([{ company: ctx.company, actor: ctx.actor._id, actorName: ctx.actor.name || "Inventory viewer", action: "export", reason: "Prepared filtered asset inventory export", requestId: randomUUID(), requestHash: hash({ match, format }), after: { format, rowCount: data.length, exportedAt, filters: { status: req.query.status || "all", category: req.query.category || "all", officeLocation: req.query.officeLocation || null, search: req.query.search || "" } } }], { session });
    }, { readConcern: { level: "snapshot" } });
    const headers = ASSET_INVENTORY_HEADERS, values = data.map(assetInventoryValues);
    res.setHeader("Content-Disposition", `attachment; filename="asset-inventory-${exportedAt.toISOString().slice(0, 10)}.${format}"`);
    if (format === "csv") { res.type("text/csv; charset=utf-8"); res.send(assetCsv([headers, ...values])); }
    else {
      const workbook = new ExcelJS.Workbook(); workbook.creator = "HRMS"; workbook.created = exportedAt;
      const sheet = workbook.addWorksheet("Inventory"); sheet.addRow(headers); sheet.addRows(values.map((row) => row.map((value) => String(value ?? ""))));
      sheet.getRow(1).font = { bold: true }; sheet.views = [{ state: "frozen", ySplit: 1 }]; sheet.autoFilter = { from: "A1", to: "R1" };
      sheet.columns.forEach((column, index) => { column.width = index === 15 ? 50 : index >= 16 ? 26 : 22; });
      res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
    }
  } catch (error) { next(error); }
};
