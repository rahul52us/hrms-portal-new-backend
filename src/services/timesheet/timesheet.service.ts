import mongoose from "mongoose";
import { createHash } from "crypto";
import { generateError } from "../../config/Error/functions";
import Timesheet from "../../schemas/Timesheet/Timesheet.schema";
import Revision from "../../schemas/Timesheet/TimesheetRevision.schema";
import Project from "../../schemas/project/Project.schema";
import WorkType from "../../schemas/project/ProjectWorkType.schema";
import Assignment from "../../schemas/project/ProjectAssignment.schema";
import { getEmployeeRequestActor, resolveEmployeeRequestCompanyId } from "../leave/leaveAccess.utils";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { dateKey, objectId, shortText } from "../project/project.utils";
import { timesheetPagination as pagination } from "./timesheetRules.utils";
import { historicalProjectStates, resolveTimesheetDay, timesheetContextSnapshot } from "./timesheetContext.service";
import { addDateDays, validateTimesheetEntries } from "./timesheet.utils";
import { loadMyTimesheetPlanner } from "./timesheetPlanner.service";

function ownContext(req: any) {
  const actor = getEmployeeRequestActor(req);
  if (actor.role === "superadmin") throw generateError("Timesheets require a company employee account", 403);
  if (req.query.employeeId !== undefined || req.body?.employeeId !== undefined) throw generateError("These endpoints only access your own timesheets", 403);
  const company = resolveEmployeeRequestCompanyId(actor, req.query.companyId || req.body?.companyId, "timesheet");
  return { actor, company, employee: actor._id };
}

function handler(action: (req: any, ctx: ReturnType<typeof ownContext>) => Promise<any>) {
  return async (req: any, res: any, next: any) => {
    try { res.status(200).json({ success: true, ...await action(req, ownContext(req)) }); }
    catch (error) { next(error); }
  };
}
const matchFor = (ctx: any, date: string) => ({ company: ctx.company, employee: ctx.employee, attendanceDate: date });
const dateFor = (req: any) => dateKey(req.params.date, "Attendance date")!;
const assignmentMatch = (ctx: any, date: string) => ({ company: ctx.company, employee: ctx.employee, status: "assigned", effectiveFrom: { $lte: date }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: date } }] });

function serializeDay(day: Awaited<ReturnType<typeof resolveTimesheetDay>>, sheet: any) {
  const snapshot = timesheetContextSnapshot(day);
  return { attendanceDate: day.context.attendanceDate, serverNow: new Date().toISOString(), timesheet: sheet, eligibility: {
    ...day.eligibility, canSave: day.eligibility.canSave && (!sheet || sheet.status === "draft") && !sheet?.payrollLockedAt,
  }, context: snapshot, loggedMinutes: sheet?.loggedMinutes || 0,
    requiredMinutes: day.requirement.requiredMinutes,
    shortfallMinutes: day.requirement.requiredMinutes == null ? null : Math.max(0, day.requirement.requiredMinutes - (sheet?.loggedMinutes || 0)),
    contextChanged: Boolean(sheet && JSON.stringify(sheet.contextSnapshot) !== JSON.stringify(snapshot)),
  };
}

export const getMyTimesheetDay = handler(async (req, ctx) => {
  const date = dateFor(req);
  const [sheet, day] = await Promise.all([Timesheet.findOne(matchFor(ctx, date)).lean(), resolveTimesheetDay(ctx.company, ctx.employee, date)]);
  return { data: serializeDay(day, sheet) };
});

export const getMyTimesheetPlanner = handler(async (req, ctx) => ({ data: await loadMyTimesheetPlanner(ctx.company, ctx.employee,
  dateKey(req.query.from, "From date")!, dateKey(req.query.to, "To date")!) }));

export const listMyTimesheetProjects = handler(async (req, ctx) => {
  const date = dateFor(req);
  const day = await resolveTimesheetDay(ctx.company, ctx.employee, date);
  if (!day.context.timezone) return { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } };
  const { page, limit: requestedLimit } = pagination(req.query, 50);
  const limit = Math.min(50, requestedLimit);
  const projectMatch: any = {};
  if (req.query.search) {
    const search = shortText(req.query.search, "Search", 1, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    projectMatch.$or = [{ "project.name": { $regex: search, $options: "i" } }, { "project.code": { $regex: search, $options: "i" } }];
  }
  const pipeline: any[] = [{ $match: assignmentMatch(ctx, date) },
    { $lookup: { from: Project.collection.name, localField: "project", foreignField: "_id", as: "project" } }, { $unwind: "$project" },
    { $match: { "project.company": ctx.company, ...projectMatch } },
    { $sort: { "project.name": 1, _id: 1 } },
    { $facet: { count: [{ $count: "total" }], items: [{ $skip: (page - 1) * limit }, { $limit: limit }] } }];
  const [result] = await Assignment.aggregate(pipeline);
  const states = await historicalProjectStates(ctx.company, result.items.map((item: any) => item.project), date, day.context.timezone);
  return { data: result.items.map((item: any) => {
    const project = states.get(String(item.project._id));
    return { _id: project._id, name: project.name, code: project.code, assignmentId: item._id,
      effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo,
      available: project.status === "active" && project.startDate <= date && (!project.endDate || project.endDate >= date) };
  }), pagination: { page, limit, total: result.count[0]?.total || 0, totalPages: Math.max(1, Math.ceil((result.count[0]?.total || 0) / limit)) } };
});

