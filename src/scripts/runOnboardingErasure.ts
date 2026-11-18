import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import { Audit, Document, Instance, Policy, Request } from "../services/onboarding/onboardingRetention.utils";
import { erasureWorkFilter, runOnboardingErasureQueue } from "../services/onboarding/onboardingErasure.worker";

/** Explicit operational command: resumes independently approved erasures, never creates or approves requests. */
async function main() {
  try {
    await connectToDatabase();
    for (const model of [Policy, Request, Audit, Document, Instance]) await model.createIndexes();
    const until = Date.now() + 240000;
    do { await runOnboardingErasureQueue(Math.min(15000, until - Date.now())); }
    while (Date.now() < until && await Request.exists(erasureWorkFilter()));
    const failed = await Request.countDocuments({ active: true, status: "failed" });
    console.log(`Approved erasure queue checked. ${failed} failed request(s) need attention. No requests were created or approved.`);
    if (failed) process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
}
main().catch((error) => { console.error("Approved erasure worker failed", error.message); process.exitCode = 1; });
