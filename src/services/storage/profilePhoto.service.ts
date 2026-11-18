import mongoose, { ClientSession } from "mongoose";
import { createHash } from "crypto";
import User from "../../schemas/User/User";
import File from "../../schemas/Storage/PrivateStoredFile.schema";
import Audit from "../../schemas/Storage/ProfilePhotoAudit.schema";
import { generateError } from "../../config/Error/functions";
import { getEmployeeRequestActor } from "../leave/leaveAccess.utils";
import { canAccessEmployeeDocuments } from "./employeeDocuments.service";
import { MAX_PROFILE_IMAGE_BYTES, PROFILE_IMAGE_MIME_TYPES, validateProfileImageUpload } from "../upload/uploadSecurity.utils";
import { attachPrivateStoredFile, privateStoredFileBytes, privateUploadName, queuePrivateStoredFileCleanup, stagePrivateStoredFile } from "./privateStoredFile.service";

const id = (value: any) => String(value?._id || value || "");
type PhotoChange = { before: any; after: any; staged: any; isCreate: boolean } | null;

/** A profile photo is directory-visible, but changing another person's photo still requires employee-management scope. */
export function assertProfilePhotoWriteAccess(actor: any, employee: any) {
  if (id(actor) === id(employee)) return;
  if (!canAccessEmployeeDocuments(actor, employee, true) ||
      (actor.role === "hradmin" && ["admin", "superadmin"].includes(employee.role))) {
    throw generateError("You cannot update this employee's profile", 403);
  }
}

/** Stage outside MongoDB transactions; external storage cannot participate in their rollback or automatic retries. */
export async function prepareProfilePhoto(user: any, actorId: any, picture: any, expectedUrl: unknown, isCreate = false): Promise<PhotoChange> {
  if (!picture) return null;
  const removing = Boolean(picture.isDeleted), uploading = Boolean(picture.buffer);
  if (removing && (uploading || picture.isAdd)) throw generateError("A profile photo cannot be uploaded and removed together", 422);
  if (picture.isAdd && !uploading) throw generateError("Profile photo content is required", 422);
  if (!removing && !uploading) return null;
  if (!user.company && user.role !== "superadmin") throw generateError("A company is required for employee photos", 422);
  if (!isCreate && typeof expectedUrl !== "string") throw generateError("Send expectedPhotoUrl from the loaded profile before changing its photo", 422);
  const before = user.pic?.toObject ? user.pic.toObject() : user.pic || null;
  const url = String(before?.url || "");
  if (removing && !url) return null;
  const image = uploading ? validateProfileImageUpload(picture) : null;
  const name = image ? privateUploadName(picture.filename || "profile-photo") : "";
  const sha256 = image ? createHash("sha256").update(image.buffer).digest("hex") : "";

  // An uncertain-response retry of the already-active image must not create another object or audit event.
  if (image && before?.privateFileId) {
    const current: any = await File.findOne({ _id: before.privateFileId, company: user.company || null, employee: user._id, purpose: "profile_photo", storageStatus: "attached" }).lean();
    if (current && current.sha256 === sha256 && current.name === name && current.type === image.mimeType && current.size === image.size) return null;
  }
  if (!isCreate && expectedUrl !== url) throw generateError("Profile photo changed. Reload the profile before saving.", 409);
  if (!image) return { before, after: null, staged: null, isCreate };
  const staged = await stagePrivateStoredFile({ company: user.company || null, employee: user._id, uploadedBy: actorId, purpose: "profile_photo", name, type: image.mimeType, bytes: image.buffer });
  return { before, after: { name, type: image.mimeType, url: `/user/profile-photos/${user._id}/${staged._id}`, privateFileId: staged._id, sha256 }, staged, isCreate };
}

/** Commit the user link, attachment state and audit together; the source URL is a compare-and-swap guard. */
export async function saveUserWithProfilePhoto(user: any, change: PhotoChange, actorId: any, session: ClientSession) {
  if (change) {
    if (!change.isCreate) {
      const sourceUrl = String(change.before?.url || "");
      const result = await User.updateOne({ _id: user._id, company: user.company || null, deletedAt: null, "pic.url": sourceUrl || { $in: [null, ""] } }, { $set: { pic: change.after } }, { session });
      if (!result.matchedCount) throw generateError("Profile photo changed. Reload the profile before saving.", 409);
    }
    user.pic = change.after;
  }
  await user.save({ session });
  if (!change) return;
  if (change.staged) await attachPrivateStoredFile(change.staged, session);
  await Audit.create([{ company: user.company || null, employee: user._id, actor: actorId,
    action: !change.after ? "removed" : change.before?.url ? "replaced" : "created", before: change.before, after: change.after }], { session });
}

/** Staged-only cleanup is safe even when a commit succeeded but the HTTP response was lost. */
export async function discardUnattachedProfilePhoto(change: PhotoChange) {
  if (change?.staged) await queuePrivateStoredFileCleanup(change.staged._id).catch(() => undefined);
}

/** A photo-only endpoint avoids resubmitting unrelated personal fields when uploading or retrying an image. */
export async function updateProfilePhoto(req: any, res: any, next: any) {
  let change: PhotoChange = null;
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.employeeId)) throw generateError("Invalid employee id", 400);
    const user = await User.findOne({ _id: req.params.employeeId, deletedAt: null });
    if (!user) throw generateError("User not found", 404);
    const actor = getEmployeeRequestActor(req);
    assertProfilePhotoWriteAccess(actor, user);
    if (!req.body?.pic?.isDeleted && !req.body?.pic?.buffer) throw generateError("Upload a profile photo or request its removal", 422);
    change = await prepareProfilePhoto(user, actor._id, req.body.pic, req.body.expectedPhotoUrl);
    await mongoose.connection.transaction(async (session) => {
      await saveUserWithProfilePhoto(user, change, actor._id, session);
    });
    res.json({ success: true, data: { pic: user.pic || null }, unchanged: !change });
  } catch (error) { next(error); }
  finally { await discardUnattachedProfilePhoto(change); }
}

/** Only the current link is readable; knowing a removed, replaced or foreign-tenant file ID grants no access. */
export async function getProfilePhoto(req: any, res: any, next: any) {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const actor = getEmployeeRequestActor(req), { employeeId, fileId } = req.params;
    if (![employeeId, fileId].every((value) => mongoose.Types.ObjectId.isValid(value))) throw generateError("Invalid profile photo id", 400);
    const user: any = await User.findOne({ _id: employeeId, deletedAt: null }).select("company role pic").lean();
    if (!user || (actor.role !== "superadmin" && id(actor) !== employeeId && (!user.company || id(actor.company) !== id(user.company))) || id(user.pic?.privateFileId) !== fileId) throw generateError("Profile photo not found", 404);
    const file: any = await File.findOne({ _id: fileId, company: user.company || null, employee: user._id, purpose: "profile_photo", storageStatus: "attached" }).select("+bytes").lean();
    if (!file || !PROFILE_IMAGE_MIME_TYPES.includes(file.type) || file.size > MAX_PROFILE_IMAGE_BYTES || file.sha256 !== user.pic.sha256) throw generateError("Profile photo not found", 404);
    const bytes = await privateStoredFileBytes(file);
    const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    res.setHeader("Content-Type", file.type);
    res.setHeader("Content-Disposition", `inline; filename="profile.${extension}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.send(bytes);
  } catch (error) { next(error); }
}
