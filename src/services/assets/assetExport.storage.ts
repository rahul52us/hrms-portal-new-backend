import { createHash } from "crypto";
import { PassThrough, Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import mongoose from "mongoose";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AssetExportArtifact as Artifact, AssetExportChunk as Chunk } from "../../schemas/Assets/AssetExport.schema";
import { generateError } from "../../config/Error/functions";
import { documentStorageProvider, r2Configuration } from "../storage/privateObjectStorage";
import { idString, objectId } from "./asset.utils";
import { ASYNC_EXPORT_LIMITS as LIMITS } from "./assetExport.utils";

export const EXPORT_ARTIFACT_FIELDS = "+storageBucket +storageKey +sha256 +lease";
export function exportStorageKey(company: any, job: any, artifact: any) {
  const ids = [company, job, artifact].map(value => idString(objectId(idString(value), "export storage id")));
  return `companies/${ids[0]}/assets/exports/${ids[1]}/${ids[2]}`;
}
function connection(file: any) {
  const config = r2Configuration();
  if (file.storageBucket !== config.bucket || file.storageKey !== exportStorageKey(file.company, file.job, file._id)) throw generateError("Invalid private export reference", 503);
  return new S3Client({ region: "auto", endpoint: config.endpoint, credentials: config.credentials, forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", requestHandler: { connectionTimeout: 5000, requestTimeout: 300000 } });
}
export async function stageExportArtifact(job: any, lease: string) {
  const _id = new mongoose.Types.ObjectId(), provider = documentStorageProvider();
  return (await Artifact.create({ _id, company: job.company, job: job._id, lease, provider, ...(provider === "r2" ? { storageBucket: r2Configuration().bucket } : {}), storageKey: exportStorageKey(job.company, job._id, _id) })).toObject();
}
/** Chunks are private staging, never a public endpoint; bounded reads keep the complete CSV out of worker memory. */
export async function* exportChunks(file: any): AsyncGenerator<Buffer> {
  let sequence = 0;
  const cursor = Chunk.find({ company: file.company, artifact: file._id }).select("+bytes").sort({ sequence: 1 }).lean().cursor({ batchSize: 2 });
  try {
    for await (const row of cursor) {
      const bytes = Buffer.isBuffer(row.bytes) ? row.bytes : row.bytes?.buffer ? Buffer.from(row.bytes.buffer) : null;
      if (row.sequence !== sequence++ || !bytes?.length || bytes.length > LIMITS.chunkBytes + 32768) throw generateError("Export content failed its integrity check", 503);
      yield bytes;
    }
    if (sequence !== file.chunks) throw generateError("Export content is incomplete", 503);
  } finally { await cursor.close(); }
}
function verify(file: any) {
  let size = 0, pending: Buffer | null = null; const hash = createHash("sha256");
  // Hold the last block until the digest passes so Content-Length clients cannot accept a complete corrupt file.
  return new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; hash.update(chunk); if (size > file.size || size > LIMITS.bytes) return callback(generateError("Export content exceeded its recorded size", 503)); const previous = pending; pending = chunk; callback(null, previous || undefined); }, flush(callback) { if (size !== file.size || hash.digest("hex") !== file.sha256) return callback(generateError("Export content failed its integrity check", 503)); if (pending) this.push(pending); callback(); } });
}
export async function uploadExportArtifact(file: any) {
  if (file.provider === "mongodb") return;
  const client = connection(file), source = Readable.from(exportChunks(file)), body = new PassThrough(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 300000);
  const pumping = pipeline(source, verify(file), body);
  try { await Promise.all([pumping, client.send(new PutObjectCommand({ Bucket: file.storageBucket, Key: file.storageKey, Body: body, ContentLength: file.size, ContentType: "text/csv; charset=utf-8", CacheControl: "private, no-store", Metadata: { sha256: file.sha256 } }), { abortSignal: controller.signal })]); }
  catch { throw generateError("Private export storage is unavailable. Check storage configuration before retrying.", 503); }
  finally { controller.abort(); clearTimeout(timer); source.destroy(); body.destroy(); await pumping.catch(() => undefined); client.destroy(); }
}
export async function markExportCleanup(id: any) {
  // Never detach a winner after an uncertain commit. Grace also lets an already-open bounded transfer finish.
  await Artifact.updateOne({ _id: id, state: "staged" }, { $set: { state: "cleanup_pending", cleanupAfter: new Date(Date.now() + 15 * 60000) } });
}
export async function cleanupExportArtifact(file: any) {
  const claimed: any = await Artifact.findOneAndUpdate({ _id: file._id, state: { $in: ["staged", "cleanup_pending"] } }, { $set: { state: "cleanup_pending" } }, { new: true }).select(EXPORT_ARTIFACT_FIELDS).lean();
  if (!claimed) return;
  if (claimed.storageKey !== exportStorageKey(claimed.company, claimed.job, claimed._id)) throw generateError("Invalid export cleanup reference", 503);
  if (claimed.provider === "r2") { const client = connection(claimed); try { await client.send(new DeleteObjectCommand({ Bucket: claimed.storageBucket, Key: claimed.storageKey }), { abortSignal: AbortSignal.timeout(20000) }); } finally { client.destroy(); } }
  await Chunk.deleteMany({ company: claimed.company, artifact: claimed._id });
  await Artifact.updateOne({ _id: claimed._id, state: "cleanup_pending" }, { $set: { state: "deleted" } });
}
/** No public/signed URL. A corrupt or interrupted stream is aborted rather than saved as a completed CSV. */
export async function streamExportArtifact(file: any, res: any) {
  if (file.state !== "attached" || file.size < 1 || file.size > LIMITS.bytes || file.storageKey !== exportStorageKey(file.company, file.job, file._id)) throw generateError("Export is unavailable", 503);
  let client: S3Client | undefined, source: Readable | undefined; const signal = AbortSignal.timeout(300000);
  try {
    if (file.provider === "r2") {
      client = connection(file);
      const result = await client.send(new GetObjectCommand({ Bucket: file.storageBucket, Key: file.storageKey }), { abortSignal: signal });
      source = result.Body as Readable;
      if (!source || result.ContentLength !== file.size || result.Metadata?.sha256 !== file.sha256) throw generateError("Export failed its integrity check", 503);
    } else source = Readable.from(exportChunks(file));
    res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Content-Length", String(file.size));
    res.setHeader("Content-Disposition", 'attachment; filename="asset-inventory-export.csv"'); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "private, no-store");
    await pipeline(source, verify(file), res, { signal });
  } catch (error) { if (res.headersSent || res.destroyed) res.destroy(); else throw generateError("Private export download is unavailable or failed its integrity check", 503); }
  finally { source?.destroy(); client?.destroy(); }
}
