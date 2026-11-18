import { createHash } from "crypto";
import mongoose from "mongoose";
import { OnboardingPolicy as Policy, OnboardingPolicyVersion as Version, OnboardingPolicyAudit as Audit } from "../../schemas/Onboarding/OnboardingPolicy.schema";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { templateContext } from "./onboardingTemplate.service";
import { objectId, pagination, searchRegex, text } from "./onboardingTemplate.utils";
import { assertPolicyIntegrity, normalizePolicy, policyContent, policyHash } from "./onboardingPolicy.utils";

type Context = ReturnType<typeof templateContext>;
const summary = (record: any) => ({ _id: record._id, name: record.name, description: record.description, status: record.status, hasDraft: record.hasDraft, revision: record.revision, publishedVersion: record.publishedVersion, updatedAt: record.updatedAt });
async function find(ctx: Context, value: any, session?: mongoose.ClientSession) {
  const record: any = await Policy.findOne({ _id: objectId(value, "policy id"), company: ctx.company }).session(session || null).lean();
  if (!record) throw generateError("Onboarding policy not found", 404);
  return record;
}
function read(fn: (req: any, ctx: Context) => Promise<any>) {
  return async (req: any, res: any, next: any) => { try { res.json({ success: true, ...await fn(req, templateContext(req)) }); } catch (error) { next(error); } };
}
export const listOnboardingPolicies = read(async (req, ctx) => {
  const { page, limit, skip } = pagination(req.query), status = req.query.status || "all", search = searchRegex(req.query.search);
  if (!["all", "draft", "published", "archived"].includes(status)) throw generateError("Invalid policy status", 400);
  const match = { company: ctx.company, ...(status === "all" ? {} : { status }), ...(search ? { name: search } : {}) };
  const rows = await Policy.find(match).select("name description status hasDraft revision publishedVersion updatedAt").sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit).lean();
  const total = await Policy.countDocuments(match);
  return { data: rows, canManage: hasPermission(ctx.actor, PERMISSION_KEYS.MANAGE_ONBOARDING_TEMPLATES), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});
