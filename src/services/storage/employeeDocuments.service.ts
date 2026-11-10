import mongoose, { ClientSession } from "mongoose";
import { createHash } from "crypto";
import Documents from "../../schemas/User/Document";
import User from "../../schemas/User/User";
import File from "../../schemas/Storage/PrivateStoredFile.schema";
import Audit from "../../schemas/Storage/EmployeeDocumentAudit.schema";
import { generateError } from "../../config/Error/functions";
import { getEmployeeRequestActor } from "../leave/leaveAccess.utils";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { LEAVE_DOCUMENT_MIME_TYPES, validateUploadSignature } from "../upload/uploadSecurity.utils";
import { attachPrivateStoredFile, privateStoredFileBytes, privateUploadName, privateUploadRequestId, queuePrivateStoredFileCleanup, sendPrivateFile, stagePrivateStoredFile } from "./privateStoredFile.service";

const id = (value: any) => String(value?._id || value || "");
function objectId(value: any) {
  if (!mongoose.Types.ObjectId.isValid(id(value))) throw generateError("Invalid employee or file id", 400);
  return new mongoose.Types.ObjectId(id(value));
}
const text = (value: any) => String(value || "").trim();
const same = (left: any, right: any) => text(left).toLowerCase() === text(right).toLowerCase();
/** Identity documents require explicit employee-management scope; reporting-manager status alone is insufficient. */
export function canAccessEmployeeDocuments(actor: any, employee: any, write = false) {
  if (id(actor) === id(employee)) return true;
  if (!hasPermission(actor, write ? PERMISSION_KEYS.EDIT_USERS : PERMISSION_KEYS.VIEW_USERS)) return false;
  if (actor.role === "superadmin") return true;
  if (id(actor.company) !== id(employee.company)) return false;
  if (["admin", "hradmin"].includes(actor.role)) return true;
  if (actor.role === "departmenthead") return Boolean(actor.department) && same(actor.department, employee.department);
  if (actor.role !== "hr") return false;
  if (write && ["admin", "hradmin", "hr", "superadmin", "departmenthead"].includes(employee.role)) return false;
  const scope = actor.hrScope || {}, departments = scope.departments || [], teams = scope.teams || [], locations = scope.officeLocations || [];
  return departments.some((item: any) => same(item, employee.department)) &&
    (!teams.length || teams.some((item: any) => same(item, employee.team))) &&
    (!locations.length || locations.some((item: any) => id(item) === id(employee.officeLocation)));
}
async function target(req: any, write = false, session?: ClientSession) {
  const actor = getEmployeeRequestActor(req);
  const employee: any = await User.findOne({ _id: objectId(req.params.id), deletedAt: null }).select("_id company role department team officeLocation").session(session || null).lean();
  if (!employee || !employee.company || !canAccessEmployeeDocuments(actor, employee, write)) throw generateError("Employee documents not found or outside your access", 403);
  const requestedCompany = req.body?.companyId || req.query?.companyId;
  if (requestedCompany && id(requestedCompany) !== id(employee.company)) throw generateError("Employee is not in the selected company", 403);
  return { actor, employee, company: employee.company };
}
async function current(employee: any, session?: ClientSession) {
  // Prefer the upgraded company-scoped record; legacy records are adopted only by an explicit successful save.
  const canonical = await Documents.findOne({ user: employee._id, company: employee.company, storageSchemaVersion: 2, deletedAt: null }).session(session || null).lean();
  return canonical || await Documents.findOne({ user: employee._id, storageSchemaVersion: { $ne: 2 }, deletedAt: null }).sort({ _id: 1 }).session(session || null).lean();
}
function savedFile(file: any) {
  return file?.url ? { name: file.name || "Document", type: file.type || "application/octet-stream", url: file.url, ...(file.privateFileId ? { privateFileId: id(file.privateFileId) } : {}) } : undefined;
}
function dto(record: any, employee: any) {
  const documents = Array.isArray(record?.documents) ? record.documents.map((row: any) => ({
    ...(row.id !== undefined ? { id: row.id } : {}), ...(row.documentId ? { documentId: row.documentId } : {}),
    ...(row.title || row.documentType ? { title: row.title || row.documentType } : {}), ...(row.label ? { label: row.label } : {}),
    effectiveFrom: row.effectiveFrom || "", validTill: row.validTill || "", uploadedAt: row.uploadedAt || null,
    ...(savedFile(row.file) ? { file: savedFile(row.file) } : {}),
  })) : [];
  return { _id: record?._id, user: employee._id, revision: record?.revision || 0, documents, updatedAt: record?.updatedAt };
}
function date(value: any) {
  if (!value) return "";
  const key = text(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || Number.isNaN(Date.parse(key)) || new Date(key).toISOString().slice(0, 10) !== key) throw generateError("Enter a valid document date", 422);
  return key;
}
function rowMetadata(row: any) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw generateError("Invalid document row", 422);
  const title = text(row.title || row.documentType), label = text(row.label);
  if ((!title && !label) || title.length > 150 || label.length > 150) throw generateError("A document title or label of at most 150 characters is required", 422);
  const effectiveFrom = date(row.effectiveFrom), validTill = date(row.validTill);
  if (effectiveFrom && validTill && validTill < effectiveFrom) throw generateError("Document expiry cannot be before its effective date", 422);
  const rowId = typeof row.id === "number" || typeof row.id === "string" ? text(row.id) : undefined;
  if (rowId && rowId.length > 100) throw generateError("Invalid document row id", 422);
  return { ...(rowId ? { id: row.id } : {}), ...(title ? { title } : {}), ...(label ? { label } : {}), effectiveFrom, validTill };
}
const revisionMatch = (revision: number) => revision === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision };

