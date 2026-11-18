import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import { runAssetWarrantyReminders } from "../services/assets/assetWarranty.worker";
async function main() { try { await connectToDatabase(); console.log(await runAssetWarrantyReminders()); } finally { await mongoose.disconnect(); } }
main().catch(() => { console.error("Asset warranty reminder pass could not finish"); process.exitCode = 1; });
