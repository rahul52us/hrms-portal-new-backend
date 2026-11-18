import { createHash, randomUUID } from "crypto";
import mongoose from "mongoose";
import { Asset, AssetAssignment as Assignment, AssetAudit as Audit } from "../../schemas/Assets/Asset.schema";
import { AssetIncident as Incident, AssetIncidentEvent as Event, INCIDENT_KINDS, INCIDENT_STATES } from "../../schemas/Assets/AssetIncident.schema";
import User from "../../schemas/User/User";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { upsertRequestNotifications } from "../notification/notification.service";
import { initializeOnboardingAssets, syncOnboardingAssetCustody } from "../onboarding/onboardingAsset.service";
import { assetContext, AssetContext, assetDto, canManageAssets, canViewAssets, idString, objectId, pagination, revision, searchRegex, text } from "./asset.utils";
import { canReadIncident, incidentDto, incidentOccurredAt } from "./assetIncident.utils";
import { AssetEmployeeControl as EmployeeControl } from "../../schemas/Assets/AssetClearance.schema";
import { fenceAssetEmployee, notifyClearanceChange } from "./assetClearance.guard";

async function findIncident(ctx: AssetContext, id: string, session?: mongoose.ClientSession) {
  const incident: any = await Incident.findOne({ company: ctx.company, _id: objectId(id, "incident id") }).session(session || null).lean();
  if (!incident || !canReadIncident(ctx, incident)) throw generateError("Asset incident not found", 404);
  return incident;
}
async function currentDto(ctx: AssetContext, id: string) {
  const incident = await findIncident(ctx, id);
  const asset = canViewAssets(ctx) ? await Asset.findOne({ company: ctx.company, _id: incident.asset }).select("openIncident openService openWriteOff writtenOffRecord revision status").lean() : null;
  return incidentDto(ctx, incident, asset);
}
export const listAssetIncidents = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req), { page, limit, skip } = pagination(req.query), scope = req.query.scope || "mine", state = req.query.status || "active", kind = req.query.kind || "all", search = searchRegex(req.query.search);
    if (!["mine", "company"].includes(scope) || !["all", "active", ...INCIDENT_STATES].includes(state) || kind !== "all" && !INCIDENT_KINDS.includes(kind)) throw generateError("Invalid incident filter", 400);
    if (scope === "company" && !canViewAssets(ctx)) throw generateError("View Assets is required for company incidents", 403);
    const match = { $and: [{ company: ctx.company, ...(state === "active" ? { active: true } : state === "all" ? {} : { status: state }), ...(kind === "all" ? {} : { kind }), ...(req.query.assetId ? { asset: objectId(req.query.assetId, "asset id") } : {}) },
      ...(scope === "mine" ? [{ $or: [{ employee: ctx.actor._id }, { reportedBy: ctx.actor._id }] }] : []), ...(search ? [{ $or: [{ reference: search }, { "assetSnapshot.name": search }, { "assetSnapshot.tag": search }, { employeeName: search }, { employeeCode: search }] }] : [])] };
    const data = await Incident.find(match).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Incident.countDocuments(match);
    res.json({ success: true, data: data.map((row) => incidentDto(ctx, row)), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const getAssetIncident = async (req: any, res: any, next: any) => { try { const ctx = assetContext(req); res.json({ success: true, data: await currentDto(ctx, req.params.incidentId) }); } catch (error) { next(error); } };
export const assetIncidentHistory = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req), incident = await findIncident(ctx, req.params.incidentId), { page, limit, skip } = pagination(req.query), match = { company: ctx.company, incident: incident._id };
    const data = await Event.find(match).select("actorName action reason createdAt before after").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Event.countDocuments(match);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};

async function notify(ctx: AssetContext, incident: any, action: string, session: mongoose.ClientSession) {
  const people = await User.find({ company: ctx.company, _id: { $in: [incident.employee, incident.reportedBy].filter(Boolean) }, deletedAt: null, is_enabled: { $ne: false } }).select("_id").session(session).lean();
  await upsertRequestNotifications({ company: ctx.company, actor: ctx.actor._id, recipients: people.map((person) => person._id), entityType: "asset_incident", entityId: incident._id,
    eventType: `assets.incident_${action}`, title: action === "reported" ? "Asset incident reported" : "Asset incident updated", message: `${incident.reference}: ${incident.assetSnapshot.tag} - ${incident.status.replace(/_/g, " ")}.`,
    category: "system", priority: incident.active ? "high" : "medium", actionUrl: `/dashboard/assets?incidentId=${incident._id}`, dedupeEventKey: `asset-incident:${action}:${incident.revision}` }, session);
}