export async function getEmployeeDocuments(req: any, res: any, next: any) {
  res.setHeader("Cache-Control", "private, no-store");
  try { const { employee } = await target(req); res.json({ status: "success", data: dto(await current(employee), employee) }); }
  catch (error) { next(error); }
}
export async function updateEmployeeDocuments(req: any, res: any, next: any) {
  const staged: any[] = [];
  let session: ClientSession | undefined;
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const { actor, employee, company } = await target(req, true);
    const requestId = privateUploadRequestId(req.body?.requestId), revision = req.body?.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw generateError("Fetch the document list and send its revision before saving", 422);
    const rows = req.body?.documents;
    if (!Array.isArray(rows) || rows.length > 50) throw generateError("Provide a document list with at most 50 rows", 422);
    const hash = createHash("sha256").update(JSON.stringify({ employee: id(employee), revision, documents: rows })).digest("hex");
    const replay = async (transaction?: ClientSession) => {
      const prior: any = await Audit.findOne({ company, actor: actor._id, requestId }).session(transaction || null).lean();
      if (prior && prior.requestHash !== hash) throw generateError("Document requestId was already used for another change", 409);
      return prior;
    };
    // An exact retry can replay its original result, but current access is checked before consulting that history.
    const prior = await replay();
    if (prior) { res.json({ status: "success", data: prior.after, replayed: true }); return; }
    const before: any = await current(employee);
    if ((before?.revision || 0) !== revision) throw generateError("Documents changed. Reload before saving.", 409);
    const existing = Array.isArray(before?.documents) ? before.documents : [], retained = new Set<number>();
    const prepared = rows.map((row: any) => ({ row, metadata: rowMetadata(row) }));
    if (prepared.filter(({ row }: any) => row.isAdd).length > 5) throw generateError("Upload at most five new files in one save", 422);
    const uploads = prepared.map(({ row, metadata }: any) => {
      if (!row.isAdd) return { row, metadata, upload: null };
      if (row.isDeleted) throw generateError("A document cannot be uploaded and removed together", 422);
      const source = row.file;
      const file = validateUploadSignature({ data: typeof source === "string" ? source : source?.file || source?.buffer || source?.base64 || source?.data,
        declaredMimeType: source?.type || source?.mimetype, allowedMimeTypes: LEAVE_DOCUMENT_MIME_TYPES, maxBytes: 5 * 1024 * 1024 });
      return { row, metadata, upload: { ...file, name: privateUploadName(source?.filename || source?.name || "document") } };
    });
    const documents: any[] = [];
    for (const { row, metadata, upload } of uploads) {
      const index = row.documentId ? existing.findIndex((item: any) => item.documentId === row.documentId) : row.file?.url ? existing.findIndex((item: any) => item.file?.url === row.file.url) : -1;
      if (index >= 0 && retained.has(index)) throw generateError("A saved document can be included only once", 422);
      if (index >= 0) retained.add(index);
      const previous = index >= 0 ? existing[index] : null;
      let file = !row.isDeleted ? savedFile(previous?.file) : undefined;
      if (upload) {
        const stored = await stagePrivateStoredFile({ company, employee: employee._id, uploadedBy: actor._id, purpose: "employee_document", name: upload.name, type: upload.mimeType, bytes: upload.buffer });
        staged.push(stored);
        file = { name: stored.name, type: stored.type, url: `/user/updateDocuments/${employee._id}/files/${stored._id}`, privateFileId: id(stored) };
      } else if (row.file && !previous && !row.isDeleted) {
        throw generateError("Retain only files already saved for this employee, or upload a new file", 422);
      }
      documents.push({ ...metadata, documentId: previous?.documentId || id(new mongoose.Types.ObjectId()), ...(file ? { file } : {}), uploadedAt: upload ? new Date() : previous?.uploadedAt || null });
    }
    let result: any, replayed = false;
    session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Recheck scope and revision after external uploads: HR scope or another writer may have changed meanwhile.
        await target(req, true, session);
        const retry = await replay(session);
        if (retry) { result = retry.after; replayed = true; return; }
        const latest: any = await current(employee, session);
        if ((latest?.revision || 0) !== revision || id(latest) !== id(before)) throw generateError("Documents changed. Reload before saving.", 409);
        for (const file of staged) await attachPrivateStoredFile(file, session!);
        const changes = { company, user: employee._id, storageSchemaVersion: 2, documents, revision: revision + 1, updatedAt: new Date() };
        let saved: any;
        if (latest) saved = await Documents.findOneAndUpdate({ _id: latest._id, ...revisionMatch(revision) }, { $set: changes }, { new: true, session, runValidators: true }).lean();
        else [saved] = await Documents.create([changes], { session });
        if (!saved) throw generateError("Documents changed. Reload before saving.", 409);
        result = dto(saved, employee);
        await Audit.create([{ company, employee: employee._id, actor: actor._id, requestId, requestHash: hash, before: dto(latest, employee), after: result }], { session });
      });
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      const retry = await replay();
      if (!retry) throw generateError("Documents changed. Reload before saving.", 409);
      result = retry.after; replayed = true;
    }
    res.json({ status: "success", data: result, replayed });
  } catch (error) { next(error); }
  finally {
    await session?.endSession();
    for (const file of staged) await queuePrivateStoredFileCleanup(file._id).catch(() => console.warn("Employee document cleanup is pending."));
  }
}
export async function downloadEmployeeDocument(req: any, res: any, next: any) {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const { employee, company } = await target(req);
    const fileId = objectId(req.params.fileId), record: any = await current(employee);
    if (!record?.documents?.some((row: any) => id(row.file?.privateFileId) === id(fileId))) throw generateError("Employee document not found", 404);
    const file: any = await File.findOne({ _id: fileId, company, employee: employee._id, purpose: "employee_document", storageStatus: "attached" }).select("+bytes").lean();
    if (!file) throw generateError("Employee document not found", 404);
    sendPrivateFile(res, file, await privateStoredFileBytes(file));
  } catch (error) { next(error); }
}
