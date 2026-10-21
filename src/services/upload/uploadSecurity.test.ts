import assert from "node:assert/strict";
import {
  LEAVE_DOCUMENT_MIME_TYPES,
  detectUploadMimeType,
  validateProfileImageUpload,
  validateUploadSignature,
} from "./uploadSecurity.utils";

const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
const jpeg = Buffer.from("ffd8ffe000104a464946", "hex");
const executable = Buffer.from("4d5a900003000000", "hex");

assert.equal(detectUploadMimeType(png), "image/png");
assert.equal(detectUploadMimeType(jpeg), "image/jpeg");
assert.throws(
  () => validateProfileImageUpload({ type: "image/png", buffer: executable.toString("base64") }),
  /contents do not match/
);
assert.doesNotThrow(() =>
  validateProfileImageUpload({ type: "image/png", buffer: `data:image/png;base64,${png.toString("base64")}` })
);
assert.throws(
  () => validateUploadSignature({
    data: `data:image/png;base64,${png.toString("base64")}`,
    declaredMimeType: "application/pdf",
    allowedMimeTypes: LEAVE_DOCUMENT_MIME_TYPES,
    maxBytes: 5 * 1024 * 1024,
  }),
  /does not match/
);

console.log("Upload security tests passed (5 assertions)");