export const listMyTimesheetWorkTypes = handler(async (req, ctx) => {
  const date = dateFor(req), project = objectId(req.query.projectId, "project id");
  if (!await Assignment.exists({ ...assignmentMatch(ctx, date), project })) throw generateError("Project is not assigned on this date", 404);
  const day = await resolveTimesheetDay(ctx.company, ctx.employee, date);
  if (!day.context.timezone) throw generateError("Configure a work schedule first", 409);
  const { page, limit, skip } = pagination(req.query);
  const match: any = { company: ctx.company, project };
  if (req.query.search) {
    const search = shortText(req.query.search, "Search", 1, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    match.$or = [{ name: { $regex: search, $options: "i" } }, { code: { $regex: search, $options: "i" } }];
  }
  const [types, total] = await Promise.all([WorkType.find(match).sort({ name: 1, _id: 1 }).skip(skip).limit(limit).lean(), WorkType.countDocuments(match)]);
  const states = await historicalProjectStates(ctx.company, types, date, day.context.timezone);
  return { data: types.map((type: any) => { const value = states.get(String(type._id)); return { _id: value._id, name: value.name, code: value.code, available: value.status === "active" }; }),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});

export const getMyTimesheetHistory = handler(async (req, ctx) => {
  const match = matchFor(ctx, dateFor(req));
  const { page, limit, skip } = pagination(req.query);
  const [data, total] = await Promise.all([Revision.find(match).select("-requestHash").sort({ revision: -1 }).skip(skip).limit(limit).lean(), Revision.countDocuments(match)]);
  return { data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
});

function requestIdentity(body: any) {
  if (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId)) throw generateError("requestId must contain 8 to 100 letters, digits, underscores, or hyphens", 400);
  if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw generateError("A non-negative integer revision is required (0 for a new day)", 400);
  if (!Array.isArray(body.entries) || body.entries.length > 100) throw generateError("Provide at most 100 entries", 422);
  const entries = body.entries.map((entry: any) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw generateError("Each entry must be an object", 400);
    const unknown = Object.keys(entry).filter((key) => !["entryId", "projectId", "workTypeId", "startDate", "startTime", "endDate", "endTime", "notes"].includes(key));
    if (unknown.length) throw generateError(`Unknown entry fields: ${unknown.join(", ")}`, 400);
    return [entry.entryId ?? null, entry.projectId, entry.workTypeId, entry.startDate, entry.startTime, entry.endDate, entry.endTime, entry.notes ?? ""];
  });
  return createHash("sha256").update(JSON.stringify({ revision: body.revision, entries })).digest("hex");
}
function replay(prior: any, hash: string) {
  if (prior.requestHash !== hash) throw generateError("This requestId was already used with a different payload", 409);
  return { data: prior.snapshot, replayed: true, message: "Previously accepted timesheet save" };
}

export const saveMyTimesheetDraft = handler(async (req, ctx) => {
  await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: String(ctx.company), actionLabel: "save timesheets" });
  const date = dateFor(req), match = matchFor(ctx, date);
  const hash = requestIdentity(req.body);
  const retryMatch = { ...match, requestId: req.body.requestId };
  const prior = await Revision.findOne(retryMatch).lean();
  if (prior) return replay(prior, hash);
  const session = await mongoose.startSession();
  let result: any;
  try {
    await session.withTransaction(async () => {
      const priorInTransaction = await Revision.findOne(retryMatch).session(session).lean();
      if (priorInTransaction) { result = replay(priorInTransaction, hash); return; }
      const sheet: any = await Timesheet.findOne(match).session(session).lean();
      if ((sheet?.revision || 0) !== req.body.revision) throw generateError("Timesheet changed. Refresh before saving.", 409);
      if (sheet && (sheet.status !== "draft" || sheet.payrollLockedAt)) throw generateError("Only unlocked draft timesheets can be edited", 409);
      const day = await resolveTimesheetDay(ctx.company, ctx.employee, date);
      if (!day.eligibility.canSave) {
        const issue = [...day.eligibility.setupIssues, ...day.eligibility.saveIssues][0];
        throw generateError(`${issue.code}: ${issue.message}`, 422);
      }
      const projectIds = req.body.entries.map((e: any) => objectId(e.projectId, "project id"));
      const typeIds = req.body.entries.map((e: any) => objectId(e.workTypeId, "work type id"));
      const [projects, workTypes, assignments] = await Promise.all([
        Project.find({ company: ctx.company, _id: { $in: projectIds } }).session(session).lean(),
        WorkType.find({ company: ctx.company, _id: { $in: typeIds } }).session(session).lean(),
        Assignment.find({ ...assignmentMatch(ctx, date), project: { $in: projectIds } }).session(session).lean(),
      ]);
      const states = await historicalProjectStates(ctx.company, [...projects, ...workTypes], date, day.context.timezone!, session);
      const validated = validateTimesheetEntries({ input: req.body.entries, existingEntries: sheet?.entries || [], rules: day.rules,
        context: day.context, requirement: day.requirement, record: day.record, now: new Date(),
        projects: new Map(projects.map((p: any) => [String(p._id), states.get(String(p._id))])),
        workTypes: new Map(workTypes.map((t: any) => [String(t._id), states.get(String(t._id))])),
        assignments: new Map(assignments.map((a: any) => [String(a.project), a])),
      });
      const values = { ...validated, timezone: day.context.timezone, status: "draft", requiredMinutes: day.requirement.requiredMinutes,
        shortfallMinutes: day.requirement.requiredMinutes == null ? null : Math.max(0, day.requirement.requiredMinutes - validated.loggedMinutes),
        contextSnapshot: timesheetContextSnapshot(day), updatedBy: ctx.actor._id, revision: req.body.revision + 1 };
      let saved: any;
      if (sheet) {
        saved = await Timesheet.findOneAndUpdate({ ...match, revision: sheet.revision, status: "draft", payrollLockedAt: null }, { $set: values }, { new: true, session, runValidators: true }).lean();
        if (!saved) throw generateError("Timesheet changed. Refresh before saving.", 409);
      } else {
        const [created] = await Timesheet.create([{ ...match, ...values, createdBy: ctx.actor._id }], { session });
        saved = created.toObject();
      }
      await Revision.create([{ ...retryMatch, timesheet: saved._id, revision: saved.revision, requestHash: hash, actor: ctx.actor._id, snapshot: saved }], { session });
      result = { data: saved, replayed: false, message: "Timesheet draft saved" };
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      const accepted = await Revision.findOne(retryMatch).lean();
      if (accepted) return replay(accepted, hash);
      throw generateError("Timesheet changed. Refresh before saving.", 409);
    }
    throw error;
  } finally { await session.endSession(); }
  return result;
});

