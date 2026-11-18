import { createHash, randomUUID } from "crypto";
import mongoose, { ClientSession } from "mongoose";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import Instance from "../../schemas/Onboarding/EmployeeOnboarding.schema";
import Notification from "../../schemas/Notification/notification.schema";
import { DEFAULT_ONBOARDING_AUTOMATION as defaults, OnboardingAutomationAudit as Audit, OnboardingAutomationJob as Job, OnboardingAutomationSettings as Settings } from "../../schemas/Onboarding/OnboardingAutomation.schema";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { getEmployeeRequestActor, resolveEmployeeRequestCompanyId } from "../leave/leaveAccess.utils";
import { attachEffectivePermissions, ensurePermission, hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { upsertRequestNotifications } from "../notification/notification.service";
import { objectId, pagination, text } from "./onboardingTemplate.utils";
import { inOnboardingScope, terminalTask, validateOnboardingTimezone, valueId } from "./employeeOnboarding.utils";

type Rules = typeof defaults;
const fields = Object.keys(defaults) as (keyof Rules)[];
const personFields = "_id company name code role accessRole permissions permissionOverrides department team officeLocation hrScope";
const activePerson = { deletedAt: null, is_enabled: { $ne: false }, role: { $ne: "superadmin" } };
const emptyMetrics = () => ({ checklists: 0, tasks: 0, notifications: 0, escalations: 0, ownerIssues: 0, skipped: 0 });

export function canManageOnboardingAutomation(actor: any) {
  return ["admin", "hradmin"].includes(actor.role) && hasPermission(actor, PERMISSION_KEYS.VIEW_ONBOARDING) && hasPermission(actor, PERMISSION_KEYS.MANAGE_ONBOARDING);
}
function admin(req: any) {
  const actor = getEmployeeRequestActor(req);
  if (!canManageOnboardingAutomation(actor)) throw generateError("Company Admin or HR Admin with onboarding management permission is required", 403);
  return { actor, company: resolveEmployeeRequestCompanyId(actor, req.body?.companyId || req.query?.companyId, "onboarding automation") };
}
function settingsDto(record: any) {
  return { ...Object.fromEntries(fields.map((key) => [key, record?.[key] ?? defaults[key]])), revision: record?.revision || 0, updatedAt: record?.updatedAt || null } as Rules & { revision: number; updatedAt: Date | null };
}
async function settingsFor(company: any, session?: ClientSession) {
  return settingsDto(await Settings.findOne({ company }).session(session || null).lean());
}
function normalizedRules(input: any): Rules {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !fields.includes(key as keyof Rules))) throw generateError("Provide valid onboarding reminder settings", 422);
  if (typeof input.enabled !== "boolean") throw generateError("Enabled must be true or false", 422);
  for (const [key, min, max] of [["remindBeforeHours", 0, 168], ["reminderEveryDays", 1, 30], ["escalateAfterDays", 0, 30], ["escalationEveryDays", 1, 30]] as const) {
    if (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max) throw generateError(`${key} must be a whole number from ${min} to ${max}`, 422);
  }
  return Object.fromEntries(fields.map((key) => [key, input[key]])) as Rules;
}
function requestKey(value: any) {
  const key = text(value, "Request id", 8, 100);
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw generateError("Invalid request id", 422);
  return key;
}
export const getOnboardingAutomationSettings = async (req: any, res: any, next: any) => {
  try { const { company } = admin(req); res.json({ success: true, data: await settingsFor(company) }); } catch (error) { next(error); }
};
/** Revision checks prevent stale settings; an exact uncertain-response retry cannot overwrite a later HR change. */
export const saveOnboardingAutomationSettings = async (req: any, res: any, next: any) => {
  try {
    const { actor, company } = admin(req);
    await ensureCompanyManagementAccess({ actor, requestedCompanyId: valueId(company), actionLabel: "configure onboarding reminders" });
    await Promise.all([Settings.init(), Audit.init()]);
    const rules = normalizedRules(req.body.settings), revision = req.body.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw generateError("Load the current settings revision before saving", 422);
    const reason = text(req.body.reason, "Reason", 3, 1000), requestId = requestKey(req.body.requestId);
    const requestHash = createHash("sha256").update(JSON.stringify({ rules, revision, reason })).digest("hex");
    let replayed = false;
    const replay = async (session?: ClientSession) => {
      const prior: any = await Audit.findOne({ company, actor: actor._id, requestId }).session(session || null).lean();
      if (prior && prior.requestHash !== requestHash) throw generateError("Request id was already used for another settings change", 409);
      return Boolean(prior);
    };
    try {
      await mongoose.connection.transaction(async (session) => {
        if (await replay(session)) { replayed = true; return; }
        const before = await settingsFor(company, session);
        if (before.revision !== revision) throw generateError("Reminder settings changed. Reload before saving.", 409);
        const after = revision === 0
          ? (await Settings.create([{ company, ...rules, revision: 1, updatedBy: actor._id }], { session }))[0]
          : await Settings.findOneAndUpdate({ company, revision }, { $set: { ...rules, updatedBy: actor._id }, $inc: { revision: 1 } }, { new: true, session, runValidators: true });
        if (!after) throw generateError("Reminder settings changed. Reload before saving.", 409);
        await Audit.create([{ company, actor: actor._id, actorName: actor.name || actor.username || "HR", requestId, requestHash, reason, before, after: settingsDto(after) }], { session });
      });
    } catch (error: any) {
      if (error.code !== 11000) throw error;
      if (!await replay()) throw generateError("Reminder settings changed. Reload before saving.", 409);
      replayed = true;
    }
    res.json({ success: true, data: await settingsFor(company), replayed });
  } catch (error) { next(error); }
};
export const listOnboardingAutomationAudit = async (req: any, res: any, next: any) => {
  try {
    const { company } = admin(req), { page, limit, skip } = pagination(req.query);
    const match = { company };
    const [data, total] = await Promise.all([Audit.find(match).select("actorName reason before after createdAt").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), Audit.countDocuments(match)]);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};

