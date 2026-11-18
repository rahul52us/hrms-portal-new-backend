import { createHash } from "crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { generateError } from "../../config/Error/functions";

export type PrivateObjectReference = { storageBucket: string; storageKey: string };
type Environment = NodeJS.ProcessEnv;
const maxDocumentBytes = 5 * 1024 * 1024;

export function documentStorageProvider(env: Environment = process.env): "mongodb" | "r2" {
  const provider = env.HRMS_DOCUMENT_STORAGE || "mongodb";
  if (provider !== "mongodb" && provider !== "r2") throw generateError("Invalid document storage configuration", 503);
  return provider;
}

export function r2Configuration(env: Environment = process.env) {
  const account = env.R2_ACCOUNT_ID || "";
  const bucket = env.R2_BUCKET_NAME || "";
  if (!/^[a-f0-9]{32}$/i.test(account) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw generateError("Cloudflare R2 storage is not configured", 503);
  }
  const endpoint = env.R2_ENDPOINT || `https://${account}.r2.cloudflarestorage.com`;
  const allowed = ["", ".eu", ".fedramp", ".us"].map((jurisdiction) => `https://${account}${jurisdiction}.r2.cloudflarestorage.com`);
  if (!allowed.includes(endpoint.replace(/\/$/, ""))) throw generateError("Invalid Cloudflare R2 endpoint", 503);
  let testEndpoint: string | undefined;
  if (env.R2_TEST_ENDPOINT) {
    let candidate: URL;
    try { candidate = new URL(env.R2_TEST_ENDPOINT); }
    catch { throw generateError("Invalid R2 test endpoint", 503); }
    if (env.NODE_ENV !== "test" || candidate.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(candidate.hostname) || candidate.username || candidate.password || candidate.search || candidate.hash) {
      throw generateError("R2 test endpoints are allowed only on loopback in test mode", 503);
    }
    testEndpoint = candidate.toString().replace(/\/$/, "");
  }
  return { bucket, endpoint: testEndpoint || endpoint, credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } };
}

export function privateDocumentKey(company: string, onboarding: string, task: string, document: string) {
  if (![company, onboarding, task, document].every((id) => /^[a-f0-9]{24}$/i.test(id))) throw generateError("Invalid document storage reference", 422);
  return `companies/${company}/onboarding/${onboarding}/tasks/${task}/${document}`;
}

export function employeeDocumentKey(company: string, employee: string, file: string) {
  if (![company, employee, file].every((id) => /^[a-f0-9]{24}$/i.test(id))) throw generateError("Invalid document storage reference", 422);
  return `companies/${company}/employees/${employee}/documents/${file}`;
}

export function requestAttachmentKey(company: string, file: string) {
  if (![company, file].every((id) => /^[a-f0-9]{24}$/i.test(id))) throw generateError("Invalid document storage reference", 422);
  return `companies/${company}/request-attachments/${file}`;
}

/** Inventory evidence never shares an employee-proof or public image namespace. */
export function assetDocumentKey(company: string, asset: string, file: string) {
  if (![company, asset, file].every((id) => /^[a-f0-9]{24}$/i.test(id))) throw generateError("Invalid asset document reference", 422);
  return `companies/${company}/assets/${asset}/documents/${file}`;
}

/** Keep branding assets in a distinct namespace; a logo reference must never resolve to an employee proof. */
export function companyLogoKey(company: string, file: string) {
  if (![company, file].every((id) => /^[a-f0-9]{24}$/i.test(id))) throw generateError("Invalid company logo reference", 422);
  return `companies/${company}/logos/${file}`;
}

/** Platform superadmins have no tenant; never put their photo inside an arbitrary company's namespace. */
export function profilePhotoKey(company: string | null, employee: string, file: string) {
  if (![employee, file, ...(company ? [company] : [])].every((id) => /^[a-f0-9]{24}$/i.test(id))) throw generateError("Invalid profile photo reference", 422);
  return company ? `companies/${company}/employees/${employee}/photos/${file}` : `platform/users/${employee}/photos/${file}`;
}

export function isPrivateStorageKey(key: string) {
  const id = "[a-f0-9]{24}";
  return new RegExp(`^(?:companies/${id}/(?:onboarding/${id}/tasks/${id}/${id}|employees/${id}/(?:documents|photos)/${id}|assets/${id}/documents/${id}|request-attachments/${id}|logos/${id})|platform/users/${id}/photos/${id})$`, "i").test(key);
}

function reference(input: PrivateObjectReference) {
  const config = r2Configuration();
  if (input.storageBucket !== config.bucket || !isPrivateStorageKey(input.storageKey)) {
    throw generateError("Invalid private document storage reference", 503);
  }
  return { config, Bucket: input.storageBucket, Key: input.storageKey };
}

function client(config: ReturnType<typeof r2Configuration>) {
  return new S3Client({
    region: "auto", endpoint: config.endpoint, credentials: config.credentials, forcePathStyle: true,
    maxAttempts: 3, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 },
  });
}

export async function putPrivateDocument(input: PrivateObjectReference, bytes: Buffer, contentType: string) {
  if (!bytes.length || bytes.length > maxDocumentBytes) throw generateError("Invalid document size", 422);
  const { config, Bucket, Key } = reference(input), connection = client(config);
  try {
    await connection.send(new PutObjectCommand({ Bucket, Key, Body: bytes, ContentType: contentType, ContentLength: bytes.length, CacheControl: "private, no-store" }), { abortSignal: AbortSignal.timeout(20000) });
  } catch { throw generateError("Document storage is unavailable. Try again later.", 503); }
  finally { connection.destroy(); }
}

export async function readPrivateDocument(input: PrivateObjectReference, size: number, sha256: string) {
  const { config, Bucket, Key } = reference(input), connection = client(config);
  try {
    const response = await connection.send(new GetObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(20000) });
    if (!response.Body || (response.ContentLength !== undefined && response.ContentLength !== size)) throw new Error("Document size mismatch");
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const part of response.Body as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(part); length += chunk.length;
      if (length > maxDocumentBytes || length > size) throw new Error("Document exceeds expected size");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== size || createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Document integrity mismatch");
    return bytes;
  } catch { throw generateError("Document storage is unavailable or the file failed its integrity check. Try again later.", 503); }
  finally { connection.destroy(); }
}

export async function deletePrivateDocument(input: PrivateObjectReference) {
  const { config, Bucket, Key } = reference(input), connection = client(config);
  try { await connection.send(new DeleteObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(20000) }); }
  catch { throw generateError("Document cleanup is pending because storage is unavailable", 503); }
  finally { connection.destroy(); }
}

/** Approved erasure needs positive absence verification, not merely an accepted DELETE. */
export async function erasePrivateDocument(input: PrivateObjectReference) {
  const { config, Bucket, Key } = reference(input), connection = client(config);
  try {
    await connection.send(new DeleteObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(20000) });
    try { await connection.send(new HeadObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(20000) }); }
    catch (error: any) { if (error.$metadata?.httpStatusCode === 404) return; throw error; }
    throw new Error("Stored object is still present");
  } catch { throw generateError("Stored content erasure could not be verified. Retry after checking storage.", 503); }
  finally { connection.destroy(); }
}
