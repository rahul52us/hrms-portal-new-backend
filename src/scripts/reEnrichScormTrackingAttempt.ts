import mongoose from "mongoose";
import "dotenv/config";

import connectToDatabase from "../db/db";
import { reEnrichScormTrackingAttempt } from "../services/scorm/scormTracking.service";

async function main() {
  const trackingId = String(process.argv[2] || "").trim();

  if (!trackingId) {
    throw new Error("Usage: ts-node src/scripts/reEnrichScormTrackingAttempt.ts <trackingId>");
  }

  await connectToDatabase();

  const result = await reEnrichScormTrackingAttempt(trackingId);
  console.log("[ScormTracking] Re-enrichment result", result);
}

main()
  .catch((error) => {
    console.error("[ScormTracking] Re-enrichment failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect().catch(() => undefined);
    }
  });
