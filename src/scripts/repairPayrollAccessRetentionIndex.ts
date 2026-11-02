import "dotenv/config";
import mongoose from "mongoose";

async function main() {
  const apply = process.argv.includes("--apply"), uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  try {
    await mongoose.connect(uri, { autoIndex: false });
    const collection = mongoose.connection.db.collection("payrollaccesslogs");
    let indexes: any[] = [];
    try { indexes = await collection.indexes(); } catch (error: any) { if (error.code !== 26) throw error; }
    const expiry = indexes.find((index) => Object.keys(index.key).length === 1 && index.key.expiresAt === 1);
    console.log(JSON.stringify({ database: mongoose.connection.name, apply, index: expiry?.name || "missing", expireAfterSeconds: expiry?.expireAfterSeconds ?? null, effect: "Enables expiry at each access log's existing expiresAt; expired access logs may be removed. Financial/audit evidence collections are not changed." }));
    if (!apply || expiry?.expireAfterSeconds === 0) return;
    if (expiry) await mongoose.connection.db.command({ collMod: collection.collectionName, index: { name: expiry.name, expireAfterSeconds: 0 } });
    else await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    console.log("Payroll access-log retention index repaired");
  } finally { await mongoose.disconnect(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
