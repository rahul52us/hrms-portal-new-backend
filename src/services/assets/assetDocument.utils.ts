import { ASSET_DOCUMENT_KINDS, ASSET_DOCUMENT_LIMITS } from "../../schemas/Assets/AssetDocument.schema";
import { generateError } from "../../config/Error/functions";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { validateUploadSignature, LEAVE_DOCUMENT_MIME_TYPES } from "../upload/uploadSecurity.utils";
import { privateUploadName } from "../storage/privateStoredFile.service";
import { AssetContext, canViewAssets, idString, text } from "./asset.utils";

export const canManageAssetDocuments = (ctx: AssetContext) => canViewAssets(ctx) && hasPermission(ctx.actor, PERMISSION_KEYS.MANAGE_ASSET_DOCUMENTS);
export function assetDocumentMetadata(body: any) {
  for (const field of ["url", "privateFile", "privateFileId", "fileId", "storageKey", "storageBucket", "file", "asset", "assetId", "version", "currentFile"]) if (body[field] !== undefined) throw generateError("File references, asset ownership and version numbers are server-managed", 422);
  if (!ASSET_DOCUMENT_KINDS.includes(body.kind)) throw generateError("Choose a valid asset document type", 422);
  return { title: text(body.title, "Document title", 2, 150), kind: body.kind as string };
}
export function validateAssetDocumentUpload(file: any, kind: string) {
  if (!Buffer.isBuffer(file?.buffer)) throw generateError("Choose a PDF, JPG or PNG asset file", 400);
  const upload = validateUploadSignature({ data: file.buffer, declaredMimeType: file.mimetype, allowedMimeTypes: LEAVE_DOCUMENT_MIME_TYPES, maxBytes: ASSET_DOCUMENT_LIMITS.bytes });
  assertAssetDocumentKind(kind, upload.mimeType);
  const name = privateUploadName(file.originalname), extension = name.toLowerCase().split(".").pop();
  const expected = upload.mimeType === "application/pdf" ? ["pdf"] : upload.mimeType === "image/png" ? ["png"] : ["jpg", "jpeg"];
  if (!expected.includes(extension || "")) throw generateError("File extension must match the PDF, JPG or PNG content type", 422);
  return { ...upload, name };
}
export function assertAssetDocumentKind(kind: string, mime: string) { if (kind === "photo" && mime === "application/pdf") throw generateError("Photo documents must be JPG or PNG images", 422); }
export const assetDocumentPath = (asset: any, document: any, version: number) => `/assets/inventory/${idString(asset)}/documents/${idString(document)}/versions/${version}/download`;
export function assetDocumentFileDto(asset: any, document: any, version: number, file: any) {
  return { name: file.name, type: file.type, size: file.size, version, downloadUrl: assetDocumentPath(asset, document, version), scan: { status: file.scan.status, provider: file.scan.provider, scannedAt: file.scan.scannedAt } };
}
/** Inventory readers see safe metadata and authenticated routes, never storage keys or employee-proof references. */
export function assetDocumentDto(ctx: AssetContext, row: any, capacity?: { versions: number }) {
  const manage = canManageAssetDocuments(ctx), active = row.state === "active";
  const { _id, asset, title, kind, state, revision, currentVersion, creatorName, createdAt, updatedAt, updatedByName, archivedAt, archiverName, archiveReason } = row;
  return { _id, asset, title, kind, state, revision, currentVersion, creatorName, createdAt, updatedAt, updatedByName, archivedAt, archiverName, archiveReason,
    file: assetDocumentFileDto(asset, _id, currentVersion, row.currentFile), canReplace: manage && active && currentVersion < ASSET_DOCUMENT_LIMITS.versionsPerDocument && (!capacity || capacity.versions < ASSET_DOCUMENT_LIMITS.versionsPerAsset), canUpdate: manage && active, canArchive: manage && active, canRestore: manage && !active };
}
export function assetDocumentVersionDto(row: any) {
  const { _id, title, kind, version, uploaderName, createdAt, reason } = row;
  return { _id, title, kind, version, uploaderName, createdAt, reason, file: assetDocumentFileDto(row.asset, row.document, version, row.file) };
}
