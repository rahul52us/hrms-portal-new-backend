import mongoose, { ClientSession } from "mongoose";
import { createHash } from "crypto";
import { generateError } from "../../config/Error/functions";
import Instance from "../../schemas/Onboarding/EmployeeOnboarding.schema";
import Audit from "../../schemas/Onboarding/EmployeeOnboardingAudit.schema";
import Document from "../../schemas/Onboarding/OnboardingDocument.schema";
import Template from "../../schemas/Onboarding/OnboardingTemplate.schema";
import Version from "../../schemas/Onboarding/OnboardingTemplateVersion.schema";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import { getEmployeeRequestActor, resolveEmployeeRequestCompanyId } from "../leave/leaveAccess.utils";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { attachEffectivePermissions, ensurePermission, hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { createRequestNotifications } from "../notification/notification.service";
import { LEAVE_DOCUMENT_MIME_TYPES, validateUploadSignature } from "../upload/uploadSecurity.utils";
import { objectId, pagination, searchRegex, text } from "./onboardingTemplate.utils";
import { inOnboardingScope, joiningDateKey, managesOnboardingEmployee, onboardingDueDate, onboardingEmployeeScope, onboardingProgress, onboardingStatus, ownsOnboardingTask, terminalTask, validateOnboardingTimezone, valueId, visibleOnboardingTask } from "./employeeOnboarding.utils";
import { documentStorageProvider } from "../storage/privateObjectStorage";
import { attachOnboardingDocument, onboardingDocumentBytes, queueOnboardingDocumentCleanup, stageOnboardingDocument } from "./onboardingDocumentStorage";
import { canManageOnboardingAutomation } from "./onboardingAutomation.service";
import { scanPrivateUpload, UploadScan } from "../storage/malwareScanner";
import { OnboardingPolicyVersion as PolicyVersion, OnboardingPolicyAcknowledgement as PolicyAcknowledgement } from "../../schemas/Onboarding/OnboardingPolicy.schema";
import { assertPolicyIntegrity, resolveTaskPolicies } from "./onboardingPolicy.utils";
import { emptyAssetProvision, initializeOnboardingAssets, releaseOnboardingAssetLinks } from "./onboardingAsset.service";

const activePerson = { deletedAt: null, is_enabled: { $ne: false }, role: { $ne: "superadmin" } };
const employeeFields = "_id company name code joiningDate department team officeLocation reportingManager is_enabled deletedAt";
function context(req: any) {
  const actor = getEmployeeRequestActor(req);
  if (actor.role === "superadmin") throw generateError("Employee onboarding is available from company accounts", 403);
  return { actor, company: resolveEmployeeRequestCompanyId(actor, req.body?.companyId || req.query?.companyId, "onboarding") };
}
type Context = ReturnType<typeof context>;
const manages = (ctx: Context, employee: any) => managesOnboardingEmployee(ctx.actor, employee);
const owns = (ctx: Context, task: any, employee: any) => ownsOnboardingTask(ctx.actor, employee, task);
const visibleTask = (ctx: Context, employee: any, task: any) => visibleOnboardingTask(ctx.actor, employee, task);
async function employeeFor(ctx: Context, employeeId: any, session?: ClientSession) {
  const employee: any = await User.findOne({ _id: objectId(valueId(employeeId), "employee id"), company: ctx.company, role: { $ne: "superadmin" } }).select(employeeFields).session(session || null).lean();
  if (!employee) throw generateError("Employee not found", 404);
  return employee;
}
async function instanceFor(ctx: Context, instanceId: any, session?: ClientSession) {
  const instance: any = await Instance.findOne({ _id: objectId(instanceId, "onboarding id"), company: ctx.company }).session(session || null).lean();
  if (!instance) throw generateError("Onboarding checklist not found", 404);
  const employee = await employeeFor(ctx, instance.employee, session);
  if (valueId(employee) !== valueId(ctx.actor) && !instance.tasks.some((task: any) => owns(ctx, task, employee)) && !inOnboardingScope(ctx.actor, employee)) throw generateError("Onboarding checklist not found", 404);
  return { instance, employee };
}
function dto(ctx: Context, instance: any, employee: any) {
  const manage = manages(ctx, employee), actionable = instance.status !== "cancelled";
  const canReview = manage && valueId(employee) !== valueId(ctx.actor);
  const tasks = instance.tasks.filter((task: any) => visibleTask(ctx, employee, task)).map((task: any) => ({ ...task,
    overdue: actionable && !terminalTask(task) && new Date(task.dueAt) < new Date(),
    canComplete: actionable && !["policy_acknowledgement", "asset_provisioning"].includes(task.kind) && owns(ctx, task, employee) && task.status === "pending",
    canAcknowledge: actionable && task.kind === "policy_acknowledgement" && valueId(employee) === valueId(ctx.actor) && owns(ctx, task, employee) && task.status === "pending",
    canUpload: actionable && !["policy_acknowledgement", "asset_provisioning"].includes(task.kind) && owns(ctx, task, employee) && task.requiresDocument && task.status === "pending" && task.documents.length < 5,
    canRemoveDocument: actionable && !["policy_acknowledgement", "asset_provisioning"].includes(task.kind) && owns(ctx, task, employee) && task.requiresDocument && task.status === "pending",
    canReview: actionable && !["policy_acknowledgement", "asset_provisioning"].includes(task.kind) && canReview && task.status === "pending_review" && !task.documents.some((document: any) => valueId(document.uploadedBy) === valueId(ctx.actor)),
    canWaive: actionable && canReview && !terminalTask(task),
    canReopen: actionable && canReview && terminalTask(task),
    canReassign: actionable && task.kind !== "policy_acknowledgement" && manage && ["pending", "blocked"].includes(task.status),
  }));
  return { _id: instance._id, employee: { _id: employee._id, name: employee.name, code: employee.code, joiningDate: employee.joiningDate || null }, template: instance.template,
    templateVersion: instance.templateVersion, templateName: instance.templateName, templateDescription: instance.templateDescription, versionNumber: instance.versionNumber,
    joiningDate: instance.joiningDate, timezone: instance.timezone, joiningDateChanged: Boolean(employee.joiningDate && joiningDateKey(employee.joiningDate) !== instance.joiningDate),
    status: instance.status, revision: instance.revision, progress: onboardingProgress(instance.tasks), tasks, createdAt: instance.createdAt, updatedAt: instance.updatedAt,
    canManage: manage, canCancel: actionable && manage && valueId(employee) !== valueId(ctx.actor), canReschedule: actionable && manage };
}
function read(fn: (req: any, ctx: Context) => Promise<any>) {
  return async (req: any, res: any, next: any) => { try { res.json({ success: true, ...await fn(req, context(req)) }); } catch (error) { next(error); } };
}
function ensureManager(ctx: Context) {
  ensurePermission(ctx.actor, PERMISSION_KEYS.VIEW_ONBOARDING);
  ensurePermission(ctx.actor, PERMISSION_KEYS.MANAGE_ONBOARDING);
}
export const onboardingWorkspace = read(async (_req, ctx) => ({ data: {
  canView: hasPermission(ctx.actor, PERMISSION_KEYS.VIEW_ONBOARDING), canManage: hasPermission(ctx.actor, PERMISSION_KEYS.MANAGE_ONBOARDING),
  canViewTemplates: hasPermission(ctx.actor, PERMISSION_KEYS.VIEW_ONBOARDING_TEMPLATES),
  canManageAutomation: canManageOnboardingAutomation(ctx.actor),
  canManageDocumentSecurity: canManageOnboardingAutomation(ctx.actor),
  scopes: ["mine", "tasks", ...(hasPermission(ctx.actor, PERMISSION_KEYS.VIEW_ONBOARDING) ? ["organization"] : [])],
} }));
export const onboardingEmployees = read(async (req, ctx) => {
  ensureManager(ctx);
  const { page, limit, skip } = pagination(req.query), search = searchRegex(req.query.search);
  const match = { $and: [{ company: ctx.company, ...activePerson, ...(req.query.employeeId ? { _id: objectId(req.query.employeeId, "employee id") } : {}) }, onboardingEmployeeScope(ctx.actor, PERMISSION_KEYS.MANAGE_ONBOARDING), ...(search ? [{ $or: [{ name: search }, { code: search }] }] : [])] };
  const [data, total] = await Promise.all([User.find(match).select("_id name code joiningDate").sort({ name: 1, _id: 1 }).skip(skip).limit(limit).lean(), User.countDocuments(match)]);
  return { data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});
export const onboardingOwners = read(async (req, ctx) => {
  ensureManager(ctx);
  const employee = await employeeFor(ctx, req.query.employeeId);
  if (!manages(ctx, employee)) throw generateError("Employee is outside your onboarding scope", 403);
  const { page, limit, skip } = pagination(req.query), search = searchRegex(req.query.search);
  const match = { company: ctx.company, ...activePerson, ...(search ? { $or: [{ name: search }, { code: search }] } : {}) };
  const [data, total] = await Promise.all([User.find(match).select("_id name code").sort({ name: 1, _id: 1 }).skip(skip).limit(limit).lean(), User.countDocuments(match)]);
  return { data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});
export const onboardingPublishedTemplates = read(async (req, ctx) => {
  ensureManager(ctx);
  const { page, limit, skip } = pagination(req.query), search = searchRegex(req.query.search);
  const stages: any[] = [{ $match: { company: ctx.company, status: "published", publishedVersion: { $gte: 1 } } },
    { $lookup: { from: "onboardingtemplateversions", let: { template: "$_id", version: "$publishedVersion" }, pipeline: [{ $match: { company: ctx.company, $expr: { $and: [{ $eq: ["$template", "$$template"] }, { $eq: ["$version", "$$version"] }] } } }], as: "published" } },
    { $unwind: "$published" }, ...(search ? [{ $match: { "published.content.name": search } }] : [])];
  const [result] = await Template.aggregate([...stages, { $facet: { data: [{ $sort: { "published.content.name": 1, _id: 1 } }, { $skip: skip }, { $limit: limit }, { $project: { _id: 0, template: "$_id", templateVersion: "$published._id", version: "$published.version", name: "$published.content.name", taskCount: { $size: "$published.content.tasks" } } }], count: [{ $count: "total" }] } }]);
  const total = result.count[0]?.total || 0;
  return { data: result.data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});
export const listEmployeeOnboarding = read(async (req, ctx) => {
  const scope = req.query.scope || "mine", status = req.query.status || "all", { page, limit, skip } = pagination(req.query);
  if (!["mine", "tasks", "organization"].includes(scope) || !["all", "active", "completed", "cancelled"].includes(status)) throw generateError("Invalid onboarding filter", 400);
  if (scope === "organization") ensurePermission(ctx.actor, PERMISSION_KEYS.VIEW_ONBOARDING);
  if (req.query.overdue !== undefined && !["true", "false"].includes(req.query.overdue)) throw generateError("Invalid overdue filter", 400);
  const match: any = { company: ctx.company, ...(status !== "all" ? { status } : {}), ...(scope === "mine" ? { employee: ctx.actor._id } : scope === "tasks" ? { "tasks.assignees.user": ctx.actor._id } : {}) };
  if (req.query.employeeId) match.employee = objectId(req.query.employeeId, "employee id");
  if (scope === "mine" && req.query.employeeId && valueId(ctx.actor) !== req.query.employeeId) throw generateError("Use your own onboarding scope", 403);
  if (req.query.overdue === "true") { match.status = status === "cancelled" ? "__none__" : status === "all" ? { $in: ["active", "completed"] } : status; match.tasks = { $elemMatch: { status: { $in: ["pending", "blocked", "pending_review"] }, dueAt: { $lt: new Date() }, ...(scope !== "organization" ? { "assignees.user": ctx.actor._id } : {}) } }; }
  const employeeScope = scope === "organization" ? onboardingEmployeeScope(ctx.actor) : {};
  const queueScope = Object.fromEntries(Object.entries(onboardingEmployeeScope(ctx.actor, PERMISSION_KEYS.MANAGE_ONBOARDING)).map(([key, value]) => [`employeeRecord.${key}`, value]));
  const taskAccess = scope === "tasks" ? [{ $match: { $or: [
    { tasks: { $elemMatch: { "assignees.user": ctx.actor._id, $or: [{ owner: { $ne: "hr" } }, { ownerResolution: "manual" }] } } },
    ...(hasPermission(ctx.actor, PERMISSION_KEYS.VIEW_ONBOARDING) ? [queueScope] : []),
  ] } }] : [];
  const search = searchRegex(req.query.search);
  const [result] = await Instance.aggregate([{ $match: match },
    { $lookup: { from: "users", let: { employee: "$employee" }, pipeline: [{ $match: { $and: [{ company: ctx.company, $expr: { $eq: ["$_id", "$$employee"] } }, employeeScope] } }, { $project: { name: 1, code: 1, joiningDate: 1, department: 1, team: 1, officeLocation: 1, reportingManager: 1 } }], as: "employeeRecord" } },
    { $unwind: "$employeeRecord" }, ...taskAccess, ...(search ? [{ $match: { $or: [{ "employeeRecord.name": search }, { "employeeRecord.code": search }] } }] : []),
    { $facet: { data: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit }], count: [{ $count: "total" }] } }]);
  const total = result.count[0]?.total || 0;
  return { data: result.data.map((row: any) => { const value = dto(ctx, row, row.employeeRecord); return { ...value, tasks: undefined, assignedTaskCount: value.tasks.length }; }), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});
export const getEmployeeOnboarding = read(async (req, ctx) => { const { instance, employee } = await instanceFor(ctx, req.params.instanceId); return { data: dto(ctx, instance, employee) }; });
async function assignedPolicy(ctx: Context, instanceId: any, taskId: any, session?: ClientSession) {
  const { instance, employee } = await instanceFor(ctx, instanceId, session);
  const task = instance.tasks.find((item: any) => valueId(item) === valueId(objectId(taskId, "task id")));
  if (!task || task.kind !== "policy_acknowledgement" || !visibleTask(ctx, employee, task)) throw generateError("Assigned policy not found", 404);
  const version: any = await PolicyVersion.findOne({ _id: task.policySnapshot?.policyVersion, policy: task.policySnapshot?.policy, company: ctx.company }).session(session || null).lean();
  assertPolicyIntegrity(version);
  if (version.contentHash !== task.policySnapshot?.contentHash) throw generateError("Assigned policy version could not be verified", 503);
  return { instance, employee, task, version };
}
/** Employee reads are bound to a visible assigned task, not a company-wide policy-library permission. */
export const getAssignedOnboardingPolicy = read(async (req, ctx) => {
  const { instance, employee, task, version } = await assignedPolicy(ctx, req.params.instanceId, req.params.taskId);
  return { data: { policyVersionId: version._id, version: version.version, ...version.content, contentHash: version.contentHash, publishedAt: version.createdAt,
    cycle: task.acknowledgementCycle || 1, onboardingRevision: instance.revision, acknowledgement: task.acknowledgement || null,
    canAcknowledge: dto(ctx, instance, employee).tasks.find((item: any) => valueId(item) === valueId(task))?.canAcknowledge || false } };
});
export const listOnboardingPolicyAcknowledgements = read(async (req, ctx) => {
  const { instance, task } = await assignedPolicy(ctx, req.params.instanceId, req.params.taskId), { page, limit, skip } = pagination(req.query);
  const match = { company: ctx.company, onboarding: instance._id, task: task._id };
  const rows = await PolicyAcknowledgement.find(match).select("employeeName employeeCode policyName version statement cycle acknowledgedAt").sort({ cycle: -1, _id: -1 }).skip(skip).limit(limit).lean();
  const total = await PolicyAcknowledgement.countDocuments(match);
  return { data: rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});
export const employeeOnboardingHistory = read(async (req, ctx) => {
  const { instance, employee } = await instanceFor(ctx, req.params.instanceId), { page, limit, skip } = pagination(req.query);
  const visibleIds = instance.tasks.filter((task: any) => visibleTask(ctx, employee, task)).map((task: any) => task._id);
  const match = { company: ctx.company, onboarding: instance._id, ...(!inOnboardingScope(ctx.actor, employee) ? { $or: [{ task: { $in: visibleIds } }, { task: null }] } : {}) };
  const [data, total] = await Promise.all([Audit.find(match).select("action reason actorName task createdAt").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), Audit.countDocuments(match)]);
  return { data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});

async function activeOwners(ctx: Context, ids: any[], session: ClientSession) {
  return User.find({ company: ctx.company, ...activePerson, _id: { $in: ids } }).select("_id name code role company permissions accessRole hrScope department team officeLocation").session(session).lean() as Promise<any[]>;
}
async function initialTasks(ctx: Context, content: any, employee: any, joiningDate: string, timezone: string, session: ClientSession) {
  const policies = await resolveTaskPolicies(ctx.company, content.tasks, session);
  const ids = [...new Set(content.tasks.flatMap((task: any) => task.owner === "specific_user" ? [valueId(task.ownerUser)] : task.owner === "reporting_manager" && employee.reportingManager ? [valueId(employee.reportingManager)] : []))];
  const people = new Map((await activeOwners(ctx, ids, session)).map((person: any) => [valueId(person), person]));
  const company = await Company.findById(ctx.company).select("rolePermissions").session(session).lean();
  const candidates: any[] = content.tasks.some((task: any) => task.owner === "hr") ? await User.find({ company: ctx.company, ...activePerson, role: { $in: ["admin", "hradmin", "hr"] } }).select("_id name code role company permissions accessRole hrScope").limit(101).session(session).lean() : [];
  if (candidates.length > 100) throw generateError("HR queue has too many candidates; use a specific-person template task", 422);
  const hr = candidates.filter((person) => valueId(person) !== valueId(employee) && inOnboardingScope(attachEffectivePermissions({ user: person, company }), employee, PERMISSION_KEYS.MANAGE_ONBOARDING));
  return content.tasks.map((task: any) => {
    const policy = task.kind === "policy_acknowledgement" ? policies.get(valueId(task.policyVersionId)) : null;
    let owners: any[] = task.owner === "employee" ? [employee] : task.owner === "hr" ? hr : [people.get(task.owner === "reporting_manager" ? valueId(employee.reportingManager) : valueId(task.ownerUser))].filter(Boolean);
    if (task.owner === "reporting_manager") owners = owners.filter((person) => valueId(person) !== valueId(employee));
    if (task.kind === "asset_provisioning") owners = owners.filter((person) => {
      const actor = attachEffectivePermissions({ user: person, company });
      return valueId(person) !== valueId(employee) && hasPermission(actor, PERMISSION_KEYS.VIEW_ASSETS) && hasPermission(actor, PERMISSION_KEYS.MANAGE_ASSETS);
    });
    return { _id: new mongoose.Types.ObjectId(), templateTask: task._id, title: task.title, instructions: task.instructions, owner: task.owner, dueDays: task.dueDays,
      kind: task.kind || "standard", policySnapshot: policy ? { policy: policy.policy, policyVersion: policy._id, name: policy.content.name, version: policy.version, contentHash: policy.contentHash, acknowledgementText: policy.content.acknowledgementText } : null,
      assetRequirement: task.kind === "asset_provisioning" ? task.assetRequirement : null,
      assetProvision: task.kind === "asset_provisioning" ? emptyAssetProvision(task) : null,
      required: task.required, requiresDocument: task.requiresDocument, ...onboardingDueDate(joiningDate, task.dueDays, timezone),
      assignees: owners.map((person) => ({ user: person._id, name: person.name || person.code || "Employee" })), status: owners.length ? "pending" : "blocked",
      ownerIssue: owners.length ? "" : task.kind === "asset_provisioning" ? "No eligible owner with View/Manage Assets resolved. HR must grant access or reassign this task." : "No active owner resolved. HR must reassign this task.", documents: [] };
  });
}
async function notify(ctx: Context, instance: any, recipients: any[], event: string, revision: number, session: ClientSession) {
  const unique = [...new Set(recipients.map(valueId).filter(Boolean))];
  if (!unique.length) return;
  await createRequestNotifications({ company: ctx.company, actor: ctx.actor._id, recipients: unique,
    eventType: `onboarding.${event}`, entityType: "employee_onboarding", entityId: instance._id,
    title: event === "assigned" ? "Onboarding checklist assigned" : "Onboarding checklist updated",
    message: `${instance.templateName}: ${instance.employeeNameSnapshot}'s onboarding ${event.replace(/_/g, " ")}.`,
    actionUrl: `/dashboard/onboarding?instanceId=${instance._id}`, dedupeEventKey: `${event}:${revision}` }, session);
}

export type CreationOnboarding = { templateVersionId: string; timezone: string };

/** Multipart imports carry JSON text; single-employee requests carry the same object. */
export function parseCreationOnboarding(value: unknown): CreationOnboarding | null {
  if (value === undefined || value === null || value === "") return null;
  let input: any = value;
  if (typeof value === "string") {
    try { input = JSON.parse(value); }
    catch { throw generateError("Onboarding must be a JSON object", 422); }
  }
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["templateVersionId", "timezone"].includes(key))) throw generateError("Provide an onboarding templateVersionId and timezone", 422);
  return { templateVersionId: valueId(objectId(input.templateVersionId, "published template version")), timezone: validateOnboardingTimezone(input.timezone) };
}

/** Reload permissions from the database: employee-creation permission alone does not grant onboarding management. */
async function creationContext(actorId: any, companyId: any, session?: ClientSession): Promise<Context> {
  const company = objectId(valueId(companyId), "company id");
  const person: any = await User.findOne({ _id: actorId, deletedAt: null, is_enabled: { $ne: false } }).session(session || null).lean();
  if (!person || person.role === "superadmin" || valueId(person.company) !== valueId(company)) throw generateError("Assign onboarding from an authorized company account", 403);
  const settings = await Company.findById(company).select("rolePermissions").session(session || null).lean();
  const actor = getEmployeeRequestActor({ user: attachEffectivePermissions({ user: person, company: settings }) });
  const ctx = { actor, company };
  ensureManager(ctx);
  return ctx;
}

/** Preview never increments the publication fence or creates tasks; commit rechecks the exact selected version. */
export async function previewCreationOnboarding(actorId: any, companyId: any, input: CreationOnboarding) {
  const ctx = await creationContext(actorId, companyId);
  const version: any = await Version.findOne({ _id: input.templateVersionId, company: ctx.company }).lean();
  if (!version) throw generateError("Published checklist version not found", 404);
  const template = await Template.exists({ _id: version.template, company: ctx.company, status: "published", publishedVersion: version.version });
  if (!template) throw generateError("Template was archived or a newer version was published. Refresh choices.", 409);
  return { templateVersionId: valueId(version), name: version.content.name, version: version.version, taskCount: version.content.tasks.length, timezone: input.timezone };
}

/** Shared assignment core: the publication fence makes assignment race safely with publish/archive transactions. */
async function createAssignedChecklist(ctx: Context, employee: any, input: { templateVersionId: any; timezone: any }, session: ClientSession) {
  const version: any = await Version.findOne({ _id: objectId(input.templateVersionId, "published template version"), company: ctx.company }).session(session).lean();
  if (!version) throw generateError("Published checklist version not found", 404);
  const template = await Template.findOneAndUpdate({ _id: version.template, company: ctx.company, status: "published", publishedVersion: version.version }, { $inc: { assignmentFence: 1 } }, { session, new: true, timestamps: false }).lean();
  if (!template) throw generateError("Template was archived or a newer version was published. Refresh choices.", 409);
  const joiningDate = joiningDateKey(employee.joiningDate), timezone = validateOnboardingTimezone(input.timezone);
  const tasks = await initialTasks(ctx, version.content, employee, joiningDate, timezone, session);
  if (!tasks.length) throw generateError("Published checklist has no tasks", 422);
  const [created] = await Instance.create([{ company: ctx.company, employee: employee._id, employeeNameSnapshot: employee.name || employee.code, employeeCodeSnapshot: employee.code || "", template: version.template, templateVersion: version._id, versionNumber: version.version, templateName: version.content.name, templateDescription: version.content.description, joiningDate, timezone, tasks, createdBy: ctx.actor._id, updatedBy: ctx.actor._id }], { session });
  return created.toObject();
}

/** Use only inside the new employee's transaction; a task/audit/notification failure must roll back that employee too. */
export async function assignOnboardingDuringCreation(actorId: any, employee: any, input: CreationOnboarding, session: ClientSession) {
  const ctx = await creationContext(actorId, employee.company, session);
  if (!manages(ctx, employee)) throw generateError("Employee is outside your onboarding scope", 403);
  if (employee.is_enabled === false || employee.deletedAt || employee.role === "superadmin") throw generateError("Assign onboarding to an active company employee", 422);
  const after = await createAssignedChecklist(ctx, employee, input, session);
  const requestId = `employee-create-${employee._id}`;
  const requestHash = createHash("sha256").update(JSON.stringify({ source: "employee_creation", employee: valueId(employee), ...input })).digest("hex");
  await Audit.create([{ company: ctx.company, onboarding: after._id, task: null, actor: ctx.actor._id, actorName: ctx.actor.name || ctx.actor.username || "HR", action: "assigned", reason: "Assigned during employee creation", requestId, requestHash, before: null, after }], { session });
  await notify(ctx, after, [employee._id, ...after.tasks.flatMap((task: any) => task.assignees.map((person: any) => person.user))], "assigned", after.revision, session);
  return { _id: after._id, templateName: after.templateName, versionNumber: after.versionNumber, status: after.status, timezone: after.timezone };
}

const manageActions = ["reassign", "approve", "return", "waive", "reopen", "cancel", "reschedule"];
export const mutateEmployeeOnboarding = (kind: "assign" | "task" | "instance" | "upload") => async (req: any, res: any, next: any) => {
  let session: ClientSession | undefined;
  let stagedDocument: any;
  let scan: UploadScan | undefined;
  try {
    const ctx = context(req), action = kind === "assign" ? "assigned" : kind === "upload" ? "document_uploaded" : req.body?.action;
    if (kind === "task" && !["complete", "acknowledge", "approve", "return", "waive", "reopen", "reassign", "remove_document"].includes(action) || kind === "instance" && !["cancel", "reschedule"].includes(action)) throw generateError("Invalid onboarding action", 422);
    if (action === "acknowledge") await PolicyAcknowledgement.init();
    if (["waive", "reopen", "cancel"].includes(action)) await initializeOnboardingAssets();
    if (kind === "assign" || manageActions.includes(action)) ensureManager(ctx);
    await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: valueId(ctx.company), actionLabel: "update employee onboarding" });
    const requestId = text(req.body.requestId, "Request id", 8, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 422);
    if (kind === "upload") req.body.revision = Number(req.body.revision);
    let file: { buffer: Buffer; mimeType: string; size: number } | null = null;
    if (kind === "upload") {
      if (!req.file) throw generateError("Choose a PDF, JPG or PNG document", 422);
      file = validateUploadSignature({ data: req.file.buffer, declaredMimeType: req.file.mimetype, allowedMimeTypes: LEAVE_DOCUMENT_MIME_TYPES, maxBytes: 5 * 1024 * 1024 });
    }
    const name = file ? text(String(req.file.originalname).replace(/[\\/\r\n\u0000-\u001f"]/g, "_"), "Document name", 1, 150) : "";
    const requestHash = createHash("sha256").update(JSON.stringify({ kind, target: req.params.instanceId, task: req.params.taskId, body: req.body, ...(file ? { name, type: file.mimeType, sha256: createHash("sha256").update(file.buffer).digest("hex") } : {}) })).digest("hex");
    if (file) {
      const { instance, employee } = await instanceFor(ctx, req.params.instanceId);
      const task = instance.tasks.find((item: any) => valueId(item) === valueId(objectId(req.params.taskId, "task id")));
      if (!task || !visibleTask(ctx, employee, task)) throw generateError("Onboarding task not found", 404);
      if (!owns(ctx, task, employee)) throw generateError("Only an assigned task owner can submit it", 403);
      const prior: any = await Audit.findOne({ company: ctx.company, actor: ctx.actor._id, requestId }).lean();
      if (prior) {
        if (prior.requestHash !== requestHash) throw generateError("Request id already used for another onboarding change", 409);
      } else {
        if (!Number.isSafeInteger(req.body.revision) || instance.revision !== req.body.revision) throw generateError("Onboarding changed. Reload before saving again.", 409);
        if (!dto(ctx, instance, employee).tasks.find((item: any) => valueId(item) === valueId(task))?.canUpload) throw generateError("Documents can be uploaded only to your pending document task (maximum five)", 409);
        // Scan outside the transaction so MongoDB retries never repeat network I/O or re-send private bytes.
        if (documentStorageProvider() === "r2") stagedDocument = await stageOnboardingDocument({ company: ctx.company, onboarding: instance._id, task: task._id, uploadedBy: ctx.actor._id, name, type: file.mimeType, bytes: file.buffer });
        else {
          file.buffer = Buffer.from(file.buffer);
          scan = await scanPrivateUpload(file.buffer, { company: ctx.company, uploadedBy: ctx.actor._id, purpose: "onboarding" });
        }
      }
    }
    let result: any;
    session = await mongoose.startSession();
    const process = async () => {
      let before: any = null, originalBefore: any = null, employee: any, task: any = null;
      if (kind === "assign") {
        employee = await employeeFor(ctx, req.body.employeeId, session);
        if (!manages(ctx, employee)) throw generateError("Employee is outside your onboarding scope", 403);
        if (employee.is_enabled === false || employee.deletedAt) throw generateError("Assign onboarding to an active employee", 422);
      } else {
        const existing = await instanceFor(ctx, req.params.instanceId, session); before = existing.instance; employee = existing.employee;
        originalBefore = JSON.parse(JSON.stringify(before));
        if (manageActions.includes(action) && !manages(ctx, employee)) throw generateError("Employee is outside your onboarding scope", 403);
        if (kind === "task" || kind === "upload") {
          const taskId = objectId(req.params.taskId, "task id"); task = before.tasks.find((item: any) => valueId(item) === valueId(taskId));
          if (!task || !visibleTask(ctx, employee, task)) throw generateError("Onboarding task not found", 404);
          if ((action === "complete" || action === "acknowledge" || action === "remove_document" || kind === "upload") && !owns(ctx, task, employee)) throw generateError("Only an assigned task owner can submit it", 403);
        }
      }
      const prior: any = await Audit.findOne({ company: ctx.company, actor: ctx.actor._id, requestId }).session(session!).lean();
      if (prior) {
        if (prior.requestHash !== requestHash) throw generateError("Request id already used for another onboarding change", 409);
        // Custody may have changed after this command; never display an old equipment completion snapshot on retry.
        const assetReplay = task?.kind === "asset_provisioning" || kind === "instance" && before?.tasks.some((item: any) => item.kind === "asset_provisioning");
        result = { data: dto(ctx, action === "acknowledge" || assetReplay ? before : prior.after, employee), replayed: true }; return;
      }
      if (before && (!Number.isSafeInteger(req.body.revision) || before.revision !== req.body.revision)) throw generateError("Onboarding changed. Reload before saving again.", 409);
      if (before?.status === "cancelled") throw generateError("Cancelled onboarding cannot be changed", 409);
      if (action === "acknowledge" && task?.kind !== "policy_acknowledgement") throw generateError("This task does not request policy acknowledgement", 409);
      const reason = kind === "upload" ? `Uploaded ${name}` : action === "acknowledge" ? text(task.policySnapshot?.acknowledgementText, "Acknowledgement statement", 10, 1000) : text(req.body.reason, "Reason", 3, 1000);
      let after: any, event = action;
      if (kind === "assign") {
        after = await createAssignedChecklist(ctx, employee, req.body, session!);
      } else {
        let changes: any = {};
        if (action === "cancel") {
          if (valueId(employee) === valueId(ctx.actor)) throw generateError("Another HR user must cancel your onboarding", 403);
          await releaseOnboardingAssetLinks(ctx, before, null, "cancel", reason, requestId, session!);
          changes = { status: "cancelled", isCurrent: false };
        } else if (action === "reschedule") {
          const joiningDate = joiningDateKey(employee.joiningDate), timezone = validateOnboardingTimezone(req.body.timezone || before.timezone);
          before.tasks.forEach((item: any) => { if (!terminalTask(item)) Object.assign(item, onboardingDueDate(joiningDate, item.dueDays, timezone)); });
          changes = { joiningDate, timezone, tasks: before.tasks };
        } else {
          const capabilities = dto(ctx, before, employee).tasks.find((item: any) => valueId(item) === valueId(task));
          if (kind === "upload") {
            if (!capabilities.canUpload) throw generateError("Documents can be uploaded only to your pending document task (maximum five)", 409);
            if (!stagedDocument && !scan) throw generateError("Upload security check is missing. Upload the file again.", 503);
            const document = stagedDocument ? await attachOnboardingDocument(stagedDocument, session!) : (await Document.create([{ company: ctx.company, onboarding: before._id, task: task._id, uploadedBy: ctx.actor._id, name, type: file!.mimeType, size: file!.size, bytes: file!.buffer, sha256: scan!.sha256, scan }], { session }))[0];
            task.documents.push({ document: document._id, name, type: file!.mimeType, size: file!.size, uploadedBy: ctx.actor._id, uploadedAt: new Date(), scan: document.scan });
          } else if (action === "remove_document") {
            if (!capabilities.canRemoveDocument) throw generateError("Only pending document tasks can have uploads replaced", 409);
            const documentId = objectId(req.body.documentId, "document id");
            if (!task.documents.some((document: any) => valueId(document.document) === valueId(documentId))) throw generateError("Onboarding document not found", 404);
            // Unlinking starts retention; it never deletes bytes or overrides a legal hold.
            const removed = await Document.updateOne({ _id: documentId, company: ctx.company, onboarding: before._id, task: task._id, erasureRequest: null,
              $or: [{ storageStatus: "attached" }, { storageStatus: { $exists: false }, storageProvider: { $ne: "r2" } }] },
              { $set: { retentionRemovedAt: new Date() }, $inc: { retentionRevision: 1 } }, { session });
            if (!removed.matchedCount) throw generateError("Document state changed. Reload before removing it.", 409);
            task.documents = task.documents.filter((document: any) => valueId(document.document) !== valueId(documentId));
          } else if (action === "acknowledge") {
            if (valueId(ctx.actor) !== valueId(employee)) throw generateError("Only the employee can acknowledge their policy", 403);
            if (!capabilities.canAcknowledge) throw generateError("Only a pending policy acknowledgement can be accepted", 409);
            if (req.body.confirmAcknowledgement !== true) throw generateError("Explicit policy acknowledgement confirmation is required", 422);
            const version: any = await PolicyVersion.findOne({ _id: task.policySnapshot.policyVersion, policy: task.policySnapshot.policy, company: ctx.company }).session(session!).lean();
            assertPolicyIntegrity(version);
            if (req.body.policyVersionId !== valueId(version) || req.body.contentHash !== version.contentHash || task.policySnapshot.contentHash !== version.contentHash) throw generateError("The displayed policy version changed. Read it again before acknowledging.", 409);
            const now = new Date(), cycle = task.acknowledgementCycle || 1;
            const receipt = (await PolicyAcknowledgement.create([{ company: ctx.company, onboarding: before._id, task: task._id, employee: employee._id, employeeName: employee.name || employee.code, employeeCode: employee.code,
              policy: version.policy, policyVersion: version._id, policyName: version.content.name, version: version.version, contentHash: version.contentHash, statement: version.content.acknowledgementText, cycle, acknowledgedAt: now }], { session }))[0];
            task.status = "completed"; task.completedBy = ctx.actor._id; task.completedAt = now; task.completionNote = version.content.acknowledgementText;
            task.acknowledgement = { receipt: receipt._id, employeeName: employee.name || employee.code, acknowledgedAt: now, cycle };
          } else if (action === "complete") {
            if (task.kind === "asset_provisioning") throw generateError("Link real matching asset handovers to fulfill this task; manual completion is not allowed", 409);
            if (task.kind === "policy_acknowledgement") throw generateError("Read and acknowledge the assigned policy instead of completing it as a standard task", 409);
            if (!capabilities.canComplete) throw generateError("Only a pending task can be submitted", 409);
            if (task.requiresDocument && !task.documents.length) throw generateError("Upload the required document before submitting this task", 422);
            task.status = task.requiresDocument ? "pending_review" : "completed"; task.completionNote = reason;
            task.completedBy = task.requiresDocument ? null : ctx.actor._id; task.completedAt = task.requiresDocument ? null : new Date();
          } else if (action === "approve" || action === "return") {
            if (!capabilities.canReview) throw generateError("Another authorized HR user must review this document submission", 403);
            task.status = action === "approve" ? "completed" : "pending"; task.completedBy = action === "approve" ? ctx.actor._id : null; task.completedAt = action === "approve" ? new Date() : null;
          } else if (action === "waive" || action === "reopen") {
            if (!(action === "waive" ? capabilities.canWaive : capabilities.canReopen)) throw generateError("This task cannot be waived or reopened by you", 403);
            if (task.kind === "asset_provisioning") {
              await releaseOnboardingAssetLinks(ctx, before, task, action, reason, requestId, session!);
              if (action === "reopen") task.assetCycle = (task.assetCycle || 1) + 1;
              task.completionNote = action === "waive" ? `Equipment requirement waived: ${reason}` : "";
              task.ownerIssue = action === "waive" || task.assignees.length ? "" : "No eligible provisioning owner is assigned. HR must reassign this task.";
            }
            task.status = action === "waive" ? "waived" : task.assignees.length ? "pending" : "blocked"; task.completedBy = action === "waive" ? ctx.actor._id : null; task.completedAt = action === "waive" ? new Date() : null;
            if (task.kind === "policy_acknowledgement") {
              if (action === "reopen") { task.acknowledgementCycle = (task.acknowledgementCycle || 1) + 1; task.acknowledgement = null; task.completionNote = ""; }
              else task.completionNote = `Waived: ${reason}`;
            }
          } else if (action === "reassign") {
            if (task.kind === "policy_acknowledgement") throw generateError("Policy acknowledgement must remain assigned to the employee", 409);
            if (!capabilities.canReassign) throw generateError("Return or reopen this task before reassigning it", 409);
            if (!Array.isArray(req.body.assigneeIds) || !req.body.assigneeIds.length || req.body.assigneeIds.length > 20) throw generateError("Choose 1-20 task owners", 422);
            const ids = req.body.assigneeIds.map((value: any) => objectId(value, "task owner"));
            if (new Set(ids.map(String)).size !== ids.length) throw generateError("Duplicate task owners", 422);
            const people = await activeOwners(ctx, ids, session!);
            if (people.length !== ids.length) throw generateError("Choose active task owners from your company", 422);
            if (task.kind === "asset_provisioning") {
              const company = await Company.findById(ctx.company).select("rolePermissions").session(session!).lean();
              if (people.some((person) => { const actor = attachEffectivePermissions({ user: person, company }); return valueId(person) === valueId(employee) || !hasPermission(actor, PERMISSION_KEYS.VIEW_ASSETS) || !hasPermission(actor, PERMISSION_KEYS.MANAGE_ASSETS); })) throw generateError("Choose another active owner with View and Manage Assets permissions", 422);
            }
            task.assignees = people.map((person) => ({ user: person._id, name: person.name || person.code })); task.ownerResolution = "manual"; task.ownerIssue = ""; task.status = "pending";
          }
          changes = { tasks: before.tasks, status: onboardingStatus(before.tasks) };
          event = kind === "upload" ? action : `task_${action === "complete" && task.status === "pending_review" ? "submitted_for_review" : action}`;
          if (action === "acknowledge") event = "task_policy_acknowledged";
        }
        after = await Instance.findOneAndUpdate({ _id: before._id, company: ctx.company, revision: before.revision }, { $set: { ...changes, updatedBy: ctx.actor._id }, $inc: { revision: 1 } }, { new: true, session, runValidators: true }).lean();
        if (!after) throw generateError("Onboarding changed. Reload before saving again.", 409);
      }
      // Keep full source evidence private; participant history returns only scoped event metadata.
      await Audit.create([{ company: ctx.company, onboarding: after._id, task: task?._id || null, actor: ctx.actor._id, actorName: ctx.actor.name || ctx.actor.username || "Employee", action: event, reason, requestId, requestHash, before: originalBefore, after }], { session });
      const recipients = kind === "assign" ? [employee._id, ...after.tasks.flatMap((item: any) => item.assignees.map((person: any) => person.user))] : [employee._id, after.createdBy, ...(task?.assignees || []).map((person: any) => person.user)];
      await notify(ctx, after, recipients, event, after.revision, session!);
      result = { data: dto(ctx, after, employee), replayed: false };
    };
    try { await session.withTransaction(process); }
    catch (error: any) {
      if (error?.code !== 11000) throw error;
      const prior: any = await Audit.findOne({ company: ctx.company, actor: ctx.actor._id, requestId }).lean();
      if (prior && prior.requestHash === requestHash) {
        const { instance, employee } = await instanceFor(ctx, valueId(prior.onboarding));
        const assetReplay = kind === "instance" ? instance.tasks.some((item: any) => item.kind === "asset_provisioning") : instance.tasks.some((item: any) => valueId(item) === req.params.taskId && item.kind === "asset_provisioning");
        result = { data: dto(ctx, action === "acknowledge" || assetReplay ? instance : prior.after, employee), replayed: true };
      }
      else throw generateError("This checklist is already assigned for the employee's joining date, or the request id conflicts", 409);
    }
    res.status(kind === "assign" || kind === "upload" ? 201 : 200).json({ success: true, ...result });
  } catch (error) { next(error); } finally {
    await session?.endSession();
    if (stagedDocument) await queueOnboardingDocumentCleanup(stagedDocument._id).catch(() => console.warn("Onboarding document cleanup deferred; retry the storage cleanup command."));
  }
};
export const downloadOnboardingDocument = async (req: any, res: any, next: any) => {
  try {
    const ctx = context(req), { instance, employee } = await instanceFor(ctx, req.params.instanceId);
    const task = instance.tasks.find((item: any) => valueId(item) === valueId(objectId(req.params.taskId, "task id")));
    if (!task || !visibleTask(ctx, employee, task)) throw generateError("Onboarding document not found", 404);
    if (!task.documents.some((document: any) => valueId(document.document) === req.params.documentId)) throw generateError("Onboarding document not found", 404);
    const document: any = await Document.findOne({ _id: objectId(req.params.documentId, "document id"), company: ctx.company, onboarding: instance._id, task: task._id }).select("+bytes").lean();
    if (!document) throw generateError("Onboarding document not found", 404);
    const bytes = await onboardingDocumentBytes(document);
    res.setHeader("Content-Type", document.type); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Content-Disposition", `attachment; filename="document.${document.type === "application/pdf" ? "pdf" : document.type === "image/png" ? "png" : "jpg"}"; filename*=UTF-8''${encodeURIComponent(document.name)}`);
    res.send(bytes);
  } catch (error) { next(error); }
};
