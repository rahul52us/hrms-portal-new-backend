import "dotenv/config";
import mongoose from "mongoose";
import Document from "../schemas/Onboarding/OnboardingDocument.schema";
import { abandonOnboardingDocument } from "../services/onboarding/onboardingDocumentStorage";
import File from "../schemas/Storage/PrivateStoredFile.schema";
import { cleanupPrivateStoredFile } from "../services/storage/privateStoredFile.service";

async function run() {
  const apply = process.argv.includes("--apply");
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const candidates: any[] = await Document.find({ storageProvider: "r2", storageStatus: { $in: ["staged", "cleanup_pending"] }, createdAt: { $lt: cutoff } }).sort({ createdAt: 1 }).limit(100).lean();
    const shared: any[] = candidates.length < 100 ? await File.find({ storageStatus: { $in: ["staged", "cleanup_pending"] }, createdAt: { $lt: cutoff } }).sort({ createdAt: 1 }).limit(100 - candidates.length).lean() : [];
    console.log(`${apply ? "Apply" : "Dry run"}: ${candidates.length + shared.length} unfinished private upload(s) older than 24 hours; maximum 100 per run.`);
    let failed = 0;
    for (const document of candidates) {
      console.log(`Document ${document._id}; company ${document.company}; ${document.storageStatus}`);
      if (apply) {
        try { await abandonOnboardingDocument(document._id); }
        catch { failed++; console.warn(`Cleanup deferred for document ${document._id}; retry after checking storage configuration.`); }
      }
    }
    for (const file of shared) {
      console.log(`Private file ${file._id}; company ${file.company}; ${file.storageStatus}`);
      if (apply) {
        try { await cleanupPrivateStoredFile(file._id); }
        catch { failed++; console.warn(`Cleanup deferred for private file ${file._id}; retry after checking storage configuration.`); }
      }
    }
    if (failed) process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
}
run().catch(() => { console.error("Storage cleanup could not finish. Check database and R2 configuration."); process.exitCode = 1; });
