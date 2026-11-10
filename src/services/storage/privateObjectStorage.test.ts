import assert from "node:assert/strict";
import mongoose from "mongoose";
import Document from "../../schemas/Onboarding/OnboardingDocument.schema";
import { documentStorageProvider, privateDocumentKey, r2Configuration } from "./privateObjectStorage";

const env = { R2_ACCOUNT_ID: "a".repeat(32), R2_BUCKET_NAME: "hrms-private-test", R2_ACCESS_KEY_ID: "test-only", R2_SECRET_ACCESS_KEY: "test-only" };
assert.equal(documentStorageProvider({}), "mongodb");
assert.equal(documentStorageProvider({ HRMS_DOCUMENT_STORAGE: "r2" }), "r2");
assert.throws(() => documentStorageProvider({ HRMS_DOCUMENT_STORAGE: "s3" }));
assert.equal(r2Configuration(env).endpoint, `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
for (const jurisdiction of ["eu", "fedramp", "us"]) {
  const endpoint = `https://${env.R2_ACCOUNT_ID}.${jurisdiction}.r2.cloudflarestorage.com`;
  assert.equal(r2Configuration({ ...env, R2_ENDPOINT: endpoint }).endpoint, endpoint);
}
assert.throws(() => r2Configuration({ ...env, R2_SECRET_ACCESS_KEY: "" }));
for (const endpoint of ["http://127.0.0.1", "https://example.com", "https://example.com@a.r2.cloudflarestorage.com", "https://a.r2.cloudflarestorage.com/?key=x"]) {
  assert.throws(() => r2Configuration({ ...env, R2_ENDPOINT: endpoint }));
}
assert.throws(() => r2Configuration({ ...env, NODE_ENV: "production", R2_TEST_ENDPOINT: "http://localhost:4000/r2" }));
assert.throws(() => r2Configuration({ ...env, NODE_ENV: "test", R2_TEST_ENDPOINT: "http://example.com/r2" }));
assert.equal(r2Configuration({ ...env, NODE_ENV: "test", R2_TEST_ENDPOINT: "http://127.0.0.1:4000/r2" }).endpoint, "http://127.0.0.1:4000/r2");
const ids = Array.from({ length: 4 }, () => String(new mongoose.Types.ObjectId()));
const key = privateDocumentKey(ids[0], ids[1], ids[2], ids[3]);
assert.equal(key, `companies/${ids[0]}/onboarding/${ids[1]}/tasks/${ids[2]}/${ids[3]}`);
assert.throws(() => privateDocumentKey("../tenant", ids[1], ids[2], ids[3]));
const metadata = { company: ids[0], onboarding: ids[1], task: ids[2], uploadedBy: ids[3], name: "identity.pdf", type: "application/pdf", size: 10, sha256: "f".repeat(64) };
assert.ok(new Document(metadata).validateSync()?.errors.bytes, "MongoDB documents must still require bytes");
assert.equal(new Document({ ...metadata, storageProvider: "r2", storageBucket: env.R2_BUCKET_NAME, storageKey: key, storageStatus: "staged" }).validateSync(), undefined);
assert.ok(new Document({ ...metadata, storageProvider: "r2" }).validateSync()?.errors.storageKey);
assert.equal(Document.schema.path("storageKey").options.immutable, true);
console.log("Private R2 storage unit tests passed: explicit provider, secure endpoint/credentials, tenant-safe keys and backward-compatible metadata.");
