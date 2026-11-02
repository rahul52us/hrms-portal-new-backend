import mongoose from "mongoose";
import ExcelJS from "exceljs";
import User from "../../schemas/User/User";
import Department from "../../schemas/Department/Department.schema";
import Location from "../../schemas/OfficeLocation/OfficeLocation.schema";
import Project from "../../schemas/project/Project.schema";
import Timesheet from "../../schemas/Timesheet/Timesheet.schema";
import { generateError } from "../../config/Error/functions";
import { dateKey, objectId } from "../project/project.utils";
import { timesheetOperationsContext, timesheetEmployeeAllowed, loadTimesheetScopedEmployee } from "./timesheetOperationsAccess.service";
import { dayControlCapabilities } from "./timesheetDayControl.service";
import { addOperationsRow, hoursText, operationRowMatches, operationsDates, operationsFilters, operationsSummary, safeSpreadsheetText, tsId } from "./timesheetOperations.utils";
import { buildOperationsDays, effectiveOrganization, visitOperationsEmployees } from "./timesheetOperationsBatch.service";
import { timesheetPagination } from "./timesheetRules.utils";
import { resolveTimesheetDay } from "./timesheetContext.service";
import { serializeDay } from "./timesheet.service";
import { dateInZone } from "./timesheet.utils";

const EXPORT_LIMIT = 5000;
const pattern = (value: string) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
async function context(req: any, view: string) {
  const ctx = await timesheetOperationsContext(req), filters = operationsFilters(req.query), dates = operationsDates(req.query, view);
  if (ctx.scope === "projects" && view !== "effort") throw generateError("Project scope permits project/work-type effort only", 403);
  if (ctx.scope === "projects" && ["employeeId", "managerId", "departmentId", "teamId", "officeLocationId", "search"].some((key) => filters[key])) throw generateError("Project scope supports project and work-type filters only", 400);
  if (view === "monthly" && (filters.status !== "all" || filters.projectId || filters.workTypeId)) throw generateError("Monthly supports employee and organization filters; use Daily or Project effort for work/status filters", 400);
  return { ...ctx, filters, dates };
}

export async function loadTimesheetRegister(ctx: any, page: number, limit: number) {
  const summary = operationsSummary(), data: any[] = [], skip = (page - 1) * limit;
  let batch: any[] = [], histories: any[] = [];
  async function flush() {
    const rows = await buildOperationsDays(ctx.company, batch, ctx.dates, histories);
    for (const row of rows) {
      const workMatches = !ctx.filters.projectId && !ctx.filters.workTypeId || row.workAssignments.some((entry: any) => (!ctx.filters.projectId || entry.projectId === ctx.filters.projectId) && (!ctx.filters.workTypeId || entry.workTypeId === ctx.filters.workTypeId));
      if (!timesheetEmployeeAllowed(ctx, row.employee, row.organization) || !workMatches || !operationRowMatches(row, ctx.filters)) continue;
      if (summary.rows >= skip && data.length < limit) data.push(row);
      addOperationsRow(summary, row);
    }
    batch = []; histories = [];
  }
  await visitOperationsEmployees(ctx, ctx.dates, async (employee, history) => { batch.push(employee); histories.push(...history); if (batch.length >= 250) await flush(); });
  if (batch.length) await flush();
  return { data, summary, pagination: { page, limit, total: summary.rows, totalPages: Math.max(1, Math.ceil(summary.rows / limit)) } };
}