export const getOnboardingPolicy = read(async (req, ctx) => ({ data: await find(ctx, req.params.policyId) }));
/** Options expose the published title/version, never an unpublished draft renamed by HR. */
export const onboardingPolicyOptions = read(async (req, ctx) => {
  const { page, limit, skip } = pagination(req.query), search = searchRegex(req.query.search);
  const [result] = await Policy.aggregate([
    { $match: { company: ctx.company, status: "published", publishedVersion: { $gte: 1 } } },
    { $lookup: { from: Version.collection.name, let: { policy: "$_id", version: "$publishedVersion" }, pipeline: [
      { $match: { company: ctx.company, $expr: { $and: [{ $eq: ["$policy", "$$policy"] }, { $eq: ["$version", "$$version"] }] } } },
      { $project: { version: 1, "content.name": 1 } },
    ], as: "published" } }, { $unwind: "$published" },
    ...(search ? [{ $match: { "published.content.name": search } }] : []),
    { $facet: { data: [{ $sort: { "published.content.name": 1, _id: 1 } }, { $skip: skip }, { $limit: limit }, { $project: { _id: "$published._id", policy: "$_id", name: "$published.content.name", version: "$published.version" } }], total: [{ $count: "value" }] } },
  ]);
  const total = result?.total[0]?.value || 0;
  return { data: result?.data || [], pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});
export const onboardingPolicyHistory = (kind: "versions" | "audit") => read(async (req, ctx) => {
  const policy = await find(ctx, req.params.policyId), { page, limit, skip } = pagination(req.query), model = kind === "versions" ? Version : Audit;
  const match = { company: ctx.company, policy: policy._id };
  const rows = await model.find(match).select(kind === "versions" ? "version content.name publishedBy reason createdAt" : "actorName action reason before after createdAt").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean();
  const total = await model.countDocuments(match);
  return { data: rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});
export const getPublishedOnboardingPolicy = read(async (req, ctx) => {
  const policy = await find(ctx, req.params.policyId);
  const record: any = await Version.findOne({ _id: objectId(req.params.versionId, "policy version"), policy: policy._id, company: ctx.company }).lean();
  if (!record) throw generateError("Published policy version not found", 404);
  assertPolicyIntegrity(record);
  return { data: record };
});

type Action = "created" | "updated" | "published" | "discarded" | "archived" | "restored";
/** Draft changes are separate from immutable publications; exact retries cannot republish a new version. */
export const mutateOnboardingPolicy = (action: Action) => async (req: any, res: any, next: any) => {
  try {
    const ctx = templateContext(req, true), body = req.body || {};
    await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: String(ctx.company), actionLabel: "manage onboarding policies" });
    for (const model of [Policy, Version, Audit]) await model.init();
    const requestId = text(body.requestId, "Request id", 8, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 422);
    const reason = action === "created" ? "Created onboarding policy draft" : text(body.reason, "Change reason", 3, 1000);
    const content = ["created", "updated"].includes(action) ? normalizePolicy(body) : null;
    const revision = body.revision;
    if (action !== "created" && (!Number.isSafeInteger(revision) || revision < 1)) throw generateError("Load the current policy revision first", 422);
    const target = action === "created" ? null : objectId(req.params.policyId, "policy id");
    const requestHash = createHash("sha256").update(JSON.stringify({ action, target, content, revision, reason })).digest("hex");
    let id: any, replayed = false;
    const replay = async (session?: mongoose.ClientSession) => {
      const previous: any = await Audit.findOne({ company: ctx.company, actor: ctx.actor._id, requestId }).select("+requestHash").session(session || null).lean();
      if (!previous) return false;
      if (previous.requestHash !== requestHash) throw generateError("Request id already used for another policy change", 409);
      id = previous.policy; replayed = true; return true;
    };
    try { await mongoose.connection.transaction(async (session) => {
      if (await replay(session)) return;
      const before = target ? await find(ctx, String(target), session) : null;
      if (before && before.revision !== revision) throw generateError("Policy changed. Reload before saving again.", 409);
      if (before?.status === "archived" && action !== "restored") throw generateError("Restore this policy before making changes", 409);
      let changes: any;
      if (content) changes = { ...content, nameKey: content.name.toLowerCase(), hasDraft: true };
      else if (action === "published") {
        if (!before.hasDraft) throw generateError("There is no policy draft to publish", 409);
        const published = normalizePolicy(before), version = before.publishedVersion + 1;
        await Version.create([{ company: ctx.company, policy: before._id, version, content: published, contentHash: policyHash(published), reason, publishedBy: ctx.actor._id }], { session });
        changes = { status: "published", hasDraft: false, publishedVersion: version };
      } else if (action === "discarded") {
        if (!before.hasDraft || !before.publishedVersion) throw generateError("There is no published version to restore this draft from", 409);
        const version: any = await Version.findOne({ company: ctx.company, policy: before._id, version: before.publishedVersion }).session(session).lean();
        assertPolicyIntegrity(version);
        changes = { ...policyContent(version.content), nameKey: version.content.name.toLowerCase(), hasDraft: false };
      } else if (action === "archived") changes = { status: "archived" };
      else {
        if (before.status !== "archived") throw generateError("Only archived policies can be restored", 409);
        changes = { status: before.publishedVersion ? "published" : "draft" };
      }
      const after: any = before ? await Policy.findOneAndUpdate({ _id: before._id, company: ctx.company, revision }, { $set: { ...changes, updatedBy: ctx.actor._id }, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean()
        : (await Policy.create([{ company: ctx.company, ...changes, createdBy: ctx.actor._id, updatedBy: ctx.actor._id }], { session }))[0].toObject();
      if (!after) throw generateError("Policy changed. Reload before saving again.", 409);
      id = after._id;
      await Audit.create([{ company: ctx.company, policy: id, actor: ctx.actor._id, actorName: ctx.actor.name || "HR", action, reason, requestId, requestHash, before: before ? summary(before) : null, after: summary(after) }], { session });
    }); } catch (error: any) {
      if (error.code !== 11000) throw error;
      if (!await replay()) throw generateError("A policy with that name already exists, or its publication changed. Reload first.", 409);
    }
    res.status(action === "created" && !replayed ? 201 : 200).json({ success: true, data: await find(ctx, String(id)), replayed });
  } catch (error) { next(error); }
};
