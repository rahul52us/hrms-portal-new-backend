import { createHash, randomUUID } from "crypto";
import mongoose from "mongoose";
import { Asset, AssetAssignment as Assignment, AssetAudit as Audit } from "../../schemas/Assets/Asset.schema";
import { AssetIncident as Incident } from "../../schemas/Assets/AssetIncident.schema";
import { AssetServiceOrder as Order, AssetServiceEvent as Event, SERVICE_KINDS, SERVICE_STATES } from "../../schemas/Assets/AssetServiceOrder.schema";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { attachEffectivePermissions, hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { upsertRequestNotifications } from "../notification/notification.service";
import { assetContext, AssetContext, assetDto, expectedReturnDate, idString, objectId, pagination, revision, searchRegex, text } from "./asset.utils";
import { serviceCost, serviceDto } from "./assetService.utils";

async function findOrder(ctx: AssetContext, id: string, session?: mongoose.ClientSession) {
  const order: any = await Order.findOne({ _id: objectId(id, "service order id"), company: ctx.company }).session(session || null).lean();
  if (!order) throw generateError("Asset service order not found", 404);
  return order;
}
async function currentDto(ctx: AssetContext, id: string) {
  const order = await findOrder(ctx, id), asset = await Asset.findOne({ _id: order.asset, company: ctx.company }).select("openService currentAssignment status revision openIncident openWriteOff writtenOffRecord").lean();
  return serviceDto(ctx, order, asset);
}
export const listAssetServiceOrders = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "view"), { page, limit, skip } = pagination(req.query), status = req.query.status || "active", search = searchRegex(req.query.search);
    if (!["all", "active", ...SERVICE_STATES].includes(status)) throw generateError("Invalid service order status", 400);
    const match = { company: ctx.company, ...(status === "all" ? {} : status === "active" ? { active: true } : { status }), ...(req.query.assetId ? { asset: objectId(req.query.assetId, "asset id") } : {}),
      ...(search ? { $or: [{ reference: search }, { "assetSnapshot.name": search }, { "assetSnapshot.tag": search }, { providerName: search }, { providerReference: search }] } : {}) };
    const data = await Order.find(match).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Order.countDocuments(match);
    res.json({ success: true, data: data.map((row) => serviceDto(ctx, row)), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const getAssetServiceOrder = async (req: any, res: any, next: any) => { try { const ctx = assetContext(req, "view"); res.json({ success: true, data: await currentDto(ctx, req.params.serviceOrderId) }); } catch (error) { next(error); } };
export const assetServiceHistory = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "view"), order = await findOrder(ctx, req.params.serviceOrderId), { page, limit, skip } = pagination(req.query), match = { company: ctx.company, serviceOrder: order._id };
    const data = await Event.find(match).select("actorName action reason createdAt before after").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Event.countDocuments(match);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
async function notify(ctx: AssetContext, order: any, action: string, session: mongoose.ClientSession) {
  const ids = [order.createdBy, order.startedBy, order.workCompletedBy].filter(Boolean);
  const company = await Company.findById(ctx.company).select("rolePermissions").session(session).lean();
  const people = await User.find({ company: ctx.company, _id: { $in: ids }, deletedAt: null, is_enabled: { $ne: false } }).select("_id role company permissions accessRole").session(session).lean();
  const recipients = people.filter((person) => hasPermission(attachEffectivePermissions({ user: person, company }), PERMISSION_KEYS.VIEW_ASSETS)).map((person) => person._id);
  await upsertRequestNotifications({ company: ctx.company, actor: ctx.actor._id, recipients, entityType: "asset_service_order", entityId: order._id, eventType: `assets.service_${action}`,
    title: order.status === "awaiting_inspection" ? "Equipment ready for service inspection" : "Asset service order updated", message: `${order.reference}: ${order.assetSnapshot.tag} - ${order.status.replace(/_/g, " ")}.`, category: "system", priority: order.status === "awaiting_inspection" ? "high" : "medium",
    actionUrl: `/dashboard/assets?serviceOrderId=${order._id}`, dedupeEventKey: `asset-service:${action}:${order.revision}` }, session);
}
type Action = "created" | "start" | "work_complete" | "receive_unrepaired" | "inspection" | "cancel" | "note";
const snapshot = (order: any) => ({ status: order.status, revision: order.revision, cycle: order.cycle, active: order.active, externalDispatched: order.externalDispatched, workPerformed: order.workPerformed, actualCostMinor: order.actualCostMinor, currency: order.currency, inspectionResult: order.inspectionResult, inspectionCondition: order.inspectionCondition });
/** Inventory CAS, physical-provider attestations, work evidence and release inspection commit together. */
export const mutateAssetServiceOrder = (action: Action) => async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "manage"), body = req.body || {};
    await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: idString(ctx.company), actionLabel: "update asset servicing" });
    for (const model of [Asset, Assignment, Audit, Incident, Order, Event]) await model.init();
    const requestId = text(body.requestId, "Request id", 8, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 422);
    const input: any = { action, revision: revision(body.revision), target: idString(objectId(action === "created" ? body.assetId : req.params.serviceOrderId, action === "created" ? "asset id" : "service order id")) };
    if (action === "created") {
      if (body.confirmCompanyCustody !== true) throw generateError("Confirm the unit is physically in company custody before opening service", 422);
      if (!SERVICE_KINDS.includes(body.kind) || !["internal", "external"].includes(body.providerType)) throw generateError("Choose a service kind and internal or external provider", 422);
      Object.assign(input, { kind: body.kind, providerType: body.providerType, providerName: text(body.providerName ?? "", "Provider name", body.providerType === "external" ? 2 : 0, 150), providerReference: text(body.providerReference ?? "", "Provider reference", 0, 100), expectedCompletionDate: expectedReturnDate(body.expectedCompletionDate), reason: text(body.issueDescription, "Issue / service description", 10, 2000), confirmCompanyCustody: true });
    } else {
      input.assetRevision = revision(body.assetRevision); input.reason = text(body.reason, "Service action reason", 3, 1000);
      if (action === "start") input.confirmDispatch = body.confirmDispatch === true;
      if (action === "work_complete") Object.assign(input, { workPerformed: text(body.workPerformed, "Work performed", 10, 2000), ...serviceCost(body.actualCostMinor ?? null, body.currency || "INR"), confirmReceivedFromProvider: body.confirmReceivedFromProvider === true });
      if (action === "receive_unrepaired" && body.confirmReceivedFromProvider !== true) throw generateError("Confirm the unit was physically received back from the provider", 422);
      if (action === "receive_unrepaired") input.confirmReceivedFromProvider = true;
      if (action === "cancel" && body.confirmCompanyCustody !== true) throw generateError("Confirm the company still has physical custody before cancelling service", 422);
      if (action === "cancel") input.confirmCompanyCustody = true;
      if (action === "inspection") {
        if (body.confirmInspection !== true || !["passed", "rework", "unrepairable"].includes(body.result)) throw generateError("Record and explicitly confirm a physical inspection result", 422);
        if (body.result === "passed" ? !["new", "good", "fair"].includes(body.condition) : body.condition !== "damaged") throw generateError("Use a usable condition for a passed inspection, or damaged for failed/unrepairable equipment", 422);
        Object.assign(input, { result: body.result, condition: body.condition, confirmInspection: true });
      }
    }
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    let resultId = "", replayed = false;
    const replay = async (session?: mongoose.ClientSession) => {
      const prior: any = await Event.findOne({ company: ctx.company, actor: ctx.actor._id, requestId }).select("+requestHash").session(session || null).lean();
      if (!prior) return false;
      if (prior.requestHash !== requestHash) throw generateError("Request id already used for another service action", 409);
      resultId = idString(prior.serviceOrder); await findOrder(ctx, resultId, session); replayed = true; return true;
    };
    try { await mongoose.connection.transaction(async (session) => {
      if (await replay(session)) return;
      let order: any, asset: any, before: any = null, changes: any = {}, assetChanges: any;
      const now = new Date(), actorFields = { updatedBy: ctx.actor._id };
      if (action === "created") {
        asset = await Asset.findOne({ _id: input.target, company: ctx.company }).session(session).lean();
        if (!asset) throw generateError("Asset not found", 404);
        if (asset.revision !== input.revision || asset.currentAssignment || asset.openService || asset.openWriteOff || asset.writtenOffRecord || !["available", "maintenance"].includes(asset.status)) throw generateError("Reload a returned/unissued unit without active service or write-off holds", 409);
        if (await Assignment.exists({ company: ctx.company, asset: asset._id, active: true }).session(session)) throw generateError("An employee still has active custody. Record actual physical return first.", 409);
        const incident: any = asset.openIncident ? await Incident.findOne({ _id: asset.openIncident, company: ctx.company, asset: asset._id, active: true }).select("reference").session(session).lean() : null;
        if (asset.openIncident && !incident) throw generateError("Review the inconsistent incident hold before opening service", 409);
        order = (await Order.create([{ company: ctx.company, asset: asset._id, reference: `SVC-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`, assetSnapshot: { name: asset.name, tag: asset.tag, category: asset.category, categoryName: assetDto(ctx, asset).categoryName, serialNumber: asset.serialNumber },
          incident: incident?._id || null, incidentReference: incident?.reference || "", kind: input.kind, issueDescription: input.reason, providerType: input.providerType, providerName: input.providerName, providerReference: input.providerReference, expectedCompletionDate: input.expectedCompletionDate,
          createdBy: ctx.actor._id, creatorName: ctx.actor.name || "Asset manager" }], { session }))[0].toObject();
        assetChanges = { ...actorFields, openService: order._id, status: "maintenance", maintenanceReleaseBlocked: true };
      } else {
        order = await findOrder(ctx, input.target, session);
        asset = await Asset.findOne({ _id: order.asset, company: ctx.company }).session(session).lean();
        const capabilities = serviceDto(ctx, order, asset);
        if (!capabilities.canAddNote || order.revision !== input.revision || asset.revision !== input.assetRevision) throw generateError("Service order or inventory changed, or this order is closed. Reload before continuing.", 409);
        before = snapshot(order); assetChanges = { ...actorFields };
        if (action === "start") {
          if (!capabilities.canStart) throw generateError("Only an open service order can be started", 409);
          if (order.providerType === "external" && !input.confirmDispatch) throw generateError("Confirm physical dispatch to the named provider", 422);
          changes = { status: "in_progress", startedAt: now, startedBy: ctx.actor._id, starterName: ctx.actor.name || "Asset manager", ...(order.providerType === "external" ? { externalDispatched: true, dispatchedAt: now, dispatchedBy: ctx.actor._id, dispatcherName: ctx.actor.name || "Asset manager" } : {}) };
        } else if (action === "work_complete") {
          if (!capabilities.canCompleteWork) throw generateError("Start service before recording completed work", 409);
          if (order.providerType === "external" && (!order.externalDispatched || !input.confirmReceivedFromProvider)) throw generateError("Confirm physical receipt back from the provider before recording completed work", 422);
          changes = { status: "awaiting_inspection", workPerformed: input.workPerformed, actualCostMinor: input.actualCostMinor, currency: input.currency, workCompletedAt: now, workCompletedBy: ctx.actor._id, workCompletedName: ctx.actor.name || "Asset manager", externalDispatched: false,
            ...(order.providerType === "external" ? { receivedAt: now, receivedBy: ctx.actor._id, receiverName: ctx.actor.name || "Asset manager" } : {}) };
        } else if (action === "receive_unrepaired") {
          if (!capabilities.canReceiveUnrepaired) throw generateError("Only a dispatched external-service unit can be received unrepaired", 409);
          changes = { status: "open", externalDispatched: false, receivedAt: now, receivedBy: ctx.actor._id, receiverName: ctx.actor.name || "Asset manager" };
        } else if (action === "inspection") {
          if (!capabilities.canInspect) throw generateError("Receive completed work before recording inspection", 409);
          const passed = input.result === "passed", terminal = input.result !== "rework";
          changes = { status: passed ? "completed" : terminal ? "unrepairable" : "open", active: !terminal, inspectedAt: now, inspectedBy: ctx.actor._id, inspectorName: ctx.actor.name || "Asset manager", inspectionResult: input.result, inspectionCondition: input.condition, inspectionReason: input.reason,
            ...(terminal ? { closedAt: now, closedBy: ctx.actor._id, closerName: ctx.actor.name || "Asset manager", closeReason: input.reason } : { cycle: (order.cycle || 1) + 1, workPerformed: "", actualCostMinor: null, workCompletedAt: null, workCompletedBy: null, workCompletedName: "" }) };
          assetChanges = { ...assetChanges, condition: input.condition, status: passed && !asset.openIncident ? "available" : "maintenance", maintenanceReleaseBlocked: !passed,
            lastInspection: { actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", inspectedAt: now, result: input.result, condition: input.condition, reason: input.reason, serviceOrder: order._id },
            ...(terminal ? { openService: null, lastService: order._id } : {}) };
        } else if (action === "cancel") {
          if (!capabilities.canCancel) throw generateError("Receive unrepaired external equipment back first; only an open, company-held order can be cancelled", 409);
          changes = { status: "cancelled", active: false, closedAt: now, closedBy: ctx.actor._id, closerName: ctx.actor.name || "Asset manager", closeReason: input.reason };
          assetChanges = { ...assetChanges, openService: null, lastService: order._id, status: "maintenance", maintenanceReleaseBlocked: true };
        }
        order = await Order.findOneAndUpdate({ _id: order._id, company: ctx.company, revision: input.revision, active: true }, { $set: changes, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
        if (!order) throw generateError("Service order changed. Reload before continuing.", 409);
      }
      const updated: any = await Asset.findOneAndUpdate({ _id: asset._id, company: ctx.company, revision: asset.revision, currentAssignment: null, openService: action === "created" ? null : order._id }, { $set: assetChanges, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
      if (!updated) throw generateError("Inventory changed. Reload before updating service.", 409);
      const after = snapshot(order);
      const recorded = (await Event.create([{ company: ctx.company, serviceOrder: order._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", action, reason: input.reason, requestId, requestHash, before, after }], { session }))[0];
      await Audit.create([{ company: ctx.company, asset: asset._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", action: `service_${action}`, reason: input.reason, requestId: `service-event-${recorded._id}`, requestHash,
        before: { openService: asset.openService || null, revision: asset.revision, status: asset.status, condition: asset.condition, maintenanceReleaseBlocked: asset.maintenanceReleaseBlocked || false },
        after: { serviceOrder: order._id, ...after, assetRevision: updated.revision, assetStatus: updated.status, condition: updated.condition, openService: updated.openService, maintenanceReleaseBlocked: updated.maintenanceReleaseBlocked } }], { session });
      if (action !== "note") await notify(ctx, order, action, session);
      resultId = idString(order);
    }); } catch (error: any) {
      if (error.code !== 11000) throw error;
      if (!await replay()) throw generateError("This unit already has an active service order or its state changed. Reload first.", 409);
    }
    res.status(action === "created" && !replayed ? 201 : 200).json({ success: true, data: await currentDto(ctx, resultId), replayed });
  } catch (error) { next(error); }
};
