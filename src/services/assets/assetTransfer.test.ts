import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssetImportBatch, AssetImportRow, AssetTransferEvent } from "../../schemas/Assets/AssetImport.schema";
import { attachEffectivePermissions, getDefaultPermissionsForRole, PERMISSION_KEYS } from "../permissions/permission.utils";
import { assetCsvCell, canExportAssets, canImportAssets, importBatchDto, IMPORT_COLUMNS, parseAssetImportFile, prepareImportRows } from "./assetTransfer.utils";
const id = () => new mongoose.Types.ObjectId(), company = id(), creator = id();
const actor = (role = "hradmin", permissions?: any, userId = creator) => ({ company, actor: attachEffectivePermissions({ user: { _id: userId, company, role, permissions } }) });
const file = (csv: string) => ({ originalname: "fixture.csv", buffer: Buffer.from(csv) });

/** These tests use memory-only CSV fixtures; they never connect to or seed a company database. */
async function main() {
  const parsed = await parseAssetImportFile(file('\uFEFFAsset name,Category,Condition,Serial number,Internal notes\r\n"QA, laptop",LAPTOP,NEW,00001234,"one\ntwo"\r\n'));
  assert.equal(parsed.length, 1); assert.equal(parsed[0].source.serialNumber, "00001234"); assert.equal(parsed[0].source.internalNotes, "one\ntwo");
  const prepared = prepareImportRows(parsed); assert.deepEqual(prepared[0].errors, []); assert.equal(prepared[0].content?.category, "laptop"); assert.match(prepared[0].content!.tag, /^AST-/);
  const duplicate = prepareImportRows([...parsed, { ...parsed[0], rowNumber: 3 }]); assert.ok(duplicate.every((row) => row.errors.some((value) => value.includes("repeated"))));
  assert.ok(prepareImportRows([{ rowNumber: 2, source: { ...parsed[0].source, serialNumber: "", tag: "" } }])[0].errors.some((value) => value.includes("tag or serial")));
  await assert.rejects(() => parseAssetImportFile(file("Asset name,Category,Condition,Employee\nLaptop,laptop,new,Ashu\n")));
  await assert.rejects(() => parseAssetImportFile(file("Asset name,name,Category,Condition\nLaptop,Laptop,laptop,new\n")));
  await assert.rejects(() => parseAssetImportFile(file("Asset name,Category,Condition\n" + Array.from({ length: 201 }, () => "Laptop,laptop,new").join("\n"))));
  await assert.rejects(() => parseAssetImportFile({ originalname: "fixture.csv", buffer: Buffer.from([0xff, 0xfe]) }));
  assert.equal(IMPORT_COLUMNS.length, 9);
  for (const cell of ["=HYPERLINK(1)", " +SUM(1)", "@value", "\ttext", "000123", "1234567890123456"]) assert.ok(assetCsvCell(cell).startsWith('"\''));
  assert.equal(assetCsvCell('a,"b"'), '"a,""b"""');
  assert.equal(canImportAssets(actor()), true); assert.equal(canExportAssets(actor("hr")), false);
  assert.equal(canImportAssets(actor("user", { view_assets: true, manage_assets: true, import_assets: true })), true);
  assert.equal(canImportAssets(actor("hradmin", { manage_assets: false })), false);
  assert.equal(canExportAssets(actor("user", { view_assets: true, export_assets: true })), true);
  assert.equal(getDefaultPermissionsForRole("hradmin")[PERMISSION_KEYS.IMPORT_ASSETS], true);
  assert.equal(getDefaultPermissionsForRole("hr")[PERMISSION_KEYS.IMPORT_ASSETS], false);
  const batch = { _id: id(), createdBy: creator, status: "ready", validUntil: new Date(Date.now() + 60000) };
  assert.equal(importBatchDto(actor(), batch).canApply, true); assert.equal(importBatchDto(actor("hradmin", undefined, id()), batch).canApply, false);
  assert.equal(importBatchDto(actor(), { ...batch, validUntil: new Date(0) }).canApply, false);
  assert.equal(importBatchDto(actor(), { ...batch, status: "applied" }).canCancel, false);
  assert.ok(AssetImportBatch.schema.indexes().some(([fields, options]: any) => fields.company && fields.fileHash && options.unique && options.partialFilterExpression?.status === "applied"));
  assert.ok(AssetImportRow.schema.indexes().some(([fields, options]: any) => fields.company && fields.batch && fields.rowNumber && options.unique));
  assert.ok(AssetTransferEvent.schema.indexes().some(([fields, options]: any) => fields.company && fields.actor && fields.requestId && options.unique));
  console.log("Asset transfer assertions passed: CSV text preservation, bounded input, duplicate guards, safe exports and creator-only permissions.");
}
void main();