/** One active job per company, and a stable scheduled/manual key for already-created jobs. */
export async function queueOnboardingAutomation(company: any, key: string, source: "manual" | "scheduled", requestedBy: any = null) {
  await Job.init();
  const previous = await Job.findOne({ company, key }).lean();
  if (previous) return previous;
  const active = await Job.findOne({ company, active: true }).lean();
  if (active) return active;
  try { return (await Job.create({ company, key, source, requestedBy, referenceAt: new Date() })).toObject(); }
  catch (error: any) {
    if (error.code !== 11000) throw error;
    const winner = await Job.findOne({ company, $or: [{ key }, { active: true }] }).lean();
    if (!winner) throw error;
    return winner;
  }
}

/** Cadence uses the checklist's local calendar date, not the server's timezone or unrelated task revisions. */
function cadence(now: Date, timezone: string, every: number) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (key: string) => Number(parts.find((entry) => entry.type === key)?.value);
  return Math.floor(Date.UTC(part("year"), part("month") - 1, part("day")) / 86400000 / every);
}
async function hrOperators(company: any, session: ClientSession) {
  const people: any[] = [];
  let after: any = null;
  for (;;) {
    const batch: any[] = await User.find({ company, ...activePerson, role: { $in: ["admin", "hradmin", "hr"] }, ...(after ? { _id: { $gt: after } } : {}) }).select(personFields).sort({ _id: 1 }).limit(100).session(session).lean();
    people.push(...batch);
    if (batch.length < 100) return people;
    after = batch[batch.length - 1]._id;
  }
}
async function remindInstance(instance: any, company: any, settings: Rules, now: Date, session: ClientSession) {
  const metrics = emptyMetrics(); metrics.checklists = 1;
  const employee: any = await User.findOne({ _id: instance.employee, company: instance.company, ...activePerson }).select(personFields).session(session).lean();
  if (!employee) { metrics.skipped = 1; return metrics; }
  const timezone = validateOnboardingTimezone(instance.timezone);
  const ids = [...new Set(instance.tasks.flatMap((task: any) => task.assignees.map((person: any) => valueId(person.user))))];
  const owners: any[] = await User.find({ company: instance.company, ...activePerson, _id: { $in: ids } }).select(personFields).session(session).lean();
  const mayManage = (person: any) => {
    const actor = attachEffectivePermissions({ user: person, company });
    return hasPermission(actor, PERMISSION_KEYS.VIEW_ONBOARDING) && inOnboardingScope(actor, employee, PERMISSION_KEYS.MANAGE_ONBOARDING);
  };
  const hr = (await hrOperators(instance.company, session)).filter((person) => valueId(person) !== valueId(employee) && mayManage(person));
  for (const task of instance.tasks) {
    const due = new Date(task.dueAt), hours = (due.getTime() - now.getTime()) / 3600000;
    if (terminalTask(task) || hours > settings.remindBeforeHours) continue;
    metrics.tasks++;
    const reviewers = hr.filter((person) => !task.documents.some((document: any) => valueId(document.uploadedBy) === valueId(person)));
    const assigned = owners.filter((person) => task.assignees.some((owner: any) => valueId(owner.user) === valueId(person)) && (task.owner !== "hr" || task.ownerResolution === "manual" || mayManage(person)));
    const review = task.status === "pending_review", recipients = review ? reviewers : assigned;
    const ownerIssue = task.status === "blocked" || !recipients.length;
    if (ownerIssue) metrics.ownerIssues++;
    const send = async (people: any[], kind: string, every: number, title: string, suffix: string) => {
      if (!people.length) return 0;
      // A calendar bucket alone can repeat too soon at midnight; also enforce the elapsed repeat interval per recipient.
      const recent: any[] = await Notification.find({ company: instance.company, entityType: "employee_onboarding", entityId: instance._id, eventType: `onboarding.${kind}`, "metadata.taskId": valueId(task), "metadata.dueAt": due.toISOString(), recipient: { $in: people.map((person) => person._id) }, createdAt: { $gt: new Date(now.getTime() - every * 86400000) } }).select("recipient").session(session).lean();
      const seen = new Set(recent.map((notification) => valueId(notification.recipient)));
      return upsertRequestNotifications({
      company: instance.company, recipients: people.filter((person) => !seen.has(valueId(person))).map((person) => person._id), eventType: `onboarding.${kind}`, entityType: "employee_onboarding", entityId: instance._id,
      title, message: `${employee.name || employee.code}: ${task.title}. Due ${task.dueDate} (${timezone}). ${suffix}`.slice(0, 1000),
      category: "system", priority: hours < 0 || ownerIssue ? "high" : "medium", actionUrl: `/dashboard/onboarding?instanceId=${instance._id}`,
      metadata: { taskId: valueId(task), dueDate: task.dueDate, dueAt: due.toISOString(), timezone }, dedupeEventKey: `automation:${task._id}:${due.getTime()}:${kind}:${every}:${cadence(now, timezone, every)}`,
      }, session);
    };
    const escalate = hours <= -settings.escalateAfterDays * 24;
    if (!ownerIssue && !(review && escalate)) metrics.notifications += await send(recipients, review ? "review_reminder" : "task_reminder", settings.reminderEveryDays, review ? "Onboarding document review due" : hours < 0 ? "Onboarding task overdue" : "Onboarding task due soon", review ? "Review the submitted task." : "Complete your assigned task.");
    if (ownerIssue || escalate) {
      const count = await send(hr, ownerIssue ? "owner_issue" : "overdue_escalation", settings.escalationEveryDays, ownerIssue ? "Onboarding owner needs attention" : "Overdue onboarding needs follow-up", ownerIssue ? "An active owner or eligible reviewer is missing; HR must review assignment." : "Follow up with the owner or review the pending submission.");
      metrics.notifications += count; metrics.escalations += count;
    }
  }
  return metrics;
}

