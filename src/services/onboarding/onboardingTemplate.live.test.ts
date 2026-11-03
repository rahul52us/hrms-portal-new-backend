import "dotenv/config";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { spawn, ChildProcess } from "node:child_process";
import { createServer, Server } from "node:net";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import Template from "../../schemas/Onboarding/OnboardingTemplate.schema";
import Version from "../../schemas/Onboarding/OnboardingTemplateVersion.schema";
import Audit from "../../schemas/Onboarding/OnboardingTemplateAudit.schema";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function run() {
  const root = path.resolve(process.cwd(), ".."), output = path.join(root, "output"); mkdirSync(output, { recursive: true });
  const dbPath = mkdtempSync(path.join(output, ".onboarding-test-mongo-")), mongoPort = await freePort();
  const mongo = spawn(process.env.ONBOARDING_TEST_MONGOD || "C:/Program Files/MongoDB/Server/8.0/bin/mongod.exe", ["--dbpath", dbPath, "--port", String(mongoPort), "--replSet", "hrms-onboarding-test", "--bind_ip", "127.0.0.1", "--logpath", path.join(dbPath, "mongod.log")], { windowsHide: true, stdio: "ignore" });
  let spawnError: Error | undefined; mongo.on("error", (error) => { spawnError = error; });
  let application: Server | undefined;
  const client = new mongoose.mongo.MongoClient(`mongodb://127.0.0.1:${mongoPort}/?directConnection=true`, { serverSelectionTimeoutMS: 10000 });
  const dbName = `hrms_onboarding_test_${new mongoose.Types.ObjectId()}`;
  const company = new mongoose.Types.ObjectId(), otherCompany = new mongoose.Types.ObjectId();
  const hradmin = new mongoose.Types.ObjectId(), admin = new mongoose.Types.ObjectId(), hr = new mongoose.Types.ObjectId(), employee = new mongoose.Types.ObjectId(), other = new mongoose.Types.ObjectId(), disabled = new mongoose.Types.ObjectId(), platform = new mongoose.Types.ObjectId(), viewer = new mongoose.Types.ObjectId();
  const people = [hradmin, admin, hr, employee, other, disabled, platform, viewer];
  process.env.MONGODB_URI = `mongodb://127.0.0.1:${mongoPort}/${dbName}?replicaSet=hrms-onboarding-test`;
  process.env.SECRET_KEY = `onboarding-test-only-${new mongoose.Types.ObjectId()}`;
  let request = 0;
  const requestId = () => `onboarding-test-${++request}`;
  try {
    await client.connect();
    if (spawnError) throw spawnError;
    await client.db("admin").command({ replSetInitiate: { _id: "hrms-onboarding-test", members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }] } });
    for (let n = 0; n < 100; n++) { if ((await client.db("admin").command({ hello: 1 })).isWritablePrimary) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    assert.match(mongoose.connection.name, /^hrms_onboarding_test_/);
    await Promise.all([Template.init(), Version.init(), Audit.init()]);
    await Company.collection.insertMany([company, otherCompany].map((_id) => ({ _id, type: "company", companyType: "company", company_name: `Onboarding fixture ${_id}`, companyCode: `ONB-${_id}`, tenantSlug: `onb-${_id}`, tenantUrl: `onb-${_id}.example.test`, departments: [], createdBy: platform, activeUser: admin, is_active: true, createdAt: new Date() })));
    await User.collection.insertMany(people.map((_id, index) => ({ _id, name: ["QA HR Admin", "QA Company Admin", "QA HR", "QA Employee", "Other tenant", "Disabled owner", "Platform", "QA Viewer"][index], code: `ONB-${index}`, username: `onboarding-${_id}@example.test`, password: "isolated-fixture-only", role: index === 0 ? "hradmin" : index === 1 ? "admin" : index === 2 ? "hr" : index === 6 ? "superadmin" : "user", company: index === 4 ? otherCompany : index === 6 ? null : company, is_enabled: index !== 5, deletedAt: null, createdAt: new Date(), ...(index === 7 ? { permissions: { view_onboarding_templates: true } } : {}) })));
    const app = (await import("../../index")).default;
    application = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => application!.once("listening", resolve));
    const base = `http://127.0.0.1:${(application.address() as { port: number }).port}`;
    const token = (who: mongoose.Types.ObjectId) => jwt.sign({ userId: String(who) }, process.env.SECRET_KEY!);
    const call = async (who: mongoose.Types.ObjectId | null, route: string, method = "GET", body?: any, expected = 200) => {
      const response = await fetch(`${base}/api/onboarding${route}`, { method, headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer ${token(who)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json() as any;
      assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
      return data;
    };
    await call(null, "/templates", "GET", undefined, 401);
    for (const who of [employee, hr, platform]) await call(who, "/templates", "GET", undefined, 403);
    await call(hradmin, `/templates?companyId=${otherCompany}`, "GET", undefined, 403);
    const entry = { title: "Complete joining form", instructions: "Provide your personal details", owner: "employee", dueDays: 0, required: true, requiresDocument: false };
    const payload: any = { name: "Engineering checklist", description: "New joiner checklist", tasks: [entry, { ...entry, title: "Collect identity proof", dueDays: -3, requiresDocument: true }, { ...entry, title: "Issue laptop", owner: "specific_user", ownerUser: String(employee), dueDays: 1 }] };
    const createBody = { ...payload, requestId: requestId() };
    let saved = (await call(hradmin, "/templates", "POST", createBody, 201)).data;
    const id = saved._id;
    assert.equal(saved.status, "draft"); assert.equal(saved.tasks[2].ownerNameSnapshot, "QA Employee");
    assert.equal((await call(hradmin, "/templates", "POST", createBody, 201)).replayed, true);
    await call(hradmin, "/templates", "POST", { ...createBody, name: "Changed retry" }, 409);
    await call(hradmin, "/templates", "POST", { ...payload, name: "engineering CHECKLIST", requestId: requestId() }, 409);
    await call(viewer, "/templates", "POST", { ...payload, requestId: requestId() }, 403);
    await call(viewer, "/people", "GET", undefined, 403);
    const listed = await call(viewer, "/templates?limit=1"); assert.equal(listed.data[0].taskCount, 3); assert.equal(listed.pagination.limit, 1);
    assert.equal((await call(hradmin, "/people?search=QA&limit=2")).data.length, 2);
    assert.equal((await call(hradmin, "/people?search=Other")).pagination.total, 0);
    await call(other, `/templates/${id}`, "GET", undefined, 403);
    await User.collection.updateOne({ _id: other }, { $set: { permissions: { view_onboarding_templates: true, manage_onboarding_templates: true } } });
    await call(other, `/templates/${id}`, "GET", undefined, 404);
    await call(other, `/templates/${id}/publish`, "POST", { revision: 1, reason: "Tenant takeover", requestId: requestId() }, 404);
    await call(hradmin, "/templates?limit=51", "GET", undefined, 400);
    for (const ownerUser of [String(other), String(disabled)]) await call(hradmin, "/templates", "POST", { ...payload, name: `Bad owner ${ownerUser}`, tasks: [{ ...entry, owner: "specific_user", ownerUser }], requestId: requestId() }, 422);
    const empty = (await call(admin, "/templates", "POST", { name: "Empty draft", tasks: [], requestId: requestId() }, 201)).data;
    await call(admin, `/templates/${empty._id}/publish`, "POST", { revision: 1, reason: "Cannot publish empty", requestId: requestId() }, 422);
    saved = (await call(hradmin, `/templates/${id}/publish`, "POST", { revision: saved.revision, reason: "Ready for new joiners", requestId: requestId() })).data;
    assert.equal(saved.publishedVersion, 1); assert.equal(saved.hasDraft, false);
    const original: any = await Version.findOne({ company, template: id, version: 1 }).lean();
    const frozen = JSON.stringify(original.content);
    await assert.rejects(Version.updateOne({ _id: original._id }, { $set: { reason: "Tamper" } }));
    await assert.rejects(Audit.deleteMany({ company }));
    await call(hradmin, `/templates/${id}`, "PUT", { ...payload, revision: 1, reason: "Stale revision", requestId: requestId() }, 409);
    const revised = { name: "Engineering checklist", description: "Updated instructions", tasks: saved.tasks.map((item: any) => ({ ...item, title: `${item.title} v2` })) };
    saved = (await call(hradmin, `/templates/${id}`, "PUT", { ...revised, revision: saved.revision, reason: "Update for the next intake", requestId: requestId() })).data;
    assert.equal(saved.hasDraft, true); assert.equal(saved.publishedVersion, 1);
    assert.equal(JSON.stringify((await Version.findById(original._id).lean() as any).content), frozen);
    saved = (await call(hradmin, `/templates/${id}/discard-draft`, "POST", { revision: saved.revision, reason: "Keep the existing checklist", requestId: requestId() })).data;
    assert.equal(saved.tasks[0].title, entry.title); assert.equal(saved.hasDraft, false);
    const updateBase = saved.revision;
    const updates = await Promise.all(["Version A", "Version B"].map(async (description) => {
      const response = await fetch(`${base}/api/onboarding/templates/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(hradmin)}` }, body: JSON.stringify({ ...revised, description, revision: updateBase, reason: "Concurrent editors", requestId: requestId() }) }); return response.status;
    }));
    assert.deepEqual(updates.sort(), [200, 409]);
    saved = (await call(hradmin, `/templates/${id}`)).data;
    await User.collection.updateOne({ _id: employee }, { $set: { is_enabled: false } });
    await call(hradmin, `/templates/${id}/publish`, "POST", { revision: saved.revision, reason: "Owner no longer active", requestId: requestId() }, 422);
    await User.collection.updateOne({ _id: employee }, { $set: { is_enabled: true } });
    const publishBody = { revision: saved.revision, reason: "Publish revised checklist", requestId: requestId() };
    saved = (await call(hradmin, `/templates/${id}/publish`, "POST", publishBody)).data;
    assert.equal(saved.publishedVersion, 2);
    assert.equal((await call(hradmin, `/templates/${id}/publish`, "POST", publishBody)).replayed, true);
    assert.equal((await call(hradmin, `/templates/${id}/versions`)).pagination.total, 2);
    saved = (await call(hradmin, `/templates/${id}/archive`, "POST", { revision: saved.revision, reason: "Retire checklist", requestId: requestId() })).data;
    await call(hradmin, `/templates/${id}`, "PUT", { ...revised, revision: saved.revision, reason: "Cannot edit archived", requestId: requestId() }, 409);
    saved = (await call(hradmin, `/templates/${id}/restore`, "POST", { revision: saved.revision, reason: "Reopen checklist", requestId: requestId() })).data;
    assert.equal(saved.status, "published"); assert.equal(saved.publishedVersion, 2);
    assert.ok((await call(viewer, `/templates/${id}/audit?limit=2`)).pagination.total >= 8);
    await Company.collection.updateOne({ _id: company }, { $set: { is_active: false } });
    await call(hradmin, `/templates/${id}/archive`, "POST", { revision: saved.revision, reason: "Inactive company", requestId: requestId() }, 403);
    await Company.collection.updateOne({ _id: company }, { $set: { is_active: true } });
    await User.collection.updateOne({ _id: hr }, { $set: { permissions: { view_onboarding_templates: true, manage_onboarding_templates: true } } });
    assert.equal((await call(hr, "/options")).data.canManage, true);
    assert.equal((await call(viewer, "/options")).data.canManage, false);
    const large = await fetch(`${base}/api/onboarding/templates`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(hradmin)}` }, body: JSON.stringify({ name: "x".repeat(270000) }) }); assert.equal(large.status, 413);
    console.log("Onboarding live API passed: auth, delegated/view-only permissions, tenant isolation, validation, owner lookup, retries, stale and concurrent writes, immutable versions/audit, discard, archive/restore and inactive-company/body limits.");
    if (process.argv.includes("--ui")) {
      const child = spawn(process.execPath, [path.join(root, "scripts/verify-onboarding-ui.cjs")], { windowsHide: true, stdio: "inherit", env: { ...process.env, ONBOARDING_TEST_API_URL: base, ONBOARDING_TEST_ADMIN_TOKEN: token(hradmin), ONBOARDING_TEST_VIEWER_TOKEN: token(viewer), ONBOARDING_TEST_TEMPLATE_ID: id } });
      const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", (value) => resolve(value ?? 1)); }); assert.equal(code, 0, "Onboarding browser checks failed");
    }
  } finally {
    if (application) await new Promise<void>((resolve) => application!.close(() => resolve()));
    if (mongoose.connection.readyState === 1 && /^hrms_onboarding_test_/.test(mongoose.connection.name)) {
      for (const model of [Template, Version, Audit]) await model.collection.deleteMany({ company: { $in: [company, otherCompany] } });
      await User.collection.deleteMany({ _id: { $in: people } }); await Company.collection.deleteMany({ _id: { $in: [company, otherCompany] } });
    }
    await mongoose.disconnect();
    try { await client.db("admin").command({ shutdown: 1 }); } catch { /* Shutdown closes its own connection. */ }
    await client.close();
    if (mongo.exitCode === null) { const stopped = new Promise<void>((resolve) => mongo.once("exit", () => resolve())); const timeout = setTimeout(() => mongo.kill(), 3000); await stopped; clearTimeout(timeout); }
    console.log(`Isolated test MongoDB stopped; no real company records changed. Evidence directory: ${dbPath}`);
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
