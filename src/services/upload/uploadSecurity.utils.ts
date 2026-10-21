import { generateError } from "../../config/Error/functions";

export const PROFILE_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const LEAVE_DOCUMENT_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;

function normalizeMimeType(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function startsWithBytes(buffer: Buffer, signature: number[]) {
  return signature.every((value, index) => buffer[index] === value);
}

export function detectUploadMimeType(buffer: Buffer) {
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

function decodeUploadData(value: unknown) {
  if (Buffer.isBuffer(value)) return { buffer: value, dataUriMimeType: "" };
  const input = String(value || "").trim();
  if (!input) throw generateError("Upload content is required", 422);

  const dataUriMatch = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(input);
  const dataUriMimeType = normalizeMimeType(dataUriMatch?.[1]);
  const encoded = String(dataUriMatch?.[2] || input).replace(/\s+/g, "");
  if (!encoded || !/^[a-z0-9+/]*={0,2}$/i.test(encoded) || encoded.length % 4 !== 0) {
    throw generateError("Upload content is not valid base64 data", 422);
  }
  return { buffer: Buffer.from(encoded, "base64"), dataUriMimeType };
}

export function validateUploadSignature(options: {
  data: unknown;
  declaredMimeType: unknown;
  allowedMimeTypes: readonly string[];
  maxBytes: number;
}) {
  const declaredMimeType = normalizeMimeType(options.declaredMimeType);
  if (!options.allowedMimeTypes.includes(declaredMimeType)) {
    throw generateError("This file type is not allowed", 422);
  }

  const { buffer, dataUriMimeType } = decodeUploadData(options.data);
  if (buffer.length === 0 || buffer.length > options.maxBytes) {
    throw generateError(`Upload must be ${Math.floor(options.maxBytes / (1024 * 1024))} MB or smaller`, 422);
  }
  if (dataUriMimeType && dataUriMimeType !== declaredMimeType) {
    throw generateError("Upload data does not match its declared content type", 422);
  }

  const detectedMimeType = detectUploadMimeType(buffer);
  if (!detectedMimeType || detectedMimeType !== declaredMimeType) {
    throw generateError("File contents do not match the declared file type", 422);
  }

  return { buffer, mimeType: detectedMimeType, size: buffer.length };
}

export function validateProfileImageUpload(pic: any) {
  if (!pic?.buffer) throw generateError("Profile image content is required", 422);
  return validateUploadSignature({
    data: pic.buffer,
    declaredMimeType: pic.type,
    allowedMimeTypes: PROFILE_IMAGE_MIME_TYPES,
    maxBytes: MAX_PROFILE_IMAGE_BYTES,
  });
}