export async function loadTimesheetMonthly(ctx: any, page: number, limit: number) {
  let total = 0;
  const selected: any[] = [], histories: any[] = [], skip = (page - 1) * limit;
  await visitOperationsEmployees(ctx, ctx.dates, (employee, history) => {
    if (total >= skip && selected.length < limit) { selected.push(employee); histories.push(...history); } total++;
  });
  if (limit === EXPORT_LIMIT + 1 && total > EXPORT_LIMIT) throw generateError("Export is limited to 5,000 rows; narrow the filters", 422);
  const result: any[] = [], pageTotals = operationsSummary();
  for (let start = 0; start < selected.length; start += 25) {
    const employees = selected.slice(start, start + 25), ids = new Set(employees.map(tsId));
    const rows = await buildOperationsDays(ctx.company, employees, ctx.dates, histories.filter((h) => ids.has(tsId(h.employee))));
    for (const employee of employees) {
      const days = rows.filter((row) => tsId(row.employee) === tsId(employee) && timesheetEmployeeAllowed(ctx, row.employee, row.organization) && [["departmentId", "department"], ["teamId", "teamId"], ["officeLocationId", "officeLocation"], ["managerId", "reportingManager"]].every(([key, field]) => !ctx.filters[key] || ctx.filters[key] === tsId(row.organization[field])));
      const totals = operationsSummary();
      for (const row of days) { addOperationsRow(totals, row); addOperationsRow(pageTotals, row); }
      result.push({ employee: { _id: tsId(employee), name: employee.name, code: employee.code }, ...totals, days: days.map(({ attendanceDate, state, requiredMinutes, loggedMinutes, shortfallMinutes, shortHours, overdue, stale, hrExemption, exemptMinutes, deadlineExtended }) => ({ attendanceDate, state, requiredMinutes, loggedMinutes, shortfallMinutes, shortHours, overdue, stale, hrExemption, exemptMinutes, deadlineExtended })) });
    }
  }
  return { data: result, summary: pageTotals, summaryScope: "page", pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

function savedScopeMatch(ctx: any) {
  const match: any = { company: ctx.company, attendanceDate: { $gte: ctx.dates[0], $lte: ctx.dates[ctx.dates.length - 1] } };
  const filters: any = {};
  const org = "contextSnapshot.organizationAssignment";
  if (ctx.scope === "reportees") { match[`${org}.reportingManager`] = ctx.actor._id; match.employee = { $ne: ctx.actor._id }; }
  if (ctx.scope === "organization" && ctx.actor.role === "departmenthead") match[`${org}.departmentNameSnapshot`] = new RegExp(`^${pattern(ctx.actor.department || "__missing_scope__").source}$`, "i");
  if (ctx.scope === "organization" && ctx.actor.role === "hr") {
    const scope = ctx.actor.hrScope || {};
    match[`${org}.departmentNameSnapshot`] = { $in: (scope.departments || []).map((name: string) => new RegExp(`^${pattern(name).source}$`, "i")) };
    if (scope.teams?.length) match[`${org}.teamNameSnapshot`] = { $in: scope.teams.map((name: string) => new RegExp(`^${pattern(name).source}$`, "i")) };
    if (scope.officeLocations?.length) match[`${org}.officeLocation`] = { $in: scope.officeLocations.map((id: any) => objectId(tsId(id), "scope location")) };
  }
  for (const [key, field] of [["departmentId", "department"], ["teamId", "teamId"], ["officeLocationId", "officeLocation"], ["managerId", "reportingManager"]]) if (ctx.filters[key]) filters[`${org}.${field}`] = objectId(ctx.filters[key], key);
  if (ctx.filters.employeeId) {
    filters.employee = objectId(ctx.filters.employeeId, "employee id");
  }
  if (!["all", "short_hours", "overdue", "stale"].includes(ctx.filters.status)) match.status = ctx.filters.status;
  return { $and: [match, filters] };
}
async function effortPipeline(ctx: any) {
  if (!["all", "draft", "submitted", "approved", "returned", "rejected"].includes(ctx.filters.status)) throw generateError("Project effort supports stored workflow status only", 400);
  const pipeline: any[] = [{ $match: savedScopeMatch(ctx) }];
  if (ctx.filters.search) pipeline.push({ $lookup: { from: User.collection.name, localField: "employee", foreignField: "_id", pipeline: [{ $project: { name: 1, code: 1 } }], as: "person" } }, { $match: { $or: [{ "person.name": pattern(ctx.filters.search) }, { "person.code": pattern(ctx.filters.search) }] } });
  pipeline.push({ $unwind: "$entries" });
  const match: any = {};
  if (ctx.scope === "projects") {
    const managed: any[] = await Project.find({ company: ctx.company, managers: ctx.actor._id }).select("_id").lean();
    const ids = managed.map((p) => tsId(p));
    if (ctx.filters.projectId && !ids.includes(ctx.filters.projectId)) throw generateError("Project is outside your management scope", 403);
    match["entries.project"] = { $in: managed.map((p) => p._id) };
  }
  if (ctx.filters.projectId) match["entries.project"] = objectId(ctx.filters.projectId, "project id");
  if (ctx.filters.workTypeId) match["entries.workType"] = objectId(ctx.filters.workTypeId, "work type id");
  if (Object.keys(match).length) pipeline.push({ $match: match });
  return pipeline;
}
export async function loadTimesheetEffort(ctx: any, page: number, limit: number) {
  const pipeline = await effortPipeline(ctx);
  pipeline.push(
    { $group: { _id: { project: "$entries.project", workType: "$entries.workType", employee: "$employee", date: "$attendanceDate" }, projectName: { $first: "$entries.projectNameSnapshot" }, projectCode: { $first: "$entries.projectCodeSnapshot" }, workTypeName: { $first: "$entries.workTypeNameSnapshot" }, loggedMinutes: { $sum: "$entries.minutes" }, approvedMinutes: { $sum: { $cond: [{ $eq: ["$status", "approved"] }, "$entries.minutes", 0] } } } },
    { $group: { _id: { project: "$_id.project", workType: "$_id.workType", employee: "$_id.employee" }, projectName: { $first: "$projectName" }, projectCode: { $first: "$projectCode" }, workTypeName: { $first: "$workTypeName" }, loggedMinutes: { $sum: "$loggedMinutes" }, approvedMinutes: { $sum: "$approvedMinutes" }, employeeDays: { $sum: 1 } } },
    { $group: { _id: { project: "$_id.project", workType: "$_id.workType" }, projectName: { $first: "$projectName" }, projectCode: { $first: "$projectCode" }, workTypeName: { $first: "$workTypeName" }, loggedMinutes: { $sum: "$loggedMinutes" }, approvedMinutes: { $sum: "$approvedMinutes" }, employeeDays: { $sum: "$employeeDays" }, employees: { $sum: 1 } } },
    { $sort: { projectName: 1, workTypeName: 1, "_id.project": 1, "_id.workType": 1 } },
    { $facet: { data: [{ $skip: (page - 1) * limit }, { $limit: limit }], summary: [{ $group: { _id: null, rows: { $sum: 1 }, loggedMinutes: { $sum: "$loggedMinutes" }, approvedMinutes: { $sum: "$approvedMinutes" }, employeeDays: { $sum: "$employeeDays" } } }] } },
  );
  const [result] = await Timesheet.aggregate(pipeline).allowDiskUse(true);
  const summary = result.summary[0] || { rows: 0, loggedMinutes: 0, approvedMinutes: 0, employeeDays: 0 };
  return { data: result.data.map((row: any) => ({ ...row, projectId: tsId(row._id.project), workTypeId: tsId(row._id.workType) })), summary, pagination: { page, limit, total: summary.rows, totalPages: Math.max(1, Math.ceil(summary.rows / limit)) } };
}

const handler = (work: (req: any, res: any) => Promise<void>) => async (req: any, res: any, next: any) => { try { await work(req, res); } catch (error) { next(error); } };
export const getTimesheetOperationsOptions = handler(async (req, res) => {
  const ctx = await timesheetOperationsContext(req);
  res.json({ success: true, data: { ...ctx.access, today: dateInZone(new Date(), "UTC") } });
});
export const getTimesheetOperationsReport = (view: string) => handler(async (req, res) => {
  const ctx = await context(req, view), { page, limit } = timesheetPagination(req.query, 100);
  const result = view === "register" ? await loadTimesheetRegister(ctx, page, limit) : view === "monthly" ? await loadTimesheetMonthly(ctx, page, limit) : await loadTimesheetEffort(ctx, page, limit);
  res.json({ success: true, ...result });
});
export const getTimesheetOperationsDay = handler(async (req, res) => {
  const ctx = await timesheetOperationsContext(req), employeeId = objectId(req.params.employeeId, "employee id"), date = dateKey(req.params.date, "Work date")!;
  const { employee, organization } = await loadTimesheetScopedEmployee(ctx, employeeId, date);
  const [sheet, day] = await Promise.all([Timesheet.findOne({ company: ctx.company, employee: employeeId, attendanceDate: date }).lean(), resolveTimesheetDay(ctx.company, employeeId, date, new Date(), undefined, true)]);
  res.json({ success: true, data: { ...serializeDay(day, sheet), employee, organization, controlCapabilities: dayControlCapabilities(ctx, employeeId, sheet, day.controls) } });
});

export const getTimesheetOperationsLookup = handler(async (req, res) => {
  const ctx = await timesheetOperationsContext(req), kind = String(req.query.kind), { page, limit, skip } = timesheetPagination(req.query, 50);
  const search = String(req.query.search || "").trim(); if (search.length > 100) throw generateError("Search is too long", 400);
  const filters = operationsFilters({ ...req.query, search: "", status: "all", ...(kind === "employee" ? { employeeId: undefined } : {}) });
  if (ctx.scope === "projects" && ["employeeId", "managerId", "departmentId", "teamId", "officeLocationId"].some((key) => filters[key])) throw generateError("Project scope supports project and work-type filters only", 400);
  const date = dateKey(req.query.date, "Work date")!;
  const lookupDates = req.query.month ? operationsDates(req.query, "monthly") : req.query.from || req.query.to ? operationsDates(req.query, "effort") : [date];
  let data: any[] = [];
  if (["employee", "manager"].includes(kind)) {
    if (ctx.scope === "projects") throw generateError("Project scope does not expose employee selectors", 403);
    const seen = new Set<string>(), selected: any[] = []; let matched = 0;
    await visitOperationsEmployees({ ...ctx, filters }, lookupDates, (employee, histories, visibleDates) => {
      if (kind === "employee") {
        if (!search || pattern(search).test(`${employee.name} ${employee.code}`)) { if (matched++ >= skip) selected.push(employee); }
        return selected.length >= limit + 1 ? false : undefined;
      }
      for (const visibleDate of visibleDates) {
        const org = effectiveOrganization(employee, histories, visibleDate), key = tsId(org.reportingManager);
        if (key && !seen.has(key)) { seen.add(key); selected.push(org.reportingManager); }
      }
    });
    const people: any[] = kind === "employee" ? selected : await User.find({ company: ctx.company, _id: { $in: selected } }).select("_id name code").lean();
    data = (kind === "employee" ? people : people.filter((p) => !search || pattern(search).test(`${p.name} ${p.code}`)).sort((a, b) => tsId(a).localeCompare(tsId(b))).slice(skip, skip + limit + 1)).map((p) => ({ _id: tsId(p), name: p.name, code: p.code || "" }));
  } else if (["project", "work_type"].includes(kind)) {
    if (kind === "work_type" && !filters.projectId) throw generateError("Select a project first", 400);
    if (kind === "project" && ctx.scope === "projects") {
      const match: any = { company: ctx.company, managers: ctx.actor._id }; if (search) match.$or = [{ name: pattern(search) }, { code: pattern(search) }];
      data = await Project.find(match).select("name code").sort({ name: 1, _id: 1 }).skip(skip).limit(limit + 1).lean();
    } else {
      const pipeline = await effortPipeline({ ...ctx, dates: lookupDates, filters });
      const field = kind === "project" ? "project" : "workType", name = kind === "project" ? "projectNameSnapshot" : "workTypeNameSnapshot", code = kind === "project" ? "projectCodeSnapshot" : "workTypeCodeSnapshot";
      pipeline.push({ $group: { _id: `$entries.${field}`, name: { $first: `$entries.${name}` }, code: { $first: `$entries.${code}` } } });
      if (search) pipeline.push({ $match: { $or: [{ name: pattern(search) }, { code: pattern(search) }] } });
      pipeline.push({ $sort: { name: 1, _id: 1 } }, { $skip: skip }, { $limit: limit + 1 }); data = await Timesheet.aggregate(pipeline);
    }
  } else if (["department", "team", "location"].includes(kind)) {
    if (ctx.scope === "projects") throw generateError("Project scope does not expose organization selectors", 403);
    const match: any = { company: ctx.company };
    if (kind === "location") {
      if (ctx.actor.role === "hr" && ctx.actor.hrScope?.officeLocations?.length) match._id = { $in: ctx.actor.hrScope.officeLocations };
      if (search) match.$or = [{ name: pattern(search) }, { code: pattern(search) }];
      data = await Location.find(match).select("name code").sort({ name: 1, _id: 1 }).skip(skip).limit(limit + 1).lean();
    } else {
      if (ctx.actor.role === "hr") match.departmentName = { $in: (ctx.actor.hrScope?.departments || []).map((name: string) => new RegExp(`^${pattern(name).source}$`, "i")) };
      if (ctx.actor.role === "departmenthead") match.departmentName = new RegExp(`^${pattern(ctx.actor.department || "__none__").source}$`, "i");
      if (filters.departmentId) match._id = objectId(filters.departmentId, "department id");
      const pipeline: any[] = [{ $match: match }];
      if (kind === "team") {
        pipeline.push({ $unwind: "$teams" });
        if (ctx.actor.role === "hr" && ctx.actor.hrScope?.teams?.length) pipeline.push({ $match: { "teams.name": { $in: ctx.actor.hrScope.teams.map((name: string) => new RegExp(`^${pattern(name).source}$`, "i")) } } });
        pipeline.push({ $project: { _id: "$teams._id", name: "$teams.name", code: "$departmentName" } });
      } else pipeline.push({ $project: { name: "$departmentName", code: 1 } });
      if (search) pipeline.push({ $match: { name: pattern(search) } });
      pipeline.push({ $sort: { name: 1, _id: 1 } }, { $skip: skip }, { $limit: limit + 1 }); data = await Department.aggregate(pipeline);
    }
  } else throw generateError("Invalid lookup kind", 400);
  res.json({ success: true, data: data.slice(0, limit), pagination: { page, limit, hasMore: data.length > limit } });
});

export const exportTimesheetOperations = handler(async (req, res) => {
  const view = String(req.query.view || "register"); if (!["register", "monthly", "effort"].includes(view)) throw generateError("Invalid report view", 400);
  const format = String(req.query.format || "csv"); if (!["csv", "xlsx"].includes(format)) throw generateError("Choose csv or xlsx", 400);
  const ctx = await context(req, view); if (!ctx.access.canExport) throw generateError("Timesheet export permission is required", 403);
  const result = view === "register" ? await loadTimesheetRegister(ctx, 1, EXPORT_LIMIT + 1) : view === "monthly" ? await loadTimesheetMonthly(ctx, 1, EXPORT_LIMIT + 1) : await loadTimesheetEffort(ctx, 1, EXPORT_LIMIT + 1);
  if (result.pagination.total > EXPORT_LIMIT) throw generateError("Export is limited to 5,000 rows; narrow the filters", 422);
  const columns = view === "effort" ? ["Project", "Work type", "Employees", "Employee-days", "Logged (HH:mm)", "Approved (HH:mm)"] : view === "monthly" ? ["Employee", "Employee code", "Month", "Scoped days", "Required (HH:mm)", "Logged (HH:mm)", "Approved (HH:mm)", "Shortfall (HH:mm)", "Missing days", "Pending days", "Setup issues", "Stale days"] : ["Employee", "Employee code", "Work date", "Department", "Team", "Location", "Status", "Required (HH:mm)", "Logged (HH:mm)", "Approved (HH:mm)", "Shortfall (HH:mm)", "Overdue", "Stale"];
  const rows = result.data.map((r: any) => (view === "effort" ? [r.projectName, r.workTypeName, r.employees, r.employeeDays, hoursText(r.loggedMinutes), hoursText(r.approvedMinutes)] : view === "monthly" ? [r.employee.name, r.employee.code, req.query.month, r.rows, hoursText(r.requiredMinutes), hoursText(r.loggedMinutes), hoursText(r.approvedMinutes), hoursText(r.shortfallMinutes), r.missing, r.submitted, r.setup_incomplete, r.stale] : [r.employee.name, r.employee.code, r.attendanceDate, r.organization.departmentNameSnapshot, r.organization.teamNameSnapshot, r.organization.officeLocationNameSnapshot, r.state, hoursText(r.requiredMinutes), hoursText(r.loggedMinutes), hoursText(r.approvedMinutes), hoursText(r.shortfallMinutes), r.overdue ? "Yes" : "No", r.stale ? "Yes" : "No"]).map((value: any) => typeof value === "number" ? value : safeSpreadsheetText(value)));
  if (view !== "effort") {
    columns.push("HR exempt (HH:mm)", "Exemption days");
    result.data.forEach((row: any, index: number) => rows[index].push(hoursText(row.exemptMinutes || 0), view === "monthly" ? row.exempt : row.hrExemption ? 1 : 0));
  }
  const filename = `timesheets-${view}-${ctx.dates[0]}.${format}`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  if (format === "csv") { res.type("text/csv"); const cell = (value: any) => `"${String(value ?? "").replace(/"/g, '""')}"`; res.send("\uFEFF" + [columns, ...rows].map((row) => row.map(cell).join(",")).join("\r\n")); }
  else { const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("Timesheets"); sheet.addRow(columns); for (const row of rows) sheet.addRow(row); sheet.getRow(1).font = { bold: true }; sheet.views = [{ state: "frozen", ySplit: 1 }]; sheet.columns.forEach((column) => { column.width = 24; column.numFmt = "@"; }); res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); res.send(Buffer.from(await workbook.xlsx.writeBuffer())); }
});
