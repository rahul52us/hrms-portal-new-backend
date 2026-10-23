import mongoose, { ClientSession } from "mongoose";
import { generateError } from "../../config/Error/functions";
import Project from "../../schemas/project/Project.schema";
import WorkType from "../../schemas/project/ProjectWorkType.schema";
import Assignment from "../../schemas/project/ProjectAssignment.schema";
import Audit from "../../schemas/project/ProjectAuditLog.schema";
import User from "../../schemas/User/User";
import { getEmployeeRequestActor, resolveEmployeeRequestCompanyId } from "../leave/leaveAccess.utils";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import {
  assignmentDateMatch, canManageProject, companyProjectManager, companyProjectViewer,
  dateKey, dateRange, employeeProjectScope, objectId, overlapMatch, pagination,
  projectCode, projectId, projectManagementDisabled, projectToday, shortText,
} from "./project.utils";

const personFields = "_id name code";
const activePeople = { role: { $ne: "superadmin" }, is_enabled: { $ne: false }, deletedAt: null };

async function context(req: any, write = false) {
  const actor = getEmployeeRequestActor(req);
  if (actor.role === "superadmin") throw generateError("Projects are managed from a company account", 403);
  if (!hasPermission(actor, PERMISSION_KEYS.VIEW_PROJECTS)) throw generateError("You do not have permission to view projects", 403);
  const company = resolveEmployeeRequestCompanyId(actor, req.body?.companyId || req.query?.companyId, "project");
  if (write) await ensureCompanyManagementAccess({ actor, requestedCompanyId: String(company), actionLabel: "manage projects" });
  return { actor, company };
}
type Context = Awaited<ReturnType<typeof context>>;
const searchFilter = (value: any) => {
  if (value === undefined || value === "") return null;
  const search = shortText(value, "Search", 1, 100);
  return new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
};
function ids(value: any, label: string, max = 20) {
  if (!Array.isArray(value) || !value.length || value.length > max) throw generateError(`Select 1 to ${max} ${label}`, 422);
  const result = value.map((item: any) => objectId(item, label));
  if (new Set(result.map(String)).size !== result.length) throw generateError(`Duplicate ${label}`, 422);
  return result;
}
function selection(value: any, choices: string[], fallback: string) {
  const result = value === undefined ? fallback : String(value);
  if (!choices.includes(result)) throw generateError(`Expected one of: ${choices.join(", ")}`, 400);
  return result;
}
async function canCreate(ctx: Context) {
  if (projectManagementDisabled(ctx.actor)) return false;
  if (hasPermission(ctx.actor, PERMISSION_KEYS.MANAGE_PROJECTS)) return true;
  return Boolean(await User.exists({ company: ctx.company, ...activePeople, reportingManager: ctx.actor._id }));
}
async function findProject(ctx: Context, id: any, session?: ClientSession, write = false) {
  const project: any = await Project.findOne({ _id: objectId(id, "project id"), company: ctx.company }).session(session || null).lean();
  if (!project) throw generateError("Project not found", 404);
  const manage = canManageProject(ctx.actor, project);
  if (write) {
    if (!manage) throw generateError("You cannot manage this project", 403);
  } else if (!companyProjectViewer(ctx.actor) && !project.managers.some((id: any) => projectId(id) === projectId(ctx.actor))) {
    const assigned = await Assignment.exists({ company: ctx.company, project: project._id, employee: ctx.actor._id, status: "assigned" }).session(session || null);
    if (!assigned) throw generateError("Project not found", 404);
  }
  return project;
}
async function managersFor(ctx: Context, value: any, session: ClientSession) {
  const managers = ids(value, "project managers");
  if (!companyProjectManager(ctx.actor) && (managers.length !== 1 || projectId(managers[0]) !== projectId(ctx.actor))) {
    throw generateError("Only Company Admin or HR Admin can assign other project managers", 403);
  }
  const count = await User.countDocuments({ company: ctx.company, ...activePeople, _id: { $in: managers } }).session(session);
  if (count !== managers.length) throw generateError("Select active project managers from your company", 422);
  return managers;
}
function expectedRevision(req: any, project: any) {
  if (!Number.isSafeInteger(req.body?.revision) || req.body.revision !== project.revision) {
    throw generateError("Project changed. Refresh it before saving again.", 409);
  }
}
async function touch(ctx: Context, project: any, changes: any, session: ClientSession) {
  const updated = await Project.findOneAndUpdate({ _id: project._id, company: ctx.company, revision: project.revision },
    { $set: { ...changes, updatedBy: ctx.actor._id }, $inc: { revision: 1 } }, { new: true, session, runValidators: true }).lean();
  if (!updated) throw generateError("Project changed. Refresh it before saving again.", 409);
  return updated as any;
}
async function audit(ctx: Context, project: any, action: string, entityId: any, reason: string, before: any, after: any, session: ClientSession) {
  await Audit.create([{ company: ctx.company, project: project._id, actor: ctx.actor._id, action,
    entityId, reason, before, after, projectRevision: project.revision }], { session });
}
function handler(action: (req: any, ctx: Context, session?: ClientSession) => Promise<any>, write = false, status = 200) {
  return async (req: any, res: any, next: any) => {
    let session: ClientSession | undefined;
    try {
      const ctx = await context(req, write);
      let result: any;
      if (write) {
        session = await mongoose.startSession();
        await session.withTransaction(async () => { result = await action(req, ctx, session); });
      } else result = await action(req, ctx);
      return res.status(status).json({ success: true, ...result });
    } catch (error: any) {
      if (error?.code === 11000) return next(generateError("This code or assignment start date already exists. Refresh and choose another.", 409));
      next(error);
    } finally { await session?.endSession(); }
  };
}
async function list(model: any, match: any, req: any, sort: any) {
  const { page, limit, skip } = pagination(req.query);
  const [data, total] = await Promise.all([
    model.find(match).sort(sort).skip(skip).limit(limit).lean(), model.countDocuments(match),
  ]);
  return { data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

export const projectOptions = handler(async (_req, ctx) => ({ data: {
  today: projectToday(),
  canCreate: await canCreate(ctx), canAdmin: companyProjectManager(ctx.actor),
  scopes: companyProjectViewer(ctx.actor) ? ["all", "managed", "mine"] : ["mine", "managed"],
  self: { _id: ctx.actor._id, name: ctx.actor.name, code: ctx.actor.code },
} }));

export const projectPeople = handler(async (req, ctx) => {
  if (req.query.projectId) await findProject(ctx, req.query.projectId, undefined, true);
  else if (!await canCreate(ctx)) throw generateError("You cannot search project employees", 403);
  const kind = selection(req.query.kind, ["employee", "manager"], "employee");
  const scope = kind === "manager" ? (companyProjectManager(ctx.actor) ? {} : { _id: ctx.actor._id }) : employeeProjectScope(ctx.actor);
  const search = searchFilter(req.query.search);
  const match = { $and: [{ company: ctx.company, ...activePeople }, scope, ...(search ? [{ $or: [{ name: search }, { code: search }] }] : [])] };
  const { page, limit, skip } = pagination(req.query);
  const [data, total] = await Promise.all([
    User.find(match).select(personFields).sort({ name: 1, _id: 1 }).skip(skip).limit(limit).lean(), User.countDocuments(match),
  ]);
  return { data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});

export const listProjects = handler(async (req, ctx) => {
  const scope = selection(req.query.scope, ["mine", "managed", "all"], companyProjectViewer(ctx.actor) ? "all" : "mine");
  if (scope === "all" && !companyProjectViewer(ctx.actor)) throw generateError("You cannot view all company projects", 403);
  const status = selection(req.query.status, ["active", "archived", "all"], "active");
  const asOf = dateKey(req.query.asOf || projectToday(), "As-of date")!;
  const search = searchFilter(req.query.search);
  const match: any = { company: ctx.company, ...(status !== "all" ? { status } : {}),
    ...(search ? { $or: [{ name: search }, { code: search }] } : {}),
    ...(scope === "managed" ? { managers: ctx.actor._id } : {}) };
  const pipeline: any[] = [{ $match: match }];
  if (scope === "mine") {
    pipeline.push({ $lookup: { from: "projectassignments", let: { id: "$_id" }, pipeline: [
      { $match: { company: ctx.company, employee: ctx.actor._id, ...assignmentDateMatch(asOf), $expr: { $eq: ["$project", "$$id"] } } },
      { $limit: 1 }, { $project: { _id: 1 } },
    ], as: "membership" } }, { $match: { "membership.0": { $exists: true }, startDate: { $lte: asOf }, $or: [{ endDate: null }, { endDate: { $gte: asOf } }] } });
  }
  const { page, limit, skip } = pagination(req.query);
  const [result] = await Project.aggregate([...pipeline, { $facet: {
    data: [{ $sort: { name: 1, _id: 1 } }, { $skip: skip }, { $limit: limit }, { $project: { membership: 0 } }], total: [{ $count: "count" }],
  } }]);
  const data = await Project.populate(result.data, { path: "managers", select: personFields });
  const total = result.total[0]?.count || 0;
  return { data: data.map((project: any) => ({ ...project, canManage: canManageProject(ctx.actor, project) })),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});

export const getProject = handler(async (req, ctx) => {
  const project = await findProject(ctx, req.params.projectId);
  const data = await Project.populate(project, { path: "managers", select: personFields });
  return { data: { ...data, canManage: canManageProject(ctx.actor, data) } };
});

export const createProject = handler(async (req, ctx, session) => {
  if (!await canCreate(ctx)) throw generateError("Only reporting managers or authorized users can create projects", 403);
  const name = shortText(req.body?.name, "Project name", 2, 120);
  const startDate = dateKey(req.body.startDate || projectToday(), "Start date")!;
  const endDate = dateKey(req.body.endDate, "End date", true);
  dateRange(startDate, endDate);
  const managers = await managersFor(ctx, req.body.managerIds || [ctx.actor._id], session!);
  const [project] = await Project.create([{ company: ctx.company, name, code: projectCode(req.body.code, name),
    description: shortText(req.body.description || "", "Description", 0, 1000), managers, startDate, endDate,
    createdBy: ctx.actor._id, updatedBy: ctx.actor._id }], { session });
  await audit(ctx, project, "project_created", project._id, "Project created", null, project.toObject(), session!);
  return { data: project, message: "Project created" };
}, true, 201);

export const updateProject = handler(async (req, ctx, session) => {
  const project = await findProject(ctx, req.params.projectId, session, true);
  expectedRevision(req, project);
  if (project.status !== "active") throw generateError("Restore the project before editing it", 409);
  const reason = shortText(req.body.reason, "Change reason", 3, 500);
  const name = shortText(req.body.name ?? project.name, "Project name", 2, 120);
  const startDate = dateKey(req.body.startDate ?? project.startDate, "Start date")!;
  const endDate = dateKey(req.body.endDate === undefined ? project.endDate : req.body.endDate, "End date", true);
  dateRange(startDate, endDate);
  if (startDate !== project.startDate || endDate !== project.endDate) {
    const outside = await Assignment.exists({ company: ctx.company, project: project._id, status: "assigned", $or: [
      { effectiveFrom: { $lt: startDate } }, ...(endDate ? [{ effectiveTo: null }, { effectiveTo: { $gt: endDate } }, { effectiveFrom: { $gt: endDate } }] : []),
    ] }).session(session!);
    if (outside) throw generateError("End or adjust assignments before narrowing project dates", 409);
  }
  const managers = req.body.managerIds === undefined ? project.managers : await managersFor(ctx, req.body.managerIds, session!);
  const updated = await touch(ctx, project, { name, startDate, endDate, managers,
    description: shortText(req.body.description ?? project.description, "Description", 0, 1000) }, session!);
  await audit(ctx, updated, "project_updated", project._id, reason, project, updated, session!);
  return { data: updated, message: "Project updated" };
}, true);

export const changeProjectStatus = (status: "active" | "archived") => handler(async (req, ctx, session) => {
  const project = await findProject(ctx, req.params.projectId, session, true);
  expectedRevision(req, project);
  if (project.status === status) throw generateError(`Project is already ${status}`, 409);
  const reason = shortText(req.body.reason, "Reason", 3, 500);
  const updated = await touch(ctx, project, { status, archivedAt: status === "archived" ? new Date() : null,
    archivedBy: status === "archived" ? ctx.actor._id : null, archiveReason: status === "archived" ? reason : "" }, session!);
  await audit(ctx, updated, status === "archived" ? "project_archived" : "project_restored", project._id, reason, project, updated, session!);
  return { data: updated, message: `Project ${status === "archived" ? "archived" : "restored"}` };
}, true);

export const listWorkTypes = handler(async (req, ctx) => {
  const project = await findProject(ctx, req.params.projectId);
  const status = selection(req.query.status, ["active", "archived", "all"], "active");
  return list(WorkType, { company: ctx.company, project: project._id, ...(status === "all" ? {} : { status }) }, req, { name: 1, _id: 1 });
});

export const saveWorkType = handler(async (req, ctx, session) => {
  const project = await findProject(ctx, req.params.projectId, session, true);
  expectedRevision(req, project);
  if (project.status !== "active") throw generateError("Restore the project before changing work types", 409);
  const before: any = req.params.workTypeId ? await WorkType.findOne({ _id: objectId(req.params.workTypeId, "work type id"), company: ctx.company, project: project._id }).session(session!).lean() : null;
  if (req.params.workTypeId && !before) throw generateError("Work type not found", 404);
  const reason = before ? shortText(req.body.reason, "Change reason", 3, 500) : "Work type created";
  const name = shortText(req.body.name ?? before?.name, "Work type name", 2, 100);
  const status = selection(req.body.status, ["active", "archived"], before?.status || "active");
  const updated = await touch(ctx, project, {}, session!);
  const values = { name, status, updatedBy: ctx.actor._id, archivedAt: status === "archived" ? before?.archivedAt || new Date() : null };
  let after: any;
  if (before) after = await WorkType.findOneAndUpdate({ _id: before._id, company: ctx.company, project: project._id }, { $set: values }, { new: true, session, runValidators: true }).lean();
  else {
    const [created] = await WorkType.create([{ ...values, company: ctx.company, project: project._id, code: projectCode(req.body.code, name), createdBy: ctx.actor._id }], { session });
    after = created.toObject();
  }
  await audit(ctx, updated, before ? "work_type_updated" : "work_type_created", after._id, reason, before, after, session!);
  return { data: after, revision: updated.revision, message: before ? "Work type updated" : "Work type created" };
}, true);

export const listAssignments = handler(async (req, ctx) => {
  const project = await findProject(ctx, req.params.projectId);
  const scope = canManageProject(ctx.actor, project) || companyProjectViewer(ctx.actor) ? {} : { employee: ctx.actor._id };
  const match: any = { $and: [{ company: ctx.company, project: project._id }, scope] };
  const filter = selection(req.query.status, ["all", "current", "upcoming", "ended", "cancelled"], "all");
  const date = dateKey(req.query.asOf || projectToday(), "As-of date")!;
  if (filter === "current") match.$and.push(assignmentDateMatch(date));
  if (filter === "upcoming") match.$and.push({ status: "assigned", effectiveFrom: { $gt: date } });
  if (filter === "ended") match.$and.push({ status: "assigned", effectiveTo: { $lt: date } });
  if (filter === "cancelled") match.$and.push({ status: "cancelled" });
  const search = searchFilter(req.query.search);
  if (search) match.$and.push({ $or: [{ employeeNameSnapshot: search }, { employeeCodeSnapshot: search }] });
  return list(Assignment, match, req, { effectiveFrom: -1, _id: -1 });
});

export const createAssignments = handler(async (req, ctx, session) => {
  const project = await findProject(ctx, req.params.projectId, session, true);
  expectedRevision(req, project);
  if (project.status !== "active") throw generateError("Restore the project before assigning employees", 409);
  const employeeIds = ids(req.body.employeeIds, "employees", 100);
  const effectiveFrom = dateKey(req.body.effectiveFrom, "Start date")!;
  const effectiveTo = dateKey(req.body.effectiveTo, "Last project day", true);
  const reason = shortText(req.body.reason, "Assignment reason", 3, 500);
  dateRange(effectiveFrom, effectiveTo);
  if (effectiveFrom < project.startDate || (project.endDate && (!effectiveTo || effectiveTo > project.endDate))) throw generateError("Assignment dates must fall within the project dates", 422);
  const employees: any[] = await User.find({ $and: [{ company: ctx.company, ...activePeople, _id: { $in: employeeIds } }, employeeProjectScope(ctx.actor)] })
    .select(`${personFields} joiningDate employmentEndDate`).session(session!).lean();
  if (employees.length !== employeeIds.length) throw generateError("Select active employees within your assignment scope", 403);
  for (const employee of employees) {
    const joining = employee.joiningDate ? new Date(employee.joiningDate).toISOString().slice(0, 10) : null;
    const exit = employee.employmentEndDate ? new Date(employee.employmentEndDate).toISOString().slice(0, 10) : null;
    if ((joining && effectiveFrom < joining) || (exit && (!effectiveTo || effectiveTo > exit))) throw generateError("Assignment dates must fall within employee employment dates", 422);
  }
  const overlap = await Assignment.exists({ company: ctx.company, project: project._id, employee: { $in: employeeIds }, ...overlapMatch(effectiveFrom, effectiveTo) }).session(session!);
  if (overlap) throw generateError("An employee already has an overlapping project assignment", 409);
  const updated = await touch(ctx, project, {}, session!);
  const created = await Assignment.create(employees.map((employee) => ({ company: ctx.company, project: project._id, employee: employee._id,
    employeeNameSnapshot: employee.name || employee.code, employeeCodeSnapshot: employee.code, effectiveFrom, effectiveTo, changeReason: reason, createdBy: ctx.actor._id })), { session });
  await Audit.insertMany(created.map((entry: any) => ({ company: ctx.company, project: project._id, actor: ctx.actor._id,
    action: "employee_assigned", entityId: entry._id, reason, before: null, after: entry.toObject(), projectRevision: updated.revision })), { session });
  return { data: created, revision: updated.revision, message: `${created.length} employee(s) assigned` };
}, true, 201);

export const endAssignment = handler(async (req, ctx, session) => {
  const project = await findProject(ctx, req.params.projectId, session, true);
  expectedRevision(req, project);
  const before: any = await Assignment.findOne({ _id: objectId(req.params.assignmentId, "assignment id"), company: ctx.company, project: project._id }).session(session!).lean();
  if (!before) throw generateError("Assignment not found", 404);
  if (before.status !== "assigned") throw generateError("Assignment is already cancelled", 409);
  const reason = shortText(req.body.reason, "Reason", 3, 500);
  const cancel = req.body.cancel === true;
  const effectiveTo = cancel ? before.effectiveTo : dateKey(req.body.effectiveTo, "Last project day")!;
  if (cancel && before.effectiveFrom <= projectToday()) throw generateError("Only future assignments can be cancelled. End an existing assignment instead.", 409);
  if (!cancel) {
    dateRange(before.effectiveFrom, effectiveTo);
    if (before.effectiveTo && effectiveTo >= before.effectiveTo) throw generateError("Choose an earlier last project day", 422);
    if (effectiveTo < projectToday()) throw generateError("Past assignment history cannot be shortened", 409);
  }
  const updated = await touch(ctx, project, {}, session!);
  const after = await Assignment.findOneAndUpdate({ _id: before._id, company: ctx.company, project: project._id }, { $set: {
    status: cancel ? "cancelled" : "assigned", effectiveTo, endedBy: ctx.actor._id, endedAt: new Date(), endReason: reason,
  } }, { new: true, session, runValidators: true }).lean();
  await audit(ctx, updated, cancel ? "assignment_cancelled" : "assignment_ended", before._id, reason, before, after, session!);
  return { data: after, revision: updated.revision, message: cancel ? "Assignment cancelled" : "Assignment ended" };
}, true);

export const projectAudit = handler(async (req, ctx) => {
  const project = await findProject(ctx, req.params.projectId, undefined, true);
  const result = await list(Audit, { company: ctx.company, project: project._id }, req, { createdAt: -1, _id: -1 });
  result.data = await Audit.populate(result.data, { path: "actor", select: personFields });
  return result;
});
