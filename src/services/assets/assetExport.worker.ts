import { createHash, randomUUID } from "crypto";
import cron from "node-cron";
import mongoose from "mongoose";
import { Asset } from "../../schemas/Assets/Asset.schema";
import { AssetExportJob as Job, AssetExportArtifact as Artifact, AssetExportChunk as Chunk, AssetExportEvent as Event } from "../../schemas/Assets/AssetExport.schema";
import { generateError } from "../../config/Error/functions";
import { assetCsvCell, assetInventoryValues, ASSET_INVENTORY_HEADERS } from "./assetTransfer.utils";
import { idString, inventoryMatch } from "./asset.utils";
import { ASYNC_EXPORT_LIMITS as LIMITS, assertExportOwner, exportEvent } from "./assetExport.utils";
import { cleanupExportArtifact, EXPORT_ARTIFACT_FIELDS, markExportCleanup, stageExportArtifact, uploadExportArtifact } from "./assetExport.storage";

const LEASE_MS = 10 * 60000;
async function claimExport(id: any) {
  const lease = randomUUID(); let job: any = null;
  await mongoose.connection.transaction(async session => {
    job = await Job.findOneAndUpdate({ _id: id, active: true, attempts: { $lt: LIMITS.attempts }, $or: [{ state: "queued" }, { state: "running", leaseUntil: { $lt: new Date() } }] }, { $set: { state: "running", lease, leaseUntil: new Date(Date.now() + LEASE_MS), rows: 0, bytes: 0, error: "", startedAt: new Date() }, $inc: { attempts: 1, revision: 1 } }, { session, new: true }).select("+lease").lean();
    if (job) await exportEvent(job, "started", "Started a new consistent snapshot attempt", session);
  });
  return job;
}

/** A lost lease restarts from a new snapshot/artifact, never appends data from different snapshots. */
export async function runAssetExport(id: any) {
  const job = await claimExport(id); if (!job) return;
  let file: any = null, cursor: any = null;
  const snapshot = mongoose.connection.getClient().startSession({ snapshot: true, causalConsistency: false });
  try {
    const ctx = await assertExportOwner(job); file = await stageExportArtifact(job, job.lease);
    let rows = 0, bytes = 0, sequence = 0, pending = "", pendingBytes = 0, lastCheck = 0; const hash = createHash("sha256"), deadline = Date.now() + 10 * 60000;
    const check = async (force = false) => {
      if (Date.now() > deadline) throw generateError("Export attempt exceeded its time limit. Narrow the filters before trying again.", 422);
      if (!force && Date.now() - lastCheck < 20000) return;
      await assertExportOwner(job);
      const touched = await Job.updateOne({ _id: job._id, company: job.company, state: "running", lease: job.lease, leaseUntil: { $gt: new Date() } }, { $set: { leaseUntil: new Date(Date.now() + LEASE_MS), rows, bytes } });
      if (!touched.matchedCount) throw generateError("Export was cancelled or another worker owns the attempt", 409);
      lastCheck = Date.now();
    };
    const flush = async () => {
      if (!pending) return;
      const data = Buffer.from(pending, "utf8"); bytes += data.length;
      if (bytes > LIMITS.bytes) throw generateError("Export exceeds 128 MB. Narrow the inventory filters; no partial file is available.", 422);
      hash.update(data); await Chunk.create({ company: job.company, artifact: file._id, sequence: sequence++, bytes: data }); pending = ""; pendingBytes = 0;
      await check();
    };
    pending = "\uFEFF" + ASSET_INVENTORY_HEADERS.map(assetCsvCell).join(",") + "\r\n";
    pendingBytes = Buffer.byteLength(pending, "utf8");
    // Snapshot sessions pin the inventory find/getMore reads without a long-running write transaction.
    cursor = Asset.collection.find(inventoryMatch(ctx, job.filters), { session: snapshot, sort: { _id: 1 }, batchSize: 500, limit: LIMITS.rows + 1, maxTimeMS: 480000, projection: { tag: 1, name: 1, category: 1, categoryName: 1, condition: 1, status: 1, brand: 1, model: 1, serialNumber: 1, locationName: 1, holder: 1, openIncident: 1, openService: 1, openWriteOff: 1, writtenOffRecord: 1, internalNotes: 1, createdAt: 1, updatedAt: 1 } });
    for await (const asset of cursor) {
      if (++rows > LIMITS.rows) throw generateError("Export exceeds 100,000 assets. Narrow the filters; no partial file is available.", 422);
      const line = assetInventoryValues(asset).map(assetCsvCell).join(",") + "\r\n", lineBytes = Buffer.byteLength(line, "utf8");
      if (lineBytes > 32768) throw generateError("An inventory row exceeds 32 KB. Correct the oversized display data or narrow the filters.", 422);
      pending += line; pendingBytes += lineBytes;
      if (pendingBytes >= LIMITS.chunkBytes) await flush();
      if (rows % 500 === 0) await check(true);
    }
    await flush(); await check(true);
    const prepared = await Artifact.findOneAndUpdate({ _id: file._id, state: "staged", lease: job.lease }, { $set: { size: bytes, sha256: hash.digest("hex"), chunks: sequence, rows } }, { new: true }).select(EXPORT_ARTIFACT_FIELDS).lean();
    if (!prepared) throw generateError("Export staging changed", 409); file = prepared;
    await uploadExportArtifact(file); await assertExportOwner(job);
    await mongoose.connection.transaction(async session => {
      const saved: any = await Job.findOneAndUpdate({ _id: job._id, company: job.company, state: "running", lease: job.lease, leaseUntil: { $gt: new Date() } }, { $set: { state: "ready", active: false, rows, bytes, artifact: file._id, completedAt: new Date(), expiresAt: new Date(Date.now() + LIMITS.expiresHours * 3600000), lease: null, leaseUntil: null }, $inc: { revision: 1 } }, { session, new: true }).lean();
      if (!saved) throw generateError("Export lease ended before publication", 409);
      const attached = await Artifact.updateOne({ _id: file._id, company: job.company, job: job._id, state: "staged", lease: job.lease }, { $set: { state: "attached" } }, { session });
      if (!attached.matchedCount) throw generateError("Export staging expired before publication", 409);
      await exportEvent(saved, "ready", "Private CSV completed; download expires in 24 hours", session);
    });
    if (file.provider === "r2") { await Chunk.deleteMany({ company: file.company, artifact: file._id }); await Artifact.updateOne({ _id: file._id, state: "attached" }, { $set: { chunksPruned: true } }); }
  } catch (error: any) {
    // Do not leak driver, bucket, credential or raw query errors to job readers.
    const reason = [403, 422].includes(error.statusCode) ? error.message : error.code === 239 ? "Database snapshot expired. Retry to build a new consistent file." : "Export could not finish. Check the worker, database and private storage before retrying.";
    await mongoose.connection.transaction(async session => {
      const failed: any = await Job.findOneAndUpdate({ _id: job._id, state: "running", lease: job.lease }, { $set: { state: "failed", active: false, error: reason, retryable: error.statusCode !== 422, completedAt: new Date(), lease: null, leaseUntil: null }, $inc: { revision: 1 } }, { session, new: true }).lean();
      if (failed) await exportEvent(failed, "failed", reason, session);
    });
  } finally { if (cursor) await cursor.close().catch(() => undefined); await snapshot.endSession(); if (file) await markExportCleanup(file._id).catch(() => undefined); }
}

