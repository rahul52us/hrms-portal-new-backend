import { createHash, randomUUID } from "crypto";
import mongoose from "mongoose";
import { Asset, AssetAssignment as Assignment } from "../../schemas/Assets/Asset.schema";
import { AssetClearance as Clearance, AssetClearanceEvent as Event, AssetEmployeeControl as Control } from "../../schemas/Assets/AssetClearance.schema";
import { AssetIncident as Incident } from "../../schemas/Assets/AssetIncident.schema";
import { AssetWriteOff as WriteOff } from "../../schemas/Assets/AssetWriteOff.schema";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { attachEffectivePermissions, hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { upsertRequestNotifications } from "../notification/notification.service";
import { assetContext, AssetContext, assignmentDto, canViewAssets, expectedReturnDate, idString, objectId, pagination, revision, searchRegex, text } from "./asset.utils";
import { canManageClearances, fenceAssetEmployee } from "./assetClearance.guard";
import { clearanceCustodyMatch, clearanceDto, clearanceReadiness, visibleClearance } from "./assetClearance.utils";
import { incidentDto } from "./assetIncident.utils";

async function findClearance(ctx: AssetContext, id: string, session?: mongoose.ClientSession) {
  const row: any = await Clearance.findOne({ _id: objectId(id, "clearance id"), company: ctx.company }).session(session || null).lean();
  if (!row || !visibleClearance(ctx, row)) throw generateError("Asset clearance not found", 404);
  return row;
}
async function currentDetails(ctx: AssetContext, id: string, session: mongoose.ClientSession) {
  const row = await findClearance(ctx, id, session), control: any = await Control.findOne({ company: ctx.company, employee: row.employee }).session(session).lean();
  const summary = row.isCurrent ? await clearanceReadiness(ctx.company, row, session, control) : row.lastSummary;
  return clearanceDto(ctx, row, summary, control);
}
export const clearanceEmployees = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "manage"); if (!canManageClearances(ctx)) throw generateError("Manage Asset Clearances is required", 403);
    const { page, limit, skip } = pagination(req.query), search = searchRegex(req.query.search), match = { company: ctx.company, role: { $ne: "superadmin" }, _id: { $ne: ctx.actor._id }, ...(search ? { $or: [{ name: search }, { code: search }] } : {}) };
    const rows: any[] = await User.find(match).select("name code is_enabled deletedAt").sort({ name: 1, _id: 1 }).skip(skip).limit(limit).lean(), total = await User.countDocuments(match);
    const controls: any[] = await Control.find({ company: ctx.company, employee: { $in: rows.map((row) => row._id) }, issueBlocked: true }).select("employee clearance").lean();
    const data = rows.map((row) => ({ _id: row._id, name: row.name, code: row.code, archived: Boolean(row.deletedAt || row.is_enabled === false), currentClearance: controls.find((control) => idString(control.employee) === idString(row))?.clearance || null }));
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const listAssetClearances = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req), { page, limit, skip } = pagination(req.query), scope = req.query.scope || "mine", status = req.query.status || "all", search = searchRegex(req.query.search);
    if (!["mine", "company"].includes(scope) || !["all", "open", "cleared", "cancelled"].includes(status)) throw generateError("Invalid clearance filter", 400);
    if (scope === "company" && !canViewAssets(ctx)) throw generateError("View Assets is required for company clearances", 403);
    const match = { company: ctx.company, ...(scope === "mine" ? { employee: ctx.actor._id } : {}), ...(status === "all" ? {} : { status }), ...(search ? { $or: [{ reference: search }, { employeeName: search }, { employeeCode: search }] } : {}) };
    const data = await Clearance.find(match).select("reference employee employeeName employeeCode lastWorkingDate status isCurrent revision openedAt clearedAt clearerName cancelledAt createdAt").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Clearance.countDocuments(match);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const getAssetClearance = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req); let data: any;
    // Snapshot reads keep source counters and all readiness findings from the same point in time.
    await mongoose.connection.transaction(async (session) => { data = await currentDetails(ctx, req.params.clearanceId, session); }, { readConcern: { level: "snapshot" } });
    res.json({ success: true, data });
  } catch (error) { next(error); }
};
export const clearanceCustody = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req), row = await findClearance(ctx, req.params.clearanceId), { page, limit, skip } = pagination(req.query), scope = req.query.scope || "case";
    if (!["case", "outstanding"].includes(scope)) throw generateError("Choose case custody or current outstanding custody", 400);
    if (scope === "outstanding" && !row.isCurrent) throw generateError("Historical cancelled cases cannot expose later outstanding custody", 409);
    const match = scope === "outstanding" ? { company: ctx.company, employee: row.employee, active: true } : clearanceCustodyMatch(ctx.company, row);
    const assignments: any[] = await Assignment.find(match).sort({ issuedAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Assignment.countDocuments(match);
    const assets: any[] = await Asset.find({ company: ctx.company, _id: { $in: assignments.map((assignment) => assignment.asset) } }).select("status currentAssignment openIncident openWriteOff revision officeLocation locationName").lean();
    const cutoff = row.status === "cleared" ? row.clearedAt : row.status === "cancelled" ? row.cancelledAt : null;
    const data = assignments.map((assignment) => {
      const closedAt = assignment.returnedAt || assignment.voidedAt || assignment.writtenOffAt;
      return { ...assignmentDto(ctx, assignment, assets.find((asset) => idString(asset) === idString(assignment.asset))), statusAtDecision: cutoff ? !closedAt || new Date(closedAt) > new Date(cutoff) ? "outstanding" : assignment.status : null };
    });
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const clearanceReviews = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req), row = await findClearance(ctx, req.params.clearanceId), { page, limit, skip } = pagination(req.query), kind = req.query.kind || "incidents";
    if (!row.isCurrent) throw generateError("Use the historical decision evidence for a cancelled clearance", 409);
    if (!["incidents", "writeoffs"].includes(kind)) throw generateError("Invalid clearance review kind", 400);
    if (kind === "writeoffs" && !canViewAssets(ctx)) throw generateError("Write-off details require company View Assets; only the generic pending count is shared", 403);
    const model = kind === "incidents" ? Incident : WriteOff, match = { company: ctx.company, employee: row.employee, ...(kind === "incidents" ? { active: true } : { status: "pending" }) };
    const rows: any[] = await model.find(match).select(kind === "incidents" ? "reference assetSnapshot kind status occurredAt description reporterName employeeName employeeCode createdAt active" : "reference assetSnapshot status createdAt").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await model.countDocuments(match);
    const data = kind === "incidents" ? rows.map((incident) => incidentDto(ctx, incident)) : rows;
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const clearanceHistory = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req), row = await findClearance(ctx, req.params.clearanceId), { page, limit, skip } = pagination(req.query), match = { company: ctx.company, clearance: row._id };
    const data = await Event.find(match).select("actorName action reason before after createdAt").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Event.countDocuments(match);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