/** Notifications, instance fencing and cursor advancement share a transaction, so crashes cannot skip or double-process work. */
async function processNext(jobId: any, lease: string) {
  let complete = false;
  await mongoose.connection.transaction(async (session) => {
    complete = false;
    const now = new Date();
    const job: any = await Job.findOne({ _id: jobId, active: true, lease, leaseUntil: { $gt: now } }).session(session).lean();
    if (!job) { complete = true; return; }
    const settings = await settingsFor(job.company, session);
    const company: any = await Company.findOne({ _id: job.company, is_active: true, deletedAt: null }).select("rolePermissions").session(session).lean();
    const instance: any = settings.enabled && company ? await Instance.findOne({ company: job.company, isCurrent: true, status: { $ne: "cancelled" }, ...(job.cursorAfter ? { _id: { $gt: job.cursorAfter } } : {}), tasks: { $elemMatch: { status: { $in: ["pending", "blocked", "pending_review"] }, dueAt: { $lte: new Date(now.getTime() + settings.remindBeforeHours * 3600000) } } } }).sort({ _id: 1 }).session(session).lean() : null;
    let metrics = emptyMetrics();
    if (instance) {
      const locked = await Instance.findOneAndUpdate({ _id: instance._id, company: job.company, revision: instance.revision, isCurrent: true, status: { $ne: "cancelled" } }, { $inc: { automationFence: 1 } }, { session, timestamps: false });
      if (!locked) throw generateError("Checklist changed while checking reminders", 409);
      metrics = await remindInstance(instance, company, settings, now, session);
    } else complete = true;
    const result = await Job.updateOne({ _id: jobId, active: true, lease, leaseUntil: { $gt: new Date() } }, { $set: complete
      ? { status: "complete", active: false, completedAt: new Date(), lease: null, leaseUntil: null, error: !company ? "Company inactive; check skipped" : !settings.enabled ? "Reminders disabled; check skipped" : "" }
      : { cursorAfter: instance._id, leaseUntil: new Date(Date.now() + 600000) }, $inc: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [`metrics.${key}`, value])) }, { session });
    if (!result.matchedCount) throw generateError("Reminder job lease expired", 409);
  });
  return complete;
}