async function expireAndCleanup() {
  const now = new Date();
  const expired: any[] = await Job.find({ $or: [{ state: "ready", expiresAt: { $lte: now } }, { state: "queued", createdAt: { $lt: new Date(Date.now() - 24 * 3600000) } }, { state: "running", leaseUntil: { $lt: now }, attempts: { $gte: LIMITS.attempts } }] }).select("_id").limit(25).lean();
  for (const candidate of expired) await mongoose.connection.transaction(async session => {
    const job: any = await Job.findById(candidate._id).select("+artifact +leaseUntil").session(session).lean(); if (!job) return;
    const isReady = job.state === "ready" && job.expiresAt <= now, staleQueue = job.state === "queued" && job.createdAt < new Date(Date.now() - 24 * 3600000), exhausted = job.state === "running" && job.leaseUntil < now && job.attempts >= LIMITS.attempts;
    if (!isReady && !staleQueue && !exhausted) return;
    const saved: any = await Job.findOneAndUpdate({ _id: job._id, state: job.state, revision: job.revision }, { $set: { state: exhausted ? "failed" : "expired", active: false, retryable: false, lease: null, leaseUntil: null, ...(exhausted ? { error: "Export worker leases expired after the maximum number of attempts" } : {}) }, $inc: { revision: 1 } }, { session, new: true }).lean();
    if (!saved) return;
    if (job.artifact) await Artifact.updateOne({ _id: job.artifact, company: job.company, state: "attached" }, { $set: { state: "cleanup_pending", cleanupAfter: new Date(Date.now() + 15 * 60000) } }, { session });
    await exportEvent(saved, exhausted ? "failed" : "expired", exhausted ? "Maximum abandoned attempts reached" : "Export access expired; private content queued for cleanup", session);
  });
  const files: any[] = await Artifact.find({ $or: [{ state: "cleanup_pending", cleanupAfter: { $lte: now } }, { state: "staged", createdAt: { $lt: new Date(Date.now() - 24 * 3600000) } }] }).limit(25).lean();
  for (const file of files) await cleanupExportArtifact(file).catch(() => console.warn("Private asset export cleanup remains pending"));
  const retained: any[] = await Artifact.find({ state: "attached", provider: "r2", chunksPruned: false }).select("_id company").sort({ updatedAt: 1 }).limit(25).lean();
  for (const file of retained) { await Chunk.deleteMany({ company: file.company, artifact: file._id }); await Artifact.updateOne({ _id: file._id, state: "attached" }, { $set: { chunksPruned: true } }); }
}
let started = false, running = false;
export async function runAssetExportQueue(maxJobs = 2) {
  if (running) return; running = true;
  try {
    for (const model of [Job, Artifact, Chunk, Event]) await model.init();
    await expireAndCleanup();
    const jobs: any[] = await Job.find({ active: true, attempts: { $lt: LIMITS.attempts }, $or: [{ state: "queued" }, { state: "running", leaseUntil: { $lt: new Date() } }] }).sort({ createdAt: 1, _id: 1 }).select("_id").limit(Math.min(5, Math.max(1, maxJobs))).lean();
    for (const job of jobs) await runAssetExport(job._id);
  } finally { running = false; }
}
export function wakeAssetExports() {
  if (process.env.NODE_ENV === "test" || process.env.VERCEL || process.env.ASSET_EXPORT_WORKER_ENABLED === "false") return;
  setImmediate(() => { void runAssetExportQueue().catch(() => console.error("Asset export worker needs attention")); });
}
export function startAssetExportWorker() {
  if (started || process.env.NODE_ENV === "test" || process.env.ASSET_EXPORT_WORKER_ENABLED === "false") return false;
  started = true; cron.schedule("* * * * *", () => { void runAssetExportQueue().catch(() => console.error("Asset export worker needs attention")); }, { timezone: "UTC" });
  wakeAssetExports(); return true;
}