async function notify(ctx: AssetContext, row: any, action: string, session: mongoose.ClientSession) {
  const people = await User.find({ company: ctx.company, _id: { $in: [row.employee, row.createdBy] }, deletedAt: null, is_enabled: { $ne: false } }).select("_id role company permissions accessRole").session(session).lean();
  const company = await Company.findById(ctx.company).select("rolePermissions").session(session).lean();
  const recipients = people.filter((person) => idString(person) === idString(row.employee) || hasPermission(attachEffectivePermissions({ user: person, company }), PERMISSION_KEYS.VIEW_ASSETS)).map((person) => person._id);
  await upsertRequestNotifications({ company: ctx.company, actor: ctx.actor._id, recipients, entityType: "asset_clearance", entityId: row._id, eventType: `assets.clearance_${action}`, title: action === "clear" ? "Employee asset clearance recorded" : "Employee asset clearance updated", message: `${row.reference}: ${row.employeeName} - ${row.status}. No employment, login or payroll status was changed.`, category: "system", priority: action === "created" || action === "reopen" ? "high" : "medium", actionUrl: `/dashboard/assets?clearanceId=${row._id}`, dedupeEventKey: `asset-clearance:${action}:${row.revision}` }, session);
}
type Action = "created" | "clear" | "reopen" | "cancel" | "reschedule" | "note";
const snapshot = (row: any) => ({ status: row.status, revision: row.revision, cycle: row.cycle, isCurrent: row.isCurrent, lastWorkingDate: row.lastWorkingDate, clearedAt: row.clearedAt || null, clearanceEvidence: row.clearanceEvidence || null, summary: row.lastSummary });
export const mutateAssetClearance = (action: Action) => async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "manage"), body = req.body || {};
    if (!canManageClearances(ctx)) throw generateError("Manage Asset Clearances is required", 403);
    await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: idString(ctx.company), actionLabel: "manage asset clearance" });
    for (const model of [Clearance, Event, Control, Asset, Assignment, Incident, WriteOff]) await model.init();
    const requestId = text(body.requestId, "Request id", 8, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 422);
    const input: any = { action, target: idString(objectId(action === "created" ? body.employeeId : req.params.clearanceId, action === "created" ? "employee id" : "clearance id")), reason: text(body.reason, "Clearance reason / shared note", 3, 1000) };
    if (action !== "created") input.revision = revision(body.revision);
    if (["created", "reschedule"].includes(action)) { input.lastWorkingDate = expectedReturnDate(body.lastWorkingDate, "Last working date"); if (!input.lastWorkingDate) throw generateError("Choose the expected last working date", 422); }
    if (action === "created") { if (body.confirmIssueHold !== true) throw generateError("Confirm new equipment issues must be blocked during clearance", 422); input.confirmIssueHold = true; }
    if (action === "cancel") { if (body.confirmReleaseIssueHold !== true) throw generateError("Confirm cancellation releases the issue hold without reversing actual custody events", 422); input.confirmReleaseIssueHold = true; }
    if (action === "clear") {
      if (body.confirmNoOutstandingCustody !== true || !Number.isSafeInteger(body.evidenceRevision) || body.evidenceRevision < 0) throw generateError("Load current readiness and confirm custody outcomes before clearance", 422);
      input.evidenceRevision = body.evidenceRevision; input.confirmNoOutstandingCustody = true; input.confirmReviewedIncidents = body.confirmReviewedIncidents === true;
    }
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    let resultId = "", replayed = false;
    const replay = async (session?: mongoose.ClientSession) => {
      const prior: any = await Event.findOne({ company: ctx.company, actor: ctx.actor._id, requestId }).select("+requestHash").session(session || null).lean();
      if (!prior) return false;
      if (prior.requestHash !== requestHash) throw generateError("Request id already used for another clearance action", 409);
      await findClearance(ctx, idString(prior.clearance), session); resultId = idString(prior.clearance); replayed = true; return true;
    };
    try { await mongoose.connection.transaction(async (session) => {
      if (await replay(session)) return;
      let row: any, control: any, before: any = null; const now = new Date();
      if (action === "created") {
        const employee: any = await User.findOne({ _id: input.target, company: ctx.company, role: { $ne: "superadmin" } }).select("name code").session(session).lean();
        if (!employee) throw generateError("Employee not found", 404);
        if (idString(employee) === idString(ctx.actor)) throw generateError("Another authorised manager must handle your own asset clearance", 403);
        control = await fenceAssetEmployee(ctx.company, employee._id, session, false, false);
        if (control.clearance || control.issueBlocked || await Clearance.exists({ company: ctx.company, employee: employee._id, isCurrent: true }).session(session)) throw generateError("This employee already has a current asset clearance. Open that case instead.", 409);
        const draft = { _id: new mongoose.Types.ObjectId(), company: ctx.company, employee: employee._id, employeeName: employee.name || employee.code || "Employee", employeeCode: employee.code || "", reference: `CLR-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`, openedAt: now, issueSequenceCutoff: control.revision, lastWorkingDate: input.lastWorkingDate, createdBy: ctx.actor._id, creatorName: ctx.actor.name || "Asset manager", openingReason: input.reason };
        const summary = await clearanceReadiness(ctx.company, draft, session, control);
        row = (await Clearance.create([{ ...draft, initialOutstanding: summary.outstanding, lastSummary: summary }], { session }))[0].toObject();
        const held = await Control.updateOne({ _id: control._id, revision: control.revision, issueBlocked: false, clearance: null }, { $set: { issueBlocked: true, clearance: row._id } }, { session });
        if (!held.matchedCount) throw generateError("Employee issue controls changed. Reload before opening clearance.", 409);
      } else {
        row = await findClearance(ctx, input.target, session);
        if (idString(row.employee) === idString(ctx.actor)) throw generateError("Another authorised manager must handle your own asset clearance", 403);
        if (!row.isCurrent || row.revision !== input.revision) throw generateError("Clearance changed or was cancelled. Reload before continuing.", 409);
        control = await fenceAssetEmployee(ctx.company, row.employee, session, false, false);
        if (!control.issueBlocked || idString(control.clearance) !== idString(row)) throw generateError("Clearance issue hold is inconsistent; review controls before proceeding", 409);
        const summary = await clearanceReadiness(ctx.company, row, session, control); before = snapshot(row); let changes: any = { lastSummary: summary };
        if (action === "clear") {
          if (row.status !== "open") throw generateError("Reopen an already-cleared case before recording another decision", 409);
          if (summary.evidenceRevision !== input.evidenceRevision) throw generateError("Custody or administrative reviews changed. Reload readiness and review again.", 409);
          if (!summary.ready) throw generateError("Outstanding custody, pending loss decisions or inventory inconsistencies must be resolved before clearance", 409);
          if (summary.openIncidents && !input.confirmReviewedIncidents) throw generateError("Explicitly review remaining incidents on returned equipment; this does not close or settle those cases", 422);
          const evidence = { ...summary, reviewedOpenIncidents: input.confirmReviewedIncidents, issueSequenceCutoff: row.issueSequenceCutoff, scope: "asset_custody_only" };
          changes = { ...changes, status: "cleared", clearedAt: now, clearedBy: ctx.actor._id, clearerName: ctx.actor.name || "Asset manager", clearanceReason: input.reason, clearanceEvidence: { ...evidence, checksum: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") } };
        } else if (action === "reopen") {
          if (row.status !== "cleared") throw generateError("Only a cleared case can be reopened", 409);
          changes = { ...changes, status: "open", cycle: (row.cycle || 1) + 1, clearedAt: null, clearedBy: null, clearerName: "", clearanceReason: "", clearanceEvidence: null };
        } else if (action === "cancel") {
          changes = { ...changes, status: "cancelled", isCurrent: false, cancelledAt: now, cancelledBy: ctx.actor._id, cancellerName: ctx.actor.name || "Asset manager", cancellationReason: input.reason };
          const released = await Control.updateOne({ _id: control._id, revision: control.revision, clearance: row._id, issueBlocked: true }, { $set: { clearance: null, issueBlocked: false } }, { session });
          if (!released.matchedCount) throw generateError("Employee issue controls changed during cancellation", 409);
        } else if (action === "reschedule") {
          if (row.status !== "open") throw generateError("Reopen the case before changing its expected last working date", 409);
          changes.lastWorkingDate = input.lastWorkingDate;
        }
        row = await Clearance.findOneAndUpdate({ _id: row._id, company: ctx.company, revision: input.revision, isCurrent: true }, { $set: changes, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
        if (!row) throw generateError("Clearance changed. Reload before continuing.", 409);
      }
      await Event.create([{ company: ctx.company, clearance: row._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", action, reason: input.reason, requestId, requestHash, before, after: snapshot(row) }], { session });
      if (action !== "note") await notify(ctx, row, action, session);
      resultId = idString(row);
    }, { readConcern: { level: "snapshot" } }); } catch (error: any) {
      if (error.code !== 11000) throw error;
      if (!await replay()) throw generateError("A current clearance or employee-control change already exists. Reload before retrying.", 409);
    }
    let data: any; await mongoose.connection.transaction(async (session) => { data = await currentDetails(ctx, resultId, session); }, { readConcern: { level: "snapshot" } });
    res.status(action === "created" && !replayed ? 201 : 200).json({ success: true, data, replayed });
  } catch (error) { next(error); }
};
