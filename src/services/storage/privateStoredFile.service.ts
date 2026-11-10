import mongoose, { ClientSession } from "mongoose";
import { createHash } from "crypto";
import File from "../../schemas/Storage/PrivateStoredFile.schema";
import { generateError } from "../../config/Error/functions";
import { companyLogoKey, deletePrivateDocument, documentStorageProvider, employeeDocumentKey, putPrivateDocument, r2Configuration, readPrivateDocument, requestAttachmentKey } from "./privateObjectStorage";

export function storedFileKey(file: any) {
  if (file.purpose === "employee_document") return employeeDocumentKey(String(file.company), String(file.employee), String(file._id));
  if (file.purpose === "company_logo") return companyLogoKey(String(file.company), String(file._id));
  if (file.purpose === "request_attachment") return requestAttachmentKey(String(file.company), String(file._id));
  throw generateError("Invalid private document purpose", 422);
}
/** Persist the upload journal before PUT so a timeout or process crash leaves a recoverable object reference. */
export async function stagePrivateStoredFile(input: { company: any; employee?: any; uploadedBy: any; purpose: "request_attachment" | "employee_document" | "company_logo"; name: string; type: string; bytes: Buffer }) {
  const _id = new mongoose.Types.ObjectId(), provider = documentStorageProvider();
  const metadata = { _id, company: input.company, employee: input.employee || null, uploadedBy: input.uploadedBy, purpose: input.purpose,
    name: input.name, type: input.type, size: input.bytes.length, sha256: createHash("sha256").update(input.bytes).digest("hex"),
    storageProvider: provider, storageStatus: "staged", storageBucket: provider === "r2" ? r2Configuration().bucket : undefined };
  const file = await File.create({ ...metadata, storageKey: storedFileKey(metadata), ...(provider === "mongodb" ? { bytes: input.bytes } : {}) });
  try { if (provider === "r2") await putPrivateDocument(file, input.bytes, input.type); }
  catch (error) { await queuePrivateStoredFileCleanup(_id).catch(() => undefined); throw error; }
  return file.toObject();
}
/** Call inside the domain transaction: file visibility and its owning record must commit together. */
export async function attachPrivateStoredFile(file: any, session: ClientSession) {
  const attached = await File.findOneAndUpdate({ _id: file._id, company: file.company, storageStatus: "staged" }, { $set: { storageStatus: "attached" } }, { new: true, session }).lean();
  if (!attached) throw generateError("Document upload expired. Upload it again.", 409);
  return attached;
}
export async function queuePrivateStoredFileCleanup(id: any) {
  // The staged-only predicate cannot invalidate a winner whose transaction committed after an uncertain response.
  await File.updateOne({ _id: id, storageStatus: "staged" }, { $set: { storageStatus: "cleanup_pending" } });
}
/** The job runner supplies aged candidates; attached evidence is deliberately excluded, even after UI removal. */
export async function cleanupPrivateStoredFile(id: any) {
  const file: any = await File.findOneAndUpdate({ _id: id, storageStatus: { $in: ["staged", "cleanup_pending"] } }, { $set: { storageStatus: "cleanup_pending" } }, { new: true }).lean();
  if (!file) return;
  if (file.storageKey !== storedFileKey(file)) throw generateError("Invalid private document storage reference", 503);
  if (file.storageProvider === "r2") await deletePrivateDocument(file);
  // Raw collection update intentionally erases orphan bytes despite normal immutability.
  await File.collection.updateOne({ _id: file._id, storageStatus: "cleanup_pending" }, { $set: { storageStatus: "deleted" }, $unset: { bytes: "" } });
}
/** Domain access is checked by the caller; this layer enforces immutable reference and byte integrity. */
export async function privateStoredFileBytes(file: any) {
  if (file.storageStatus !== "attached") throw generateError("Document not found", 404);
  if (file.storageKey !== storedFileKey(file)) throw generateError("Invalid private document storage reference", 503);
  if (file.storageProvider === "r2") return readPrivateDocument(file, file.size, file.sha256);
  const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : file.bytes?.buffer ? Buffer.from(file.bytes.buffer) : null;
  if (!bytes || bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw generateError("The document failed its integrity check", 503);
  return bytes;
}
export function sendPrivateFile(res: any, file: any, bytes: Buffer) {
  res.setHeader("Cache-Control", "private, no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Content-Type", file.type);
  res.setHeader("Content-Disposition", `attachment; filename="document.${file.type === "application/pdf" ? "pdf" : file.type === "image/png" ? "png" : "jpg"}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.send(bytes);
}
export function privateUploadName(value: unknown) {
  const name = String(value || "").trim().replace(/[\\/\r\n\u0000-\u001f"]/g, "_");
  if (!name || name.length > 150) throw generateError("Document name must be 1-150 characters", 422);
  return name;
}
export function privateUploadRequestId(value: unknown) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw generateError("A stable 8-100 character requestId is required", 422);
  return id;
}
