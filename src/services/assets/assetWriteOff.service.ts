import { createHash, randomUUID } from "crypto";
import mongoose from "mongoose";
import { Asset, AssetAssignment as Assignment, AssetAudit as Audit, ASSET_CONDITIONS } from "../../schemas/Assets/Asset.schema";
import { AssetWriteOff as Record, AssetWriteOffEvent as Event, AssetLossLedger as Ledger, WRITE_OFF_STATES } from "../../schemas/Assets/AssetWriteOff.schema";
import { AssetIncident as Incident, AssetIncidentEvent as IncidentEvent } from "../../schemas/Assets/AssetIncident.schema";
import { AssetServiceOrder as Service, AssetServiceEvent as ServiceEvent } from "../../schemas/Assets/AssetServiceOrder.schema";
import Location from "../../schemas/OfficeLocation/OfficeLocation.schema";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { attachEffectivePermissions, ensurePermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { upsertRequestNotifications } from "../notification/notification.service";
import { initializeOnboardingAssets, syncOnboardingAssetCustody } from "../onboarding/onboardingAsset.service";
import { assetContext, AssetContext, idString, objectId, pagination, revision, searchRegex, text } from "./asset.utils";
import { canApproveAssetLoss, lossAmount, writeOffDto } from "./assetWriteOff.utils";
import { AssetEmployeeControl as EmployeeControl } from "../../schemas/Assets/AssetClearance.schema";
import { fenceAssetEmployee, notifyClearanceChange } from "./assetClearance.guard";

const closureText = "Confirmed unrecovered loss approved. Any active employee custody was closed administratively, not physically returned. No salary deduction was created.";
async function findRecord(ctx: AssetContext, id: string, session?: mongoose.ClientSession) {
  const record: any = await Record.findOne({ _id: objectId(id, "write-off id"), company: ctx.company }).session(session || null).lean();
  if (!record) throw generateError("Asset write-off not found", 404);
  return record;
}
async function currentDto(ctx: AssetContext, id: string) {
  const record = await findRecord(ctx, id), asset = await Asset.findOne({ _id: record.asset, company: ctx.company }).select("openWriteOff writtenOffRecord currentAssignment openService openIncident revision status").lean();
  return writeOffDto(ctx, record, asset);
}
export const listAssetWriteOffs = async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "view"), { page, limit, skip } = pagination(req.query), status = req.query.status || "pending", search = searchRegex(req.query.search);
    if (status !== "all" && !WRITE_OFF_STATES.includes(status)) throw generateError("Invalid write-off status", 400);
    const match = { company: ctx.company, ...(status === "all" ? {} : { status }), ...(req.query.assetId ? { asset: objectId(req.query.assetId, "asset id") } : {}),
      ...(search ? { $or: [{ reference: search }, { incidentReference: search }, { "assetSnapshot.name": search }, { "assetSnapshot.tag": search }, { employeeName: search }, { employeeCode: search }] } : {}) };
    const data = await Record.find(match).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Record.countDocuments(match);
    res.json({ success: true, data: data.map((row) => writeOffDto(ctx, row)), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
export const getAssetWriteOff = async (req: any, res: any, next: any) => { try { const ctx = assetContext(req, "view"); res.json({ success: true, data: await currentDto(ctx, req.params.writeOffId) }); } catch (error) { next(error); } };
export const writeOffHistory = (kind: "events" | "ledger") => async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "view"), record = await findRecord(ctx, req.params.writeOffId), { page, limit, skip } = pagination(req.query), match = { company: ctx.company, writeOff: record._id }, model = kind === "events" ? Event : Ledger;
    const rows: any[] = await model.find(match).select(kind === "events" ? "actorName action reason before after createdAt" : "kind amountMinor currency source receiptReference reverses actorName reason createdAt").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await model.countDocuments(match);
    const reversals: any[] = kind === "ledger" ? await Ledger.find({ ...match, reverses: { $in: rows.map((row) => row._id) } }).select("reverses").lean() : [];
    const reversed = new Set(reversals.map((row) => idString(row.reverses))), canReverse = writeOffDto(ctx, record).canRecordReceipt;
    const data = rows.map((row) => kind === "events" ? row : { ...row, reversed: reversed.has(idString(row)), canReverse: canReverse && row.kind === "recovery_receipt" && !reversed.has(idString(row)) });
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
async function notify(ctx: AssetContext, record: any, action: string, session: mongoose.ClientSession) {
  const company: any = await Company.findById(ctx.company).select("rolePermissions").session(session).lean();
  const roles = ["admin", "hradmin", ...Object.entries(company?.rolePermissions || {}).filter(([, value]: any) => value?.approve_asset_write_offs === true).map(([key]) => key)];
  const match = action === "created" ? { $or: [{ _id: record.requestedBy }, { role: { $in: roles } }, { accessRole: { $in: roles } }, { "permissions.approve_asset_write_offs": true }] } : { _id: record.requestedBy };
  const people = await User.find({ company: ctx.company, deletedAt: null, is_enabled: { $ne: false }, ...match }).select("_id role company permissions accessRole").sort({ _id: 1 }).limit(50).session(session).lean();
  const recipients = people.filter((person) => {
    const actor = attachEffectivePermissions({ user: person, company });
    if (idString(person) === idString(record.employee)) return false;
    return action === "created" && idString(person) !== idString(record.requestedBy) ? canApproveAssetLoss({ actor, company: ctx.company }) : actor.effectivePermissions?.view_assets === true;
  }).map((person) => person._id);
  await upsertRequestNotifications({ company: ctx.company, actor: ctx.actor._id, recipients, entityType: "asset_write_off", entityId: record._id, eventType: `assets.write_off_${action}`, title: action === "created" ? "Asset loss write-off needs independent approval" : "Asset write-off register updated", message: `${record.reference}: ${record.assetSnapshot.tag} - ${record.status.replace(/_/g, " ")}.`, category: "system", priority: action === "created" ? "high" : "medium", actionUrl: `/dashboard/assets?writeOffId=${record._id}`, dedupeEventKey: `asset-writeoff:${action}:${record.revision}` }, session);
}
const snapshot = (record: any) => ({ status: record.status, revision: record.revision, amountMinor: record.amountMinor, currency: record.currency, recoveredAmountMinor: record.recoveredAmountMinor, recoveredAt: record.recoveredAt || null });
type Action = "created" | "approve" | "reject" | "withdraw" | "recover" | "receipt" | "reverse";
/** Closing a loss is deliberately separate from physical return, payroll, vendor receipt and general-ledger posting. */
export const mutateAssetWriteOff = (action: Action) => async (req: any, res: any, next: any) => {
  try {
    const ctx = assetContext(req, "manage"), body = req.body || {}, moneyAction = ["receipt", "reverse"].includes(action);
    if (["approve", "reject", "receipt", "reverse"].includes(action)) ensurePermission(ctx.actor, PERMISSION_KEYS.APPROVE_ASSET_WRITE_OFFS);
    await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: idString(ctx.company), actionLabel: "update confirmed asset losses" });
    for (const model of [Asset, Assignment, Audit, Incident, IncidentEvent, Service, ServiceEvent, Record, Event, Ledger, EmployeeControl]) await model.init();
    await initializeOnboardingAssets();
    const requestId = text(body.requestId, "Request id", 8, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 422);
    const input: any = { action, revision: revision(body.revision), target: idString(objectId(action === "created" ? body.incidentId : req.params.writeOffId, action === "created" ? "incident id" : "write-off id")), reason: text(body.reason, "Write-off / recovery reason", action === "created" ? 10 : 3, action === "created" ? 2000 : 1000) };
    if (!moneyAction) input.assetRevision = revision(body.assetRevision);
    if (action === "created") {
      if (body.confirmUnrecovered !== true || !["loss", "theft"].includes(body.lossKind)) throw generateError("Confirm the unit is unrecovered and select loss or theft", 422);
      Object.assign(input, { lossKind: body.lossKind, amountMinor: lossAmount(body.amountMinor ?? null, body.currency), currency: body.currency, evidenceReference: text(body.evidenceReference ?? "", "Supporting reference", 0, 200), confirmUnrecovered: true });
    }
    if (action === "approve") {
      if (body.confirmUnrecovered !== true || body.confirmWriteOff !== true) throw generateError("Independently confirm unrecovered loss and administrative write-off, not a physical return", 422);
      input.confirmUnrecovered = true; input.confirmWriteOff = true;
    }
    if (action === "recover") {
      if (body.confirmPhysicalRecovery !== true || !ASSET_CONDITIONS.includes(body.condition)) throw generateError("Confirm actual physical recovery into company custody and record its condition", 422);
      input.confirmPhysicalRecovery = true; input.condition = body.condition; input.officeLocation = body.officeLocation ? idString(objectId(body.officeLocation, "recovery location")) : null;
    }
    if (action === "receipt") {
      if (body.confirmReceived !== true || !["insurance", "supplier", "other"].includes(body.source)) throw generateError("Confirm an actual recovery receipt and choose its source", 422);
      Object.assign(input, { amountMinor: lossAmount(body.amountMinor, body.currency, true), currency: body.currency, source: body.source, receiptReference: text(body.receiptReference, "Receipt reference", 3, 150), confirmReceived: true });
    }
    if (action === "reverse") {
      if (body.confirmCorrection !== true) throw generateError("Confirm the correction; the original receipt will remain in history", 422);
      input.receiptId = idString(objectId(req.params.receiptId, "recovery receipt id")); input.confirmCorrection = true;
    }
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    let resultId = "", replayed = false;
    const replay = async (session?: mongoose.ClientSession) => {
      const prior: any = await Event.findOne({ company: ctx.company, actor: ctx.actor._id, requestId }).select("+requestHash").session(session || null).lean();
      if (!prior) return false;
      if (prior.requestHash !== requestHash) throw generateError("Request id already used for another asset-loss action", 409);
      resultId = idString(prior.writeOff); await findRecord(ctx, resultId, session); replayed = true; return true;
    };
    try { await mongoose.connection.transaction(async (session) => {
      if (await replay(session)) return;
      const now = new Date(), eventId = new mongoose.Types.ObjectId();
      let record: any, asset: any, incident: any, assignment: any = null, service: any = null, before: any = null, assetChanges: any = {}, ledgerEntry: any = null;
      if (action === "created") {
        incident = await Incident.findOne({ _id: input.target, company: ctx.company }).session(session).lean();
        if (!incident) throw generateError("Asset incident not found", 404);
        if (incident.employee) await fenceAssetEmployee(ctx.company, incident.employee, session);
        asset = await Asset.findOne({ _id: incident.asset, company: ctx.company }).session(session).lean();
        if (idString(incident.employee) === idString(ctx.actor)) throw generateError("Another asset manager must request write-off for a case involving your custody", 403);
        if (!incident.active || incident.status !== "under_review" || incident.revision !== input.revision || !asset || asset.revision !== input.assetRevision || idString(asset.openIncident) !== idString(incident) || asset.openWriteOff || asset.writtenOffRecord || asset.openDisposal || asset.disposedRecord || ["retired", "written_off", "disposed"].includes(asset.status)) throw generateError("Use a current investigated incident without another write-off/disposal hold; reload incident and inventory revisions", 409);
        if ((asset.status === "issued") !== Boolean(asset.currentAssignment)) throw generateError("Inventory state and employee custody are inconsistent; investigate before loss closure", 409);
        if (asset.currentAssignment) assignment = await Assignment.findOne({ _id: asset.currentAssignment, company: ctx.company, asset: asset._id, active: true }).session(session).lean();
        if (asset.currentAssignment && (!assignment || idString(incident.assignment) !== idString(assignment))) throw generateError("Current employee custody does not match this incident", 409);
        if (!asset.currentAssignment && await Assignment.exists({ company: ctx.company, asset: asset._id, active: true }).session(session)) throw generateError("Unexpected active employee custody must be reconciled first", 409);
        if (asset.openService) service = await Service.findOne({ _id: asset.openService, company: ctx.company, asset: asset._id, active: true }).session(session).lean();
        if (asset.openService && !service) throw generateError("Review the inconsistent service hold before requesting loss closure", 409);
        if (!asset.openService && await Service.exists({ company: ctx.company, asset: asset._id, active: true }).session(session)) throw generateError("Unexpected active service custody must be reconciled first", 409);
        if (assignment && service) throw generateError("Employee and service-provider custody cannot both be active", 409);
        record = (await Record.create([{ company: ctx.company, asset: asset._id, incident: incident._id, assignment: assignment?._id || null, serviceOrder: service?._id || null, reference: `WO-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`, incidentReference: incident.reference, assetSnapshot: incident.assetSnapshot,
          employee: incident.employee || null, employeeName: incident.employeeName || "", employeeCode: incident.employeeCode || "", lastKnownCustody: assignment ? "employee" : service?.externalDispatched ? "service_provider" : "company", providerName: service?.providerName || "",
          kind: input.lossKind, reason: input.reason, evidenceReference: input.evidenceReference, amountMinor: input.amountMinor, currency: input.currency, requestedBy: ctx.actor._id, requesterName: ctx.actor.name || "Asset manager" }], { session }))[0].toObject();
        assetChanges = { openWriteOff: record._id };
      } else {
        record = await findRecord(ctx, input.target, session); asset = await Asset.findOne({ _id: record.asset, company: ctx.company }).session(session).lean();
        if (!moneyAction && record.employee) await fenceAssetEmployee(ctx.company, record.employee, session);
        if (idString(record.employee) === idString(ctx.actor)) throw generateError("Another authorised operator must handle losses associated with your custody", 403);
        if (record.revision !== input.revision) throw generateError("Write-off changed. Reload before continuing.", 409);
        if (!moneyAction && (!asset || asset.revision !== input.assetRevision)) throw generateError("Inventory changed. Reload before continuing.", 409);
        before = snapshot(record); const capabilities = writeOffDto(ctx, record, asset); let changes: any;
        if (["approve", "reject", "withdraw"].includes(action)) {
          if (record.status !== "pending" || idString(asset.openWriteOff) !== idString(record)) throw generateError("This write-off request is no longer pending on the unit", 409);
          if (action === "approve" && capabilities.approvalBlockedReason) throw generateError(capabilities.approvalBlockedReason, 409);
          const allowed = action === "approve" ? capabilities.canApprove : action === "reject" ? capabilities.canReject : capabilities.canWithdraw;
          if (!allowed) throw generateError("An independent approver is required, or this request is no longer pending", 403);
          incident = await Incident.findOne({ _id: record.incident, company: ctx.company }).session(session).lean();
          if (action === "approve") {
            if (!incident?.active || incident.status !== "under_review" || idString(asset.openIncident) !== idString(incident) || idString(asset.currentAssignment) !== idString(record.assignment) || idString(asset.openService) !== idString(record.serviceOrder)) throw generateError("Custody, service or incident changed; withdraw this request and investigate again", 409);
            if (record.assignment) {
              assignment = await Assignment.findOneAndUpdate({ _id: record.assignment, company: ctx.company, asset: asset._id, active: true }, { $set: { active: false, status: "written_off", writeOffRecord: record._id, writtenOffAt: now, writtenOffByName: ctx.actor.name || "Approver", writtenOffReason: closureText }, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
              if (!assignment) throw generateError("Employee custody was already recovered or closed; withdraw and review", 409);
            } else if (await Assignment.exists({ company: ctx.company, asset: asset._id, active: true }).session(session)) throw generateError("Unexpected active employee custody. Investigate before approval.", 409);
            if (record.serviceOrder) {
              service = await Service.findOneAndUpdate({ _id: record.serviceOrder, company: ctx.company, asset: asset._id, active: true }, { $set: { active: false, status: "written_off", writeOffRecord: record._id, closedAt: now, closedBy: ctx.actor._id, closerName: ctx.actor.name || "Approver", closeReason: "Unrecovered unit administratively written off; no provider receipt was recorded" }, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
              if (!service) throw generateError("Service custody changed. Withdraw and investigate again.", 409);
              await ServiceEvent.create([{ company: ctx.company, serviceOrder: service._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Approver", action: "written_off", reason: service.closeReason, requestId: `writeoff-${eventId}`, requestHash, after: { status: service.status, active: false, externalDispatched: service.externalDispatched, writeOffRecord: record._id } }], { session });
            } else if (await Service.exists({ company: ctx.company, asset: asset._id, active: true }).session(session)) throw generateError("Unexpected service custody blocks approval; withdraw and investigate", 409);
            incident = await Incident.findOneAndUpdate({ _id: incident._id, company: ctx.company, revision: incident.revision, active: true }, { $set: { active: false, status: "written_off", writeOffRecord: record._id, closedBy: ctx.actor._id, closerName: ctx.actor.name || "Approver", closedAt: now, resolutionReason: closureText }, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
            if (!incident) throw generateError("Incident changed during approval", 409);
            assetChanges = { status: "written_off", currentAssignment: null, holder: null, openIncident: null, openService: null, openWriteOff: null, writtenOffRecord: record._id, lastWriteOff: record._id, maintenanceReleaseBlocked: true };
            ledgerEntry = { kind: "write_off", amountMinor: record.amountMinor };
          } else assetChanges = { openWriteOff: null };
          changes = { status: action === "approve" ? "approved" : action === "reject" ? "rejected" : "withdrawn", active: action === "approve", decidedBy: ctx.actor._id, deciderName: ctx.actor.name || "Asset manager", decidedAt: now, decisionReason: input.reason };
        } else if (action === "recover") {
          if (!capabilities.canRecoverUnit || asset.currentAssignment || asset.openService || asset.openIncident || asset.openWriteOff) throw generateError("Only the current unrecovered written-off unit can be physically recovered", 409);
          if (await Assignment.exists({ company: ctx.company, asset: asset._id, active: true }).session(session)) throw generateError("Unexpected active custody blocks recovery", 409);
          const location: any = input.officeLocation ? await Location.findOne({ _id: input.officeLocation, company: ctx.company, is_active: true, deletedAt: null }).select("name").session(session).lean() : null;
          if (input.officeLocation && !location) throw generateError("Choose an active company inventory location", 422);
          changes = { status: "recovered", active: false, recoveredAt: now, recoveredBy: ctx.actor._id, recovererName: ctx.actor.name || "Asset manager", recoveredCondition: input.condition, recoveryReason: input.reason };
          assetChanges = { status: "maintenance", condition: input.condition, writtenOffRecord: null, maintenanceReleaseBlocked: true, officeLocation: location?._id || null, locationName: location?.name || "" };
          ledgerEntry = { kind: "physical_recovery", amountMinor: null };
          if (record.assignment) await Assignment.updateOne({ _id: record.assignment, company: ctx.company, writeOffRecord: record._id, status: "written_off", active: false }, { $set: { writtenOffRecoveredAt: now }, $inc: { revision: 1 } }, { session });
          incident = await Incident.findOneAndUpdate({ _id: record.incident, company: ctx.company, writeOffRecord: record._id }, { $set: { recoveredAfterWriteOffAt: now }, $inc: { revision: 1 } }, { session, new: true }).lean();
          if (record.serviceOrder) {
            await Service.updateOne({ _id: record.serviceOrder, company: ctx.company, writeOffRecord: record._id }, { $set: { recoveredAfterWriteOffAt: now }, $inc: { revision: 1 } }, { session });
            await ServiceEvent.create([{ company: ctx.company, serviceOrder: record.serviceOrder, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", action: "recovered_after_write_off", reason: "Unit later recovered into company custody; original service closure and missing provider receipt retained", requestId: `writeoff-${eventId}`, requestHash, after: { recoveredAfterWriteOffAt: now, writeOffRecord: record._id } }], { session });
          }
        } else {
          if (!capabilities.canRecordReceipt) throw generateError("Approve Asset Write-offs is required to reconcile an approved loss", 403);
          let delta: number;
          if (action === "receipt") {
            if (input.currency !== record.currency) throw generateError("Record recovery in the write-off currency; no automatic currency conversion is performed", 422);
            const receiptRefKey = `${input.source}:${input.receiptReference.toLowerCase()}`;
            const priorReceipts = await Ledger.find({ company: ctx.company, writeOff: record._id, kind: "recovery_receipt", receiptRefKey }).select("_id").limit(101).session(session).lean();
            if (priorReceipts.length > 100) throw generateError("This reference has too many corrections; review the register before continuing", 409);
            if (priorReceipts.length && await Ledger.countDocuments({ company: ctx.company, writeOff: record._id, kind: "recovery_reversal", reverses: { $in: priorReceipts.map((row) => row._id) } }).session(session) < priorReceipts.length) throw generateError("This receipt reference already has an unreversed entry", 409);
            delta = input.amountMinor; ledgerEntry = { kind: "recovery_receipt", amountMinor: input.amountMinor, source: input.source, receiptReference: input.receiptReference, receiptRefKey };
          } else {
            const original: any = await Ledger.findOne({ _id: input.receiptId, company: ctx.company, writeOff: record._id, kind: "recovery_receipt" }).session(session).lean();
            if (!original) throw generateError("Recovery receipt not found", 404);
            if (await Ledger.exists({ company: ctx.company, writeOff: record._id, reverses: original._id }).session(session)) throw generateError("This receipt already has a correction reversal", 409);
            delta = -original.amountMinor; ledgerEntry = { kind: "recovery_reversal", amountMinor: original.amountMinor, reverses: original._id };
          }
          const total = record.recoveredAmountMinor + delta;
          if (!Number.isSafeInteger(total) || total < 0 || total > 1000000000000) throw generateError("Recovery total is outside supported bounds; review ledger evidence", 422);
          changes = { recoveredAmountMinor: total };
        }
        record = await Record.findOneAndUpdate({ _id: record._id, company: ctx.company, revision: input.revision }, { $set: changes, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
        if (!record) throw generateError("Write-off changed. Reload before continuing.", 409);
      }
      if (!moneyAction) {
        const updated = await Asset.findOneAndUpdate({ _id: asset._id, company: ctx.company, revision: asset.revision, ...(action === "created" ? { openWriteOff: null, writtenOffRecord: null } : action === "recover" ? { writtenOffRecord: record._id } : { openWriteOff: record._id }) }, { $set: { ...assetChanges, updatedBy: ctx.actor._id }, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
        if (!updated) throw generateError("Inventory changed during loss processing", 409);
      }
      await Event.create([{ _id: eventId, company: ctx.company, writeOff: record._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", action, reason: input.reason, requestId, requestHash, before, after: snapshot(record) }], { session });
      if (ledgerEntry) await Ledger.create([{ company: ctx.company, writeOff: record._id, event: eventId, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", reason: input.reason, currency: record.currency, ...ledgerEntry }], { session });
      const [audit] = await Audit.create([{ company: ctx.company, asset: record.asset, assignment: record.assignment, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", action: `write_off_${action}`, reason: input.reason, requestId: `writeoff-${eventId}`, requestHash, before, after: { writeOff: record._id, ...snapshot(record) } }], { session });
      if (assignment && action === "approve") await syncOnboardingAssetCustody(ctx, assignment, "written_off", audit._id, session);
      if (["approve", "recover"].includes(action) && incident) {
        const sharedReason = action === "approve" ? closureText : "Written-off unit later physically recovered into company custody for inspection; original closure retained";
        await IncidentEvent.create([{ company: ctx.company, incident: incident._id, actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", action: action === "approve" ? "written_off" : "recovered_after_write_off", reason: sharedReason, requestId: `writeoff-${eventId}`, requestHash, after: { status: incident.status, recoveredAfterWriteOffAt: incident.recoveredAfterWriteOffAt || null } }], { session });
        const recipients = await User.find({ company: ctx.company, _id: incident.employee, deletedAt: null, is_enabled: { $ne: false } }).select("_id").session(session).lean();
        await upsertRequestNotifications({ company: ctx.company, actor: ctx.actor._id, recipients: recipients.map((person) => person._id), entityType: "asset_incident", entityId: incident._id, eventType: `assets.loss_${action}`, title: action === "approve" ? "Asset loss closure recorded" : "Asset later recovered", message: sharedReason, category: "system", priority: "medium", actionUrl: `/dashboard/assets?incidentId=${incident._id}`, dedupeEventKey: `asset-loss-public:${eventId}` }, session);
      }
      await notify(ctx, record, action, session); resultId = idString(record);
      if (!moneyAction && record.employee) await notifyClearanceChange(ctx, record.employee, `write_off_${action}`, String(eventId), session);
    }); } catch (error: any) {
      if (error.code !== 11000) throw error;
      if (!await replay()) throw generateError("Another write-off, receipt reversal or inventory change already exists; reload first", 409);
    }
    res.status(action === "created" && !replayed ? 201 : 200).json({ success: true, data: await currentDto(ctx, resultId), replayed });
  } catch (error) { next(error); }
};
