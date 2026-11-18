import { createHash } from "crypto";
import mongoose from "mongoose";
import { Asset, AssetAssignment as Assignment, AssetAudit as Audit, ASSET_CATEGORIES, ASSET_CONDITIONS, ASSET_STATES } from "../../schemas/Assets/Asset.schema";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import Location from "../../schemas/OfficeLocation/OfficeLocation.schema";
import { generateError } from "../../config/Error/functions";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { attachEffectivePermissions, hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { upsertRequestNotifications } from "../notification/notification.service";
import { assetContext, AssetContext, assetDto, assignmentDto, canManageAssets, canViewAssets, expectedReturnDate, generatedTag, idString, inventoryMatch, normalizedAsset, objectId, pagination, revision, searchRegex, text } from "./asset.utils";
import { initializeOnboardingAssets, linkOnboardingAsset, parseOnboardingAssetReference, syncOnboardingAssetCustody } from "../onboarding/onboardingAsset.service";
import { AssetEmployeeControl as EmployeeControl } from "../../schemas/Assets/AssetClearance.schema";
import { canManageClearances, fenceAssetEmployee, notifyClearanceChange } from "./assetClearance.guard";
import { canExportAssets, canImportAssets } from "./assetTransfer.utils";
import { AssetCategory, BUILTIN_ASSET_CATEGORIES } from "../../schemas/Assets/AssetCategory.schema";
import { canManageAssetCategories, resolveAssetCategory } from "./assetCategory.utils";

const activeEmployee = { deletedAt: null, is_enabled: { $ne: false }, role: { $ne: "superadmin" } };
const pageResult = (data: any[], total: number, page: number, limit: number) => ({ data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
async function findAsset(ctx: AssetContext, id: any, session?: mongoose.ClientSession) {
  const asset: any = await Asset.findOne({ _id: objectId(id, "asset id"), company: ctx.company }).session(session || null).lean();
  if (!asset) throw generateError("Asset not found", 404);
  return asset;
}
async function findAssignment(ctx: AssetContext, id: any, session?: mongoose.ClientSession) {
  const record: any = await Assignment.findOne({ _id: objectId(id, "assignment id"), company: ctx.company }).session(session || null).lean();
  if (!record || !canViewAssets(ctx) && idString(record.employee) !== idString(ctx.actor)) throw generateError("Asset assignment not found", 404);
  return record;
}
async function location(ctx: AssetContext, id: any, session: mongoose.ClientSession, before?: any) {
  if (!id) return { officeLocation: null, locationName: "" };
  if (before && idString(before.officeLocation) === idString(id)) return { officeLocation: before.officeLocation, locationName: before.locationName || "" };
  const row: any = await Location.findOne({ _id: id, company: ctx.company, is_active: true, deletedAt: null }).select("name").session(session).lean();
  if (!row) throw generateError("Choose an active inventory location from this company", 422);
  return { officeLocation: row._id, locationName: row.name };
}
function read(access: "self" | "view" | "manage", fn: (req: any, ctx: AssetContext) => Promise<any>) {
  return async (req: any, res: any, next: any) => { try { res.json({ success: true, ...await fn(req, assetContext(req, access)) }); } catch (error) { next(error); } };
}
export const assetWorkspace = read("self", async (_req, ctx) => ({ data: { canViewInventory: canViewAssets(ctx), canManage: canManageAssets(ctx), canManageClearances: canManageClearances(ctx), canImport: canImportAssets(ctx), canExport: canExportAssets(ctx), canManageCategories: canManageAssetCategories(ctx), categories: ASSET_CATEGORIES, conditions: ASSET_CONDITIONS, states: ASSET_STATES } }));
export const assetLocations = read("view", async (req, ctx) => {
  const { page, limit, skip } = pagination(req.query), search = searchRegex(req.query.search);
  const match = { company: ctx.company, is_active: true, deletedAt: null, ...(search ? { $or: [{ name: search }, { code: search }] } : {}) };
  const data = await Location.find(match).select("_id name code").sort({ name: 1, _id: 1 }).skip(skip).limit(limit).lean(), total = await Location.countDocuments(match);
  return pageResult(data, total, page, limit);
});
export const assetEmployees = read("manage", async (req, ctx) => {
  const { page, limit, skip } = pagination(req.query), search = searchRegex(req.query.search);
  const match = { company: ctx.company, ...activeEmployee, _id: { $ne: ctx.actor._id }, ...(search ? { $or: [{ name: search }, { code: search }] } : {}) };
  const [result] = await User.aggregate([{ $match: match },
    { $lookup: { from: EmployeeControl.collection.name, localField: "_id", foreignField: "employee", pipeline: [{ $match: { company: ctx.company, issueBlocked: true } }, { $limit: 1 }, { $project: { _id: 1 } }], as: "clearanceHold" } },
    { $match: { "clearanceHold.0": { $exists: false } } },
    { $facet: { data: [{ $sort: { name: 1, _id: 1 } }, { $skip: skip }, { $limit: limit }, { $project: { _id: 1, name: 1, code: 1 } }], total: [{ $count: "value" }] } },
  ]);
  return pageResult(result?.data || [], result?.total[0]?.value || 0, page, limit);
});
export const listAssets = read("view", async (req, ctx) => {
  const { page, limit, skip } = pagination(req.query), match = inventoryMatch(ctx, req.query);
  const data = await Asset.find(match).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Asset.countDocuments(match);
  return pageResult(data.map((asset) => assetDto(ctx, asset)), total, page, limit);
});
export const getAsset = read("view", async (req, ctx) => ({ data: assetDto(ctx, await findAsset(ctx, req.params.assetId)) }));
export const listAssetAssignments = read("self", async (req, ctx) => {
  const { page, limit, skip } = pagination(req.query), scope = req.query.scope || "mine", state = req.query.state || "active", search = searchRegex(req.query.search);
  if (!["mine", "company"].includes(scope) || !["active", "returned", "voided", "written_off", "all", "return_requested"].includes(state)) throw generateError("Invalid assignment filter", 400);
  if (scope === "company" && !canViewAssets(ctx)) throw generateError("Company asset inventory permission is required", 403);
  const match = { company: ctx.company, ...(scope === "mine" ? { employee: ctx.actor._id } : {}), ...(state === "active" ? { active: true } : state === "all" ? {} : { status: state }),
    ...(search ? { $or: [{ "assetSnapshot.name": search }, { "assetSnapshot.tag": search }, { employeeName: search }, { employeeCode: search }] } : {}) };
  const data = await Assignment.find(match).sort({ issuedAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await Assignment.countDocuments(match);
  return pageResult(data.map((record) => assignmentDto(ctx, record)), total, page, limit);
});
export const getAssetAssignment = read("self", async (req, ctx) => {
  const record = await findAssignment(ctx, req.params.assignmentId), asset = await findAsset(ctx, idString(record.asset));
  return { data: assignmentDto(ctx, record, asset) };
});
export const assetHistory = (kind: "assignments" | "audit") => read("view", async (req, ctx) => {
  const asset = await findAsset(ctx, req.params.assetId), { page, limit, skip } = pagination(req.query), model = kind === "assignments" ? Assignment : Audit, match = { company: ctx.company, asset: asset._id };
  const data = await model.find(match).select(kind === "audit" ? "actorName action reason createdAt assignment before after" : "").sort(kind === "assignments" ? { issuedAt: -1, _id: -1 } : { createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), total = await model.countDocuments(match);
  return pageResult(kind === "audit" ? data : data.map((record) => assignmentDto(ctx, record, asset)), total, page, limit);
});

/** Notify only the holder and still-authorized issuer, never every employee in the company. */
async function notify(ctx: AssetContext, asset: any, assignment: any, action: string, session: mongoose.ClientSession) {
  const people: any[] = await User.find({ company: ctx.company, ...activeEmployee, _id: { $in: [assignment.employee, assignment.issuedBy] } }).select("_id role company permissions accessRole").session(session).lean();
  const company = await Company.findById(ctx.company).select("rolePermissions").session(session).lean();
  const recipients = people.filter((person) => idString(person) === idString(assignment.employee) || hasPermission(attachEffectivePermissions({ user: person, company }), PERMISSION_KEYS.VIEW_ASSETS)).map((person) => person._id);
  await upsertRequestNotifications({ company: ctx.company, actor: ctx.actor._id, recipients, entityType: "asset_assignment", entityId: assignment._id,
    eventType: `assets.${action}`, title: action === "issued" ? "Asset handed over" : action === "request_return" ? "Asset return requested" : action === "returned" ? "Asset return recorded" : action === "voided" ? "Incorrect asset handover corrected" : "Asset receipt acknowledged",
    message: `${asset.tag}: ${assignment.employeeName}'s asset ${action.replace(/_/g, " ")}.`, category: "system", priority: action === "request_return" ? "high" : "medium",
    actionUrl: `/dashboard/assets?assignmentId=${assignment._id}`, dedupeEventKey: `assets:${action}:${assignment.revision}` }, session);
}

type Action = "created" | "updated" | "issued" | "state" | "acknowledged" | "request_return" | "returned" | "voided";
/** Asset and custody CAS, audit and notifications commit together; HTTP retries return current state. */
export const mutateAsset = (action: Action) => async (req: any, res: any, next: any) => {
  try {
    const employeeAction = ["acknowledged", "request_return"].includes(action), custodyAction = employeeAction || ["returned", "voided"].includes(action);
    const ctx = assetContext(req, employeeAction ? "self" : "manage"), body = req.body || {};
    await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: idString(ctx.company), actionLabel: "update asset custody" });
    for (const model of [Asset, Assignment, Audit, EmployeeControl, AssetCategory]) await model.init();
    const requestId = text(body.requestId, "Request id", 8, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 422);
    const note = text(body.note ?? "", "Acknowledgement note", 0, 1000);
    const reason = action === "created" ? "Registered company asset" : action === "acknowledged" ? note || "Employee confirmed physical receipt of the assigned asset" : text(body.reason, "Reason", 3, 1000);
    const input: any = { action, reason, revision: action === "created" ? null : revision(body.revision), target: action === "created" ? null : idString(objectId(custodyAction ? req.params.assignmentId : req.params.assetId, custodyAction ? "assignment id" : "asset id")) };
    if (["created", "updated"].includes(action)) input.content = normalizedAsset(body);
    if (action === "issued") {
      if (body.confirmHandover !== true) throw generateError("Confirm physical handover before issuing an asset", 422);
      Object.assign(input, { employee: objectId(body.employeeId, "employee id"), expectedReturnDate: expectedReturnDate(body.expectedReturnDate), handoverNotes: text(body.handoverNotes ?? "", "Handover notes", 0, 1000), confirmHandover: true });
      const reference = parseOnboardingAssetReference(body.onboardingReference);
      if (reference) input.onboardingReference = reference;
    }
    if (action === "acknowledged") { if (body.confirmReceipt !== true) throw generateError("Explicit asset receipt confirmation is required", 422); input.confirmReceipt = true; input.note = note; }
    if (action === "state") {
      if (!["maintenance", "available", "retire", "restore"].includes(body.action)) throw generateError("Choose a valid asset state action", 422);
      input.transition = body.action;
      if (body.action === "available") {
        if (!["new", "good", "fair"].includes(body.condition)) throw generateError("Record a usable asset condition before making it available", 422);
        input.condition = body.condition;
        if (body.confirmInspected === true) input.confirmInspected = true;
      }
    }
    if (action === "returned") {
      if (body.confirmReturnReceived !== true) throw generateError("Confirm the asset was physically received before recording its return", 422);
      if (!ASSET_CONDITIONS.includes(body.condition) || !["available", "maintenance"].includes(body.disposition)) throw generateError("Choose return condition and availability", 422);
      Object.assign(input, { assetRevision: revision(body.assetRevision), condition: body.condition, disposition: body.condition === "damaged" ? "maintenance" : body.disposition,
        officeLocation: body.officeLocation ? objectId(body.officeLocation, "return location") : null, confirmReturnReceived: true });
    }
    if (action === "voided") {
      if (body.confirmNoHandover !== true) throw generateError("Confirm custody never transferred before voiding an incorrect record", 422);
      input.assetRevision = revision(body.assetRevision); input.confirmNoHandover = true;
    }
    if (custodyAction || input.onboardingReference) await initializeOnboardingAssets();
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    let assetId: any, assignmentId: any = null, replayed = false;
    const replay = async (session?: mongoose.ClientSession) => {
      const prior: any = await Audit.findOne({ company: ctx.company, actor: ctx.actor._id, requestId }).select("+requestHash").session(session || null).lean();
      if (!prior) return false;
      if (prior.requestHash !== requestHash) throw generateError("Request id already used for another asset operation", 409);
      assetId = prior.asset; assignmentId = prior.assignment; replayed = true; return true;
    };
    try { await mongoose.connection.transaction(async (session) => {
      if (await replay(session)) return;
      // Old committed release keys remain replayable; every NEW release needs an explicit inspection attestation.
      if (action === "state" && input.transition === "available" && !input.confirmInspected) throw generateError("Confirm physical inspection before releasing maintenance equipment", 422);
      let asset: any, assignment: any = null, before: any = null;
      if (custodyAction) {
        assignment = await findAssignment(ctx, input.target, session);
        if (employeeAction && idString(assignment.employee) !== idString(ctx.actor)) throw generateError("Only the assigned employee can confirm receipt or request return", 403);
        if (["returned", "voided"].includes(action) && idString(assignment.employee) === idString(ctx.actor)) throw generateError("Another asset manager must close your asset custody record", 403);
        if (assignment.revision !== input.revision) throw generateError("Asset assignment changed. Reload before saving.", 409);
        asset = await findAsset(ctx, idString(assignment.asset), session);
        if (!assignment.active || ["returned", "voided"].includes(assignment.status) || asset.status !== "issued" || idString(asset.currentAssignment) !== idString(assignment)) throw generateError("This asset is no longer in this employee's custody. Reload first.", 409);
        await fenceAssetEmployee(ctx.company, assignment.employee, session);
        before = { asset: assetDto(ctx, asset), assignment: assignmentDto(ctx, assignment, asset) };
      } else if (action !== "created") {
        asset = await findAsset(ctx, input.target, session);
        if (asset.revision !== input.revision) throw generateError("Asset changed. Reload before saving.", 409);
        before = { asset: assetDto(ctx, asset) };
      }
      if (action === "created") {
        const content = input.content, assignedLocation = await location(ctx, content.officeLocation, session);
        const category = await resolveAssetCategory(ctx.company, content.category, session);
        asset = (await Asset.create([{ company: ctx.company, ...content, categoryName: category.name, tag: content.tag || generatedTag(), ...(content.serialNumber ? { serialKey: content.serialNumber.toUpperCase() } : {}), ...assignedLocation,
          status: content.condition === "damaged" ? "maintenance" : "available", createdBy: ctx.actor._id, updatedBy: ctx.actor._id }], { session }))[0].toObject();
      } else if (action === "updated") {
        if (!assetDto(ctx, asset).canEdit) throw generateError("Only unissued, non-retired assets can be edited", 409);
        if (input.content.tag && input.content.tag !== asset.tag) throw generateError("An asset tag cannot be changed after registration", 409);
        const { tag: _tag, ...content } = input.content, assignedLocation = await location(ctx, content.officeLocation, session, asset);
        const categoryName = content.category === asset.category ? asset.categoryName || BUILTIN_ASSET_CATEGORIES[asset.category] || asset.category : (await resolveAssetCategory(ctx.company, content.category, session)).name;
        const changes = { ...content, categoryName, ...assignedLocation, ...(content.serialNumber ? { serialKey: content.serialNumber.toUpperCase() } : {}), ...(content.condition === "damaged" ? { status: "maintenance" } : {}), updatedBy: ctx.actor._id };
        asset = await Asset.findOneAndUpdate({ _id: asset._id, company: ctx.company, revision: asset.revision, currentAssignment: null }, { $set: changes, ...(!content.serialNumber ? { $unset: { serialKey: "" } } : {}), $inc: { revision: 1 } }, { new: true, session, runValidators: true }).lean();
      } else if (action === "issued") {
        if (!assetDto(ctx, asset).canIssue) throw generateError("Only an available, usable, unissued asset can be handed over", 409);
        if (idString(input.employee) === idString(ctx.actor)) throw generateError("Another asset manager must issue assets to you", 403);
        const employee: any = await User.findOne({ _id: input.employee, company: ctx.company, ...activeEmployee }).select("_id name code").session(session).lean();
        if (!employee) throw generateError("Choose an enabled employee from this company", 422);
        const employeeControl = await fenceAssetEmployee(ctx.company, employee._id, session, true);
        const assetSnapshot = { ...Object.fromEntries(["tag", "name", "category", "brand", "model", "serialNumber"].map((key) => [key, asset[key]])), categoryName: asset.categoryName || BUILTIN_ASSET_CATEGORIES[asset.category] || asset.category };
        assignment = (await Assignment.create([{ company: ctx.company, asset: asset._id, assetSnapshot, employee: employee._id, employeeName: employee.name || employee.code || "Employee", employeeCode: employee.code || "",
          issuedBy: ctx.actor._id, issuerName: ctx.actor.name || "Asset manager", issuedAt: new Date(), conditionOut: asset.condition, expectedReturnDate: input.expectedReturnDate, handoverNotes: input.handoverNotes, employeeAssetSequence: employeeControl.revision }], { session }))[0].toObject();
        asset = await Asset.findOneAndUpdate({ _id: asset._id, company: ctx.company, revision: asset.revision, status: "available", currentAssignment: null, openIncident: null, openService: null, openWriteOff: null, writtenOffRecord: null, maintenanceReleaseBlocked: { $ne: true } }, { $set: { status: "issued", currentAssignment: assignment._id, holder: { employee: employee._id, name: assignment.employeeName, code: assignment.employeeCode }, updatedBy: ctx.actor._id }, $inc: { revision: 1 } }, { session, new: true }).lean();
      } else if (action === "state") {
        const dto = assetDto(ctx, asset), transition = input.transition;
        const allowed = transition === "maintenance" ? dto.canMaintain : transition === "available" ? dto.canMakeAvailable : transition === "retire" ? dto.canRetire : dto.canRestore;
        if (!allowed) throw generateError("This state change is not allowed while the asset is issued or in its current state", 409);
        const status = transition === "retire" ? "retired" : transition === "restore" ? asset.condition === "damaged" || asset.maintenanceReleaseBlocked ? "maintenance" : "available" : transition;
        asset = await Asset.findOneAndUpdate({ _id: asset._id, company: ctx.company, revision: asset.revision, currentAssignment: null, openService: null }, { $set: { status, ...(transition === "available" ? { condition: input.condition, lastInspection: { actor: ctx.actor._id, actorName: ctx.actor.name || "Asset manager", inspectedAt: new Date(), result: "passed", condition: input.condition, reason, serviceOrder: null } } : {}), updatedBy: ctx.actor._id }, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
      } else {
        let changes: any;
        if (action === "acknowledged") {
          if (!assignmentDto(ctx, assignment, asset).canAcknowledge) throw generateError("Receipt was already acknowledged or return has been requested", 409);
          changes = { acknowledgedAt: new Date(), acknowledgementNote: input.note };
        } else if (action === "request_return") {
          if (!assignmentDto(ctx, assignment, asset).canRequestReturn) throw generateError("A return has already been requested", 409);
          changes = { status: "return_requested", returnRequestedAt: new Date(), returnRequestReason: reason };
        } else if (action === "voided") {
          if (!assignmentDto(ctx, assignment, asset).canVoid) throw generateError("Acknowledged or return-requested handovers cannot be voided. Use physical return instead.", 409);
          if (asset.revision !== input.assetRevision) throw generateError("Asset changed. Reload before correcting the handover.", 409);
          asset = await Asset.findOneAndUpdate({ _id: asset._id, company: ctx.company, revision: asset.revision, currentAssignment: assignment._id, status: "issued" }, { $set: { status: "available", currentAssignment: null, holder: null, updatedBy: ctx.actor._id }, $inc: { revision: 1 } }, { session, new: true }).lean();
          changes = { active: false, status: "voided", voidedAt: new Date(), voidedBy: ctx.actor._id, voiderName: ctx.actor.name || "Asset manager", voidReason: reason };
        } else {
          if (asset.revision !== input.assetRevision) throw generateError("Asset inventory changed. Reload before recording the return.", 409);
          const assignedLocation = await location(ctx, input.officeLocation, session);
          // Returning a held unit recovers physical custody, but does not clear the case or make it reissuable.
          asset = await Asset.findOneAndUpdate({ _id: asset._id, company: ctx.company, revision: asset.revision, currentAssignment: assignment._id, status: "issued" }, { $set: { status: asset.openIncident ? "maintenance" : input.disposition, condition: input.condition, ...assignedLocation, currentAssignment: null, holder: null, updatedBy: ctx.actor._id }, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
          changes = { active: false, status: "returned", returnedAt: new Date(), returnedBy: ctx.actor._id, receiverName: ctx.actor.name || "Asset manager", conditionIn: input.condition, returnNotes: reason };
        }
        assignment = await Assignment.findOneAndUpdate({ _id: assignment._id, company: ctx.company, active: true, revision: assignment.revision }, { $set: changes, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
        if (!assignment) throw generateError("Asset assignment changed. Reload first.", 409);
      }
      if (!asset) throw generateError("Asset changed. Reload before saving.", 409);
      assetId = asset._id; assignmentId = assignment?._id || null;
      const [recordedAudit] = await Audit.create([{ company: ctx.company, asset: assetId, assignment: assignmentId, actor: ctx.actor._id, actorName: ctx.actor.name || "Employee", action: action === "state" ? input.transition : action, reason, requestId, requestHash,
        before, after: { asset: assetDto(ctx, asset), ...(assignment ? { assignment: assignmentDto(ctx, assignment, asset) } : {}) } }], { session });
      if (input.onboardingReference) await linkOnboardingAsset(ctx, input.onboardingReference, assignment, reason, `issue:${recordedAudit._id}`, session);
      else if (custodyAction) await syncOnboardingAssetCustody(ctx, assignment, action, recordedAudit._id, session);
      if (assignment) await notify(ctx, asset, assignment, action, session);
      if (assignment && ["returned", "voided", "request_return"].includes(action)) await notifyClearanceChange(ctx, assignment.employee, action, String(recordedAudit._id), session);
    }); } catch (error: any) {
      if (error.code !== 11000) throw error;
      if (!await replay()) throw generateError("Asset tag/serial number already exists, the asset is already issued, or its revision changed. Reload first.", 409);
    }
    const assignment = assignmentId ? await findAssignment(ctx, idString(assignmentId)) : null;
    const asset = await findAsset(ctx, idString(assetId));
    res.status(action === "created" && !replayed ? 201 : 200).json({ success: true, data: { ...(canViewAssets(ctx) ? { asset: assetDto(ctx, asset) } : {}), ...(assignment ? { assignment: assignmentDto(ctx, assignment, asset) } : {}) }, replayed });
  } catch (error) { next(error); }
};