export const getMyTimesheetSummary = handler(async (req, ctx) => {
  const from = dateKey(req.query.from, "From date")!, to = dateKey(req.query.to, "To date")!;
  if (from > to || to >= addDateDays(from, 31)) throw generateError("Choose a range of 1 to 31 days", 400);
  const sheets: any[] = await Timesheet.find({ company: ctx.company, employee: ctx.employee, attendanceDate: { $gte: from, $lte: to } }).select("attendanceDate status revision loggedMinutes requiredMinutes shortfallMinutes").sort({ attendanceDate: 1 }).limit(31).lean();
  const versionCache = new Map<string, Promise<any>>();
  const data: any[] = [];
  for (let date = from; date <= to; date = addDateDays(date, 1)) {
    const day = await resolveTimesheetDay(ctx.company, ctx.employee, date, new Date(), versionCache);
    const sheet = sheets.find((s) => s.attendanceDate === date);
    const requiredMinutes = day.requirement.requiredMinutes;
    data.push({ attendanceDate: date, status: sheet?.status || "missing", revision: sheet?.revision || 0, loggedMinutes: sheet?.loggedMinutes || 0,
      requiredMinutes, shortfallMinutes: requiredMinutes == null ? null : Math.max(0, requiredMinutes - (sheet?.loggedMinutes || 0)),
      required: day.eligibility.required, setupIssues: day.eligibility.setupIssues, saveIssues: day.eligibility.saveIssues, overdue: day.eligibility.overdue,
      dayType: day.context.dayType, timezone: day.context.timezone });
  }
  return { data, totals: { loggedMinutes: data.reduce((sum, d) => sum + d.loggedMinutes, 0), requiredMinutes: data.reduce((sum, d) => sum + (d.requiredMinutes || 0), 0), shortfallMinutes: data.reduce((sum, d) => sum + (d.shortfallMinutes || 0), 0), setupIssueDays: data.filter((d) => d.setupIssues.length).length }, range: { from, to } };
});