/** A durable lease allows another process to recover a crashed worker; failures retain the last committed cursor. */
export async function drainOnboardingAutomation(jobId: any, budgetMs = 5000) {
  const lease = randomUUID(), now = new Date();
  const job: any = await Job.findOneAndUpdate({ _id: jobId, active: true, $or: [{ status: "queued" }, { status: "running", leaseUntil: { $lt: now } }, { status: "failed", failures: { $lt: 5 }, nextAttemptAt: { $lte: now } }] }, { $set: { status: "running", lease, leaseUntil: new Date(now.getTime() + 600000), error: "" }, $inc: { attempts: 1 } }, { new: true }).lean();
  if (!job) return;
  try {
    const until = Date.now() + budgetMs;
    for (let step = 0; step < 20 && Date.now() < until; step++) if (await processNext(jobId, lease)) return;
    await Job.updateOne({ _id: jobId, active: true, lease }, { $set: { status: "queued", lease: null, leaseUntil: null } });
  } catch (error: any) {
    await Job.updateOne({ _id: jobId, active: true, lease }, { $set: { status: "failed", lease: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** job.failures)), error: "Reminder processing failed. Retry after resolving the issue; see server logs if it continues." }, $inc: { failures: 1 } });
    console.error("Onboarding reminder job failed", valueId(jobId), error.message);
  }
}
/** Yield between bounded chunks, but keep draining large companies without waiting for the next cron tick. */
export function wakeOnboardingAutomation(jobId: any) {
  setImmediate(() => {
    void (async () => {
      await drainOnboardingAutomation(jobId);
      if (await Job.exists({ _id: jobId, active: true, status: "queued" })) {
        setTimeout(() => wakeOnboardingAutomation(jobId), 1000).unref();
      }
    })().catch((error) => console.error("Onboarding reminder worker failed", error.message));
  });
}
export const listOnboardingAutomationJobs = async (req: any, res: any, next: any) => {
  try {
    const { company } = admin(req), { page, limit, skip } = pagination(req.query);
    const [data, total] = await Promise.all([Job.find({ company }).select("-key").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), Job.countDocuments({ company })]);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const runOnboardingAutomation = async (req: any, res: any, next: any) => {
  try {
    const { actor, company } = admin(req);
    await ensureCompanyManagementAccess({ actor, requestedCompanyId: valueId(company), actionLabel: "run onboarding reminders" });
    if (!(await settingsFor(company)).enabled) throw generateError("Enable onboarding reminders before running a check", 409);
    const key = `manual:${requestKey(req.body.requestId)}`, job: any = await queueOnboardingAutomation(company, key, "manual", actor._id);
    if (job.active && job.status === "queued") wakeOnboardingAutomation(job._id);
    const { lease, key: hiddenKey, ...data } = job;
    res.status(202).json({ success: true, data, reusedActive: hiddenKey !== key });
  } catch (error) { next(error); }
};
export const retryOnboardingAutomation = async (req: any, res: any, next: any) => {
  try {
    const { actor, company } = admin(req), jobId = objectId(req.params.jobId, "reminder job id");
    await ensureCompanyManagementAccess({ actor, requestedCompanyId: valueId(company), actionLabel: "retry onboarding reminders" });
    if (!(await settingsFor(company)).enabled) throw generateError("Enable onboarding reminders before retrying a check", 409);
    const job: any = await Job.findOneAndUpdate({ _id: jobId, company, active: true, status: "failed" }, { $set: { status: "queued", failures: 0, nextAttemptAt: new Date(), error: "" } }, { new: true }).select("-key").lean();
    if (!job) throw generateError("Choose an active failed reminder job", 409);
    wakeOnboardingAutomation(jobId); res.status(202).json({ success: true, data: job });
  } catch (error) { next(error); }
};
