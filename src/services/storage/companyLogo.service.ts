import mongoose, { ClientSession } from "mongoose";
import { createHash } from "crypto";
import Company from "../../schemas/company/Company";
import File from "../../schemas/Storage/PrivateStoredFile.schema";
import Audit from "../../schemas/Storage/CompanyLogoAudit.schema";
import { generateError } from "../../config/Error/functions";
import { getEmployeeRequestActor } from "../leave/leaveAccess.utils";
import { validateUploadSignature } from "../upload/uploadSecurity.utils";
import { privateStoredFileBytes, privateUploadName, stagePrivateStoredFile } from "./privateStoredFile.service";

const id = (value: any) => String(value?._id || value || "");
export const MAX_COMPANY_LOGO_BYTES = 2_000_000;
export const COMPANY_LOGO_TYPES = ["image/png", "image/jpeg"] as const;

/** Validate actual image bytes before company writes, not just the data-URL prefix accepted by Joi. */
export function validateCompanyLogo(input: any) {
  const upload = validateUploadSignature({ data: input?.buffer, declaredMimeType: input?.type, allowedMimeTypes: COMPANY_LOGO_TYPES, maxBytes: MAX_COMPANY_LOGO_BYTES, maxBytesLabel: "2,000,000 bytes" });
  return { ...upload, name: privateUploadName(input?.filename), sha256: createHash("sha256").update(upload.buffer).digest("hex") };
}

/** Stage a new immutable logo, or recognize an exact retry whose bytes are already the active logo. */
export async function prepareCompanyLogo(company: any, actor: any, input: any, expectedUrl?: string | null) {
  const image = validateCompanyLogo(input);
  const current: any = company.logo?.privateFileId ? await File.findOne({ _id: company.logo.privateFileId, company: company._id, purpose: "company_logo", storageStatus: "attached" }).lean() : null;
  if (current && current.sha256 === image.sha256 && current.name === image.name && current.type === image.mimeType && current.size === image.size) {
    return { logo: logoMetadata(current), staged: null, unchanged: true };
  }
  if (expectedUrl !== undefined && String(expectedUrl || "") !== String(company.logo?.url || "")) throw generateError("Company logo changed. Reload company settings before saving.", 409);
  const file = await stagePrivateStoredFile({ company: company._id, uploadedBy: actor, purpose: "company_logo", name: image.name, type: image.mimeType, bytes: image.buffer });
  return { logo: logoMetadata(file), staged: file, unchanged: false };
}

function logoMetadata(file: any) {
  return { name: file.name, type: file.type, url: `/company/logos/${file.company}/${file._id}`, privateFileId: file._id, sha256: file.sha256 };
}

/** Save only references in audit; binary data and credentials never enter a company history snapshot. */
export async function auditCompanyLogo(company: any, actor: any, before: any, after: any, session: ClientSession) {
  const snapshot = (value: any) => value?.url ? { name: value.name, url: value.url, type: value.type, privateFileId: value.privateFileId || null, sha256: value.sha256 || "" } : null;
  await Audit.create([{ company, actor, action: !after?.url ? "removed" : before?.url ? "replaced" : "created", before: snapshot(before), after: snapshot(after) }], { session });
}

/** Branding is company-visible, not public: revocation checks the current company link on every image request. */
export async function getCompanyLogo(req: any, res: any, next: any) {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const actor = getEmployeeRequestActor(req), { companyId, fileId } = req.params;
    if (![companyId, fileId].every((value) => mongoose.Types.ObjectId.isValid(value))) throw generateError("Invalid company logo id", 400);
    if (actor.role !== "superadmin" && id(actor.company) !== companyId) throw generateError("Company logo not found", 404);
    const company: any = await Company.findOne({ _id: companyId, deletedAt: null }).select("logo").lean();
    if (!company || id(company.logo?.privateFileId) !== fileId) throw generateError("Company logo not found", 404);
    const file: any = await File.findOne({ _id: fileId, company: companyId, purpose: "company_logo", storageStatus: "attached" }).select("+bytes").lean();
    if (!file || !COMPANY_LOGO_TYPES.includes(file.type) || file.size > MAX_COMPANY_LOGO_BYTES) throw generateError("Company logo not found", 404);
    const bytes = await privateStoredFileBytes(file);
    res.setHeader("Content-Type", file.type); res.setHeader("Content-Disposition", `inline; filename="logo.${file.type === "image/png" ? "png" : "jpg"}"`);
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.send(bytes);
  } catch (error) { next(error); }
}

/** Payroll has already authorized the payslip. Read its frozen logo, not the company's current branding. */
export async function loadHistoricalCompanyLogo(company: any, logo: any) {
  if (!mongoose.Types.ObjectId.isValid(id(logo?.privateFileId))) return null;
  const file: any = await File.findOne({ _id: logo.privateFileId, company, purpose: "company_logo", storageStatus: "attached" }).select("+bytes").lean();
  if (!file || file.sha256 !== logo.sha256 || !COMPANY_LOGO_TYPES.includes(file.type) || file.size > MAX_COMPANY_LOGO_BYTES) return null;
  return { bytes: await privateStoredFileBytes(file), type: file.type };
}
