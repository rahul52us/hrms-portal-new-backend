import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import { runAssetExportQueue } from "../services/assets/assetExport.worker";

/** Trusted external worker entry point; never creates or rewrites company fixture data. */
async function main() {
  try { await connectToDatabase(); await runAssetExportQueue(2); console.log("Asset export worker pass finished"); }
  finally { await mongoose.disconnect(); }
}
main().catch(() => { console.error("Asset export worker could not finish; review export jobs and storage configuration"); process.exitCode = 1; });
