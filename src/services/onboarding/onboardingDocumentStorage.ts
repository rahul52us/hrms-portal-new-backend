import mongoose, { ClientSession } from "mongoose";
import { createHash } from "crypto";
import Document from "../../schemas/Onboarding/OnboardingDocument.schema";
import Instance from "../../schemas/Onboarding/EmployeeOnboarding.schema";
import { generateError } from "../../config/Error/functions";
import { deletePrivateDocument, privateDocumentKey, putPrivateDocument, r2Configuration, readPrivateDocument } from "../storage/privateObjectStorage";
import { scanPrivateUpload } from "../storage/malwareScanner";

export async function stageOnboardingDocument(input: { company: any; onboarding: any; task: any; uploadedBy: any; name: string; type: string; bytes: Buffer }) {
  const storageBucket = r2Configuration().bucket;
  const bytes = Buffer.from(input.bytes);
  const scan = await scanPrivateUpload(bytes, { company: input.company, uploadedBy: input.uploadedBy, purpose: "onboarding" });
  const _id = new mongoose.Types.ObjectId();
  const storageKey = privateDocumentKey(String(input.company), String(input.onboarding), String(input.task), String(_id));
  const document = await Document.create({ _id, company: input.company, onboarding: input.onboarding, task: input.task, uploadedBy: input.uploadedBy,
    name: input.name, type: input.type, size: bytes.length, sha256: scan.sha256, scan,
    storageProvider: "r2", storageBucket, storageKey, storageStatus: "staged" });
  try { await putPrivateDocument(document, bytes, input.type); }
  catch (error) { await queueOnboardingDocumentCleanup(_id).catch(() => undefined); throw error; }
  return document.toObject();
}

export async function attachOnboardingDocument(document: any, session: ClientSession) {
  const attached = await Document.findOneAndUpdate({ _id: document._id, company: document.company, storageStatus: "staged" }, { $set: { storageStatus: "attached" } }, { session, new: true }).lean();
  if (!attached) throw generateError("Document upload expired. Upload the file again.", 409);
  return attached;
}

export async function queueOnboardingDocumentCleanup(id: any) {
  // Delay deletion: a failed PUT response does not prove the provider stopped writing.
  await Document.updateOne({ _id: id, storageProvider: "r2", storageStatus: "staged" }, { $set: { storageStatus: "cleanup_pending" } });
}

export async function abandonOnboardingDocument(id: any) {
  // This write races safely with transaction commit: an attached file can never be claimed for cleanup.
  const document: any = await Document.findOneAndUpdate({ _id: id, storageProvider: "r2", storageStatus: { $in: ["staged", "cleanup_pending"] } }, { $set: { storageStatus: "cleanup_pending" } }, { new: true }).lean();
  if (!document) return;
  if (document.storageKey !== privateDocumentKey(String(document.company), String(document.onboarding), String(document.task), String(document._id))) {
    throw generateError("Invalid private document storage reference", 503);
  }
  if (await Instance.exists({ _id: document.onboarding, company: document.company, "tasks.documents.document": document._id })) {
    throw generateError("Linked documents must never be removed by upload cleanup", 409);
  }
  await deletePrivateDocument(document);
  await Document.updateOne({ _id: id, storageStatus: "cleanup_pending" }, { $set: { storageStatus: "deleted" } });
}

export async function onboardingDocumentBytes(document: any) {
  if (document.storageStatus && document.storageStatus !== "attached") throw generateError("Onboarding document is not available", 404);
  if (document.scan?.sha256 && document.scan.sha256 !== document.sha256) throw generateError("Invalid upload scan reference", 503);
  if (document.storageProvider === "r2") {
    if (document.storageStatus !== "attached") throw generateError("Onboarding document is not available", 404);
    const expected = privateDocumentKey(String(document.company), String(document.onboarding), String(document.task), String(document._id));
    if (document.storageKey !== expected) throw generateError("Invalid private document storage reference", 503);
    return readPrivateDocument(document, document.size, document.sha256);
  }
  if (!document.bytes) throw generateError("Onboarding document is not available", 404);
  const bytes = Buffer.isBuffer(document.bytes) ? document.bytes : Buffer.from(document.bytes.buffer);
  if (bytes.length !== document.size || createHash("sha256").update(bytes).digest("hex") !== document.sha256) throw generateError("The onboarding document failed its integrity check", 503);
  return bytes;
}
