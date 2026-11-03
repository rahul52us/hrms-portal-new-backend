import mongoose, { ClientSession } from "mongoose";
import { createHash } from "crypto";
import { generateError } from "../../config/Error/functions";
import Template from "../../schemas/Onboarding/OnboardingTemplate.schema";
import Version from "../../schemas/Onboarding/OnboardingTemplateVersion.schema";
import Audit from "../../schemas/Onboarding/OnboardingTemplateAudit.schema";
import User from "../../schemas/User/User";
import { getEmployeeRequestActor, resolveEmployeeRequestCompanyId } from "../leave/leaveAccess.utils";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { ensurePermission, hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { assertPublishable, normalizeTemplate, objectId, pagination, searchRegex, text } from "./onboardingTemplate.utils";

export function templateContext(req: any, write = false) {
  const actor = getEmployeeRequestActor(req);
  if (actor.role === "superadmin") throw generateError("Onboarding templates are managed from company accounts", 403);
  ensurePermission(actor, PERMISSION_KEYS.VIEW_ONBOARDING_TEMPLATES);
  if (write) ensurePermission(actor, PERMISSION_KEYS.MANAGE_ONBOARDING_TEMPLATES);
  const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId || req.query?.companyId, "onboarding template");
  return { actor, company };
}
type Context = ReturnType<typeof templateContext>;
const activePeople = { deletedAt: null, is_enabled: { $ne: false }, role: { $ne: "superadmin" } };
const content = (value: any) => ({ name: value.name, description: value.description, tasks: value.tasks });
async function find(ctx: Context, value: any, session?: ClientSession) {
  const result: any = await Template.findOne({ company: ctx.company, _id: objectId(value, "template id") }).session(session || null).lean();
  if (!result) throw generateError("Checklist template not found", 404);
  return result;
}
async function validateOwners(ctx: Context, tasks: any[], session: ClientSession) {
  const ids = [...new Set(tasks.filter((task) => task.owner === "specific_user").map((task) => String(task.ownerUser)))];
  if (!ids.length) return;
  const people: any[] = await User.find({ company: ctx.company, ...activePeople, _id: { $in: ids } }).select("_id name code").session(session).lean();
  if (people.length !== ids.length) throw generateError("Choose active task owners from your company", 422);
  const names = new Map(people.map((person) => [String(person._id), person.name || person.code || "Employee"]));
  tasks.forEach((task) => { if (task.owner === "specific_user") task.ownerNameSnapshot = names.get(String(task.ownerUser)); });
}
function read(fn: (req: any, ctx: Context) => Promise<any>) {
  return async (req: any, res: any, next: any) => {
    try { res.json({ success: true, ...await fn(req, templateContext(req)) }); } catch (error) { next(error); }
  };
}
export const templateOptions = read(async (_req, ctx) => ({ data: { canManage: hasPermission(ctx.actor, PERMISSION_KEYS.MANAGE_ONBOARDING_TEMPLATES) } }));
export const templatePeople = read(async (req, ctx) => {
  ensurePermission(ctx.actor, PERMISSION_KEYS.MANAGE_ONBOARDING_TEMPLATES);
  const { page, limit, skip } = pagination(req.query), search = searchRegex(req.query.search);
  const match = { company: ctx.company, ...activePeople, ...(search ? { $or: [{ name: search }, { code: search }] } : {}) };
  const [data, total] = await Promise.all([User.find(match).select("_id name code").sort({ name: 1, _id: 1 }).skip(skip).limit(limit).lean(), User.countDocuments(match)]);
  return { data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});
export const listTemplates = read(async (req, ctx) => {
  const { page, limit, skip } = pagination(req.query), search = searchRegex(req.query.search), status = req.query.status || "all";
  if (!["all", "draft", "published", "archived"].includes(status)) throw generateError("Invalid template status", 400);
  const match = { company: ctx.company, ...(status !== "all" ? { status } : {}), ...(search ? { name: search } : {}) };
  const [data, total] = await Promise.all([Template.find(match).select("name description status revision publishedVersion hasDraft updatedAt tasks._id").sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), Template.countDocuments(match)]);
  return { data: data.map((row: any) => ({ ...row, taskCount: row.tasks.length, tasks: undefined })), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});
export const getTemplate = read(async (req, ctx) => ({ data: await find(ctx, req.params.templateId) }));
export const templateHistory = (kind: "versions" | "audit") => read(async (req, ctx) => {
  const template = await find(ctx, req.params.templateId), { page, limit, skip } = pagination(req.query);
  const match = { company: ctx.company, template: template._id }, model: any = kind === "versions" ? Version : Audit;
  const [data, total] = await Promise.all([model.find(match).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).populate(kind === "versions" ? "publishedBy" : "actor", "name code").lean(), model.countDocuments(match)]);
  return { data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});

type Action = "created" | "updated" | "published" | "discarded" | "archived" | "restored";
export const mutateTemplate = (action: Action) => async (req: any, res: any, next: any) => {
  let session: ClientSession | undefined;
  try {
    const ctx = templateContext(req, true);
    await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: String(ctx.company), actionLabel: "manage onboarding templates" });
    const requestId = text(req.body?.requestId, "Request id", 8, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 422);
    const hash = createHash("sha256").update(JSON.stringify({ action, target: req.params.templateId || null, body: req.body })).digest("hex");
    const replayMatch = { company: ctx.company, actor: ctx.actor._id, requestId };
    const replay = (entry: any) => {
      if (entry.requestHash !== hash) throw generateError("Request id already used for another change", 409);
      return { data: entry.after, replayed: true };
    };
    let result: any;
    session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const prior = await Audit.findOne(replayMatch).session(session!).lean();
        if (prior) { result = replay(prior); return; }
        const before = action === "created" ? null : await find(ctx, req.params.templateId, session);
        if (before && (!Number.isSafeInteger(req.body.revision) || req.body.revision !== before.revision)) throw generateError("Template changed. Reload before saving again.", 409);
        const reason = action === "created" ? "Created checklist template" : text(req.body.reason, "Change reason", 3, 500);
        if (before?.status === "archived" && action !== "restored") throw generateError("Restore this template before making changes", 409);
        let changes: any;
        if (action === "created" || action === "updated") {
          changes = normalizeTemplate(req.body, before?.tasks);
          await validateOwners(ctx, changes.tasks, session!);
          changes.hasDraft = true;
        } else if (action === "published") {
          assertPublishable(before);
          const tasks = before.tasks.map((task: any) => ({ ...task }));
          await validateOwners(ctx, tasks, session!);
          const version = before.publishedVersion + 1;
          await Version.create([{ company: ctx.company, template: before._id, version, content: { ...content(before), tasks }, reason, publishedBy: ctx.actor._id }], { session });
          changes = { status: "published", hasDraft: false, publishedVersion: version, tasks };
        } else if (action === "discarded") {
          if (!before.publishedVersion || !before.hasDraft) throw generateError("There is no published template to restore the draft from", 409);
          const version: any = await Version.findOne({ company: ctx.company, template: before._id, version: before.publishedVersion }).session(session!).lean();
          if (!version) throw generateError("Published template version is missing", 409);
          changes = { ...content(version.content), nameKey: version.content.name.toLowerCase(), hasDraft: false };
        } else if (action === "archived") changes = { status: "archived" };
        else {
          if (before.status !== "archived") throw generateError("Only archived templates can be restored", 409);
          changes = { status: before.publishedVersion ? "published" : "draft" };
        }
        let after: any;
        if (!before) {
          const [created] = await Template.create([{ ...changes, company: ctx.company, createdBy: ctx.actor._id, updatedBy: ctx.actor._id }], { session });
          after = created.toObject();
        } else {
          after = await Template.findOneAndUpdate({ _id: before._id, company: ctx.company, revision: before.revision }, { $set: { ...changes, updatedBy: ctx.actor._id }, $inc: { revision: 1 } }, { new: true, session, runValidators: true }).lean();
          if (!after) throw generateError("Template changed. Reload before saving again.", 409);
        }
        await Audit.create([{ ...replayMatch, template: after._id, action, requestHash: hash, reason, before, after }], { session });
        result = { data: after, replayed: false };
      });
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      const prior = await Audit.findOne(replayMatch).lean();
      if (prior) result = replay(prior);
      else throw generateError("A checklist template with this name already exists", 409);
    }
    res.status(action === "created" ? 201 : 200).json({ success: true, ...result });
  } catch (error) { next(error); } finally { await session?.endSession(); }
};