type Action = "reported" | "review" | "resolve" | "dismiss";
/** A case changes an issue hold, not physical custody; all derived onboarding effects share its transaction. */
export const mutateAssetIncident = (action: Action) => async (req: any, res: any, next: any) => {
  try {
    const body = req.body || {}, ctx = assetContext(req, action === "reported" && body.assignmentId ? "self" : "manage");
    await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: idString(ctx.company), actionLabel: "update asset incidents" });
    for (const model of [Asset, Assignment, Audit, Incident, Event, EmployeeControl]) await model.init();
    await initializeOnboardingAssets();
    const requestId = text(body.requestId, "Request id", 8, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 422);
    const version = revision(body.revision), input: any = { action, revision: version };
    if (action === "reported") {
      if (Boolean(body.assignmentId) === Boolean(body.assetId)) throw generateError("Select exactly one employee handover or inventory unit", 422);
      input.targetKind = body.assignmentId ? "assignment" : "asset"; input.target = idString(objectId(body.assignmentId || body.assetId, "incident target"));
      if (!INCIDENT_KINDS.includes(body.kind)) throw generateError("Choose loss, theft, damage or malfunction", 422);
      input.kind = body.kind; input.occurredAt = incidentOccurredAt(body.occurredAt).toISOString(); input.reason = text(body.description, "Incident description", 10, 2000);
    } else {
      input.target = idString(objectId(req.params.incidentId, "incident id")); input.assetRevision = revision(body.assetRevision); input.reason = text(body.reason, "Review / resolution reason", 3, 1000);
      if (action === "resolve") {
        if (body.confirmLocatedAndInspected !== true || !["new", "good", "fair"].includes(body.condition)) throw generateError("Locate and inspect the unit, confirm it is usable, and choose its condition before resolving", 422);
        input.confirmLocatedAndInspected = true; input.condition = body.condition;
      }
      if (action === "dismiss") {
        if (body.confirmReportInvalid !== true) throw generateError("Confirm this report is invalid before dismissing its hold", 422);
        input.confirmReportInvalid = true;
      }
    }
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    let resultId = "", replayed = false;
    const replay = async (session?: mongoose.ClientSession) => {
      const prior: any = await Event.findOne({ company: ctx.company, actor: ctx.actor._id, requestId }).select("+requestHash").session(session || null).lean();
      if (!prior) return false;
      if (prior.requestHash !== requestHash) throw generateError("Request id already used for another incident change", 409);
      await findIncident(ctx, idString(prior.incident), session); resultId = idString(prior.incident); replayed = true; return true;
    };
    try { await mongoose.connection.transaction(async (session) => {
      if (await replay(session)) return;
      let asset: any, assignment: any = null, incident: any, before: any = null;
      if (action === "reported") {
        if (input.targetKind === "assignment") {
          assignment = await Assignment.findOne({ _id: input.target, company: ctx.company }).session(session).lean();
          if (!assignment || !canManageAssets(ctx) && idString(assignment.employee) !== idString(ctx.actor)) throw generateError("Asset handover not found", 404);
          if (assignment.revision !== version || !assignment.active) throw generateError("Handover changed or closed. Reload before reporting.", 409);
          asset = await Asset.findOne({ _id: assignment.asset, company: ctx.company, currentAssignment: assignment._id, status: "issued" }).session(session).lean();
        } else {
          asset = await Asset.findOne({ _id: input.target, company: ctx.company }).session(session).lean();
          if (asset && asset.revision !== version) throw generateError("Inventory changed. Reload before reporting.", 409);
          if (asset?.currentAssignment) assignment = await Assignment.findOne({ _id: asset.currentAssignment, company: ctx.company, asset: asset._id, active: true }).session(session).lean();
          if (asset?.currentAssignment && !assignment) throw generateError("Inventory custody is inconsistent. Review the handover first.", 409);
        }
        if (!asset) throw generateError("Current asset not found", 404);
        if (asset.openIncident || asset.openWriteOff || asset.writtenOffRecord || asset.openDisposal || asset.disposedRecord || ["retired", "written_off", "disposed"].includes(asset.status)) throw generateError("This unit has an incident/loss/disposal hold, or is retired, written off or disposed", 409);
        if (assignment && Math.floor(Date.parse(input.occurredAt) / 60000) < Math.floor(new Date(assignment.issuedAt).getTime() / 60000)) throw generateError("The incident time cannot precede this handover's minute", 422);
        if (assignment) {
          await fenceAssetEmployee(ctx.company, assignment.employee, session);
          const fenced = await Assignment.updateOne({ _id: assignment._id, company: ctx.company, revision: assignment.revision, active: true }, { $inc: { incidentFence: 1 } }, { session, timestamps: false });
          if (!fenced.matchedCount) throw generateError("Handover changed. Reload before reporting.", 409);
        }
        incident = (await Incident.create([{ company: ctx.company, asset: asset._id, assignment: assignment?._id || null, reference: `ASI-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
          assetSnapshot: { name: asset.name, tag: asset.tag, category: asset.category, categoryName: assetDto(ctx, asset).categoryName, serialNumber: asset.serialNumber }, employee: assignment?.employee || null, employeeName: assignment?.employeeName || "", employeeCode: assignment?.employeeCode || "",
          reportedBy: ctx.actor._id, reporterName: ctx.actor.name || "Employee", kind: input.kind, occurredAt: input.occurredAt, description: input.reason }], { session }))[0].toObject();
      } else {
        incident = await findIncident(ctx, input.target, session); before = { status: incident.status, revision: incident.revision, active: incident.active };
        if (incident.employee) await fenceAssetEmployee(ctx.company, incident.employee, session);
        asset = await Asset.findOne({ _id: incident.asset, company: ctx.company }).session(session).lean();
        const capabilities = incidentDto(ctx, incident, asset);
        if (idString(incident.employee) === idString(ctx.actor)) throw generateError("Another asset manager must review incidents involving your custody", 403);
        const allowed = action === "review" ? capabilities.canReview : action === "resolve" ? capabilities.canResolve : capabilities.canDismiss;
        if (!incident.active || !allowed) throw generateError("Incident is closed or an active service order must be completed before inspection resolution", 409);
        if (incident.revision !== version || asset.revision !== input.assetRevision) throw generateError("Incident or inventory changed. Reload before reviewing.", 409);
        const changes = action === "review" ? { status: "under_review", reviewedBy: ctx.actor._id, reviewerName: ctx.actor.name || "Asset manager", reviewedAt: new Date() }
          : { status: action === "resolve" ? "resolved" : "dismissed", active: false, closedBy: ctx.actor._id, closerName: ctx.actor.name || "Asset manager", closedAt: new Date(), resolutionReason: input.reason, ...(action === "resolve" ? { conditionAfter: input.condition } : {}) };
        incident = await Incident.findOneAndUpdate({ _id: incident._id, company: ctx.company, revision: version, active: true }, { $set: changes, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
        if (!incident) throw generateError("Incident changed. Reload before reviewing.", 409);
        if (incident.assignment) assignment = await Assignment.findOne({ _id: incident.assignment, company: ctx.company }).session(session).lean();
      }
      const held = action === "reported" || action === "review";
      const updated: any = await Asset.findOneAndUpdate({ _id: asset._id, company: ctx.company, revision: asset.revision, openIncident: action === "reported" ? null : incident._id },
        { $set: { openIncident: held ? incident._id : null, updatedBy: ctx.actor._id, ...(action === "resolve" ? { condition: input.condition } : {}) }, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
      if (!updated) throw generateError("Inventory changed. Reload before updating incident hold.", 409);
      const after = { status: incident.status, revision: incident.revision, active: incident.active, ...(action === "resolve" ? { conditionAfter: input.condition } : {}) };
      const recorded = (await Event.create([{ company: ctx.company, incident: incident._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Employee", action, reason: input.reason, requestId, requestHash, before, after }], { session }))[0];
      const [audit] = await Audit.create([{ company: ctx.company, asset: asset._id, assignment: assignment?._id || null, actor: ctx.actor._id, actorName: ctx.actor.name || "Employee", action: `incident_${action}`, reason: input.reason,
        requestId: `incident-event-${recorded._id}`, requestHash, before: { openIncident: asset.openIncident || null, revision: asset.revision, condition: asset.condition }, after: { incident: incident._id, ...after, openIncident: updated.openIncident, assetRevision: updated.revision, condition: updated.condition } }], { session });
      if (assignment && action !== "review") await syncOnboardingAssetCustody(ctx, assignment, `incident_${action}`, audit._id, session);
      await notify(ctx, incident, action, session); resultId = idString(incident);
      if (incident.employee) await notifyClearanceChange(ctx, incident.employee, `incident_${action}`, String(recorded._id), session);
    }); } catch (error: any) {
      if (error.code !== 11000) throw error;
      if (!await replay()) throw generateError("An incident is already open for this unit or its state changed. Reload first.", 409);
    }
    res.status(action === "reported" && !replayed ? 201 : 200).json({ success: true, data: await currentDto(ctx, resultId), replayed });
  } catch (error) { next(error); }
};
