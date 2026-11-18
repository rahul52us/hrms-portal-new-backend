import mongoose from "mongoose";
import { Asset, AssetAssignment as Assignment } from "../../schemas/Assets/Asset.schema";
import { AssetIncident as Incident } from "../../schemas/Assets/AssetIncident.schema";
import { AssetWriteOff as WriteOff } from "../../schemas/Assets/AssetWriteOff.schema";
import { AssetEmployeeControl as Control } from "../../schemas/Assets/AssetClearance.schema";
import { AssetContext, canViewAssets, idString } from "./asset.utils";
import { canManageClearances } from "./assetClearance.guard";

/** New handovers use a serial cutoff; historical pre-fence rows fall back to their immutable server-issued timestamp. */
export function clearanceCustodyMatch(company: any, clearance: any) {
  return { company, employee: clearance.employee, $and: [
    { $or: [{ employeeAssetSequence: { $lte: clearance.issueSequenceCutoff } }, { employeeAssetSequence: { $exists: false }, issuedAt: { $lte: new Date(clearance.openedAt) } }] },
    { $or: [{ active: true }, { returnedAt: { $gte: new Date(clearance.openedAt) } }, { voidedAt: { $gte: new Date(clearance.openedAt) } }, { writtenOffAt: { $gte: new Date(clearance.openedAt) } }] },
  ] };
}
export async function clearanceReadiness(company: any, clearance: any, session: mongoose.ClientSession, knownControl?: any) {
  const control: any = knownControl || await Control.findOne({ company, employee: clearance.employee }).session(session).lean();
  const outstanding = await Assignment.countDocuments({ company, employee: clearance.employee, active: true }).session(session);
  const returnRequested = await Assignment.countDocuments({ company, employee: clearance.employee, active: true, status: "return_requested" }).session(session);
  const incidents = await Incident.countDocuments({ company, employee: clearance.employee, active: true }).session(session);
  const pendingWriteOffs = await WriteOff.countDocuments({ company, employee: clearance.employee, status: "pending" }).session(session);
  const resolutions: any[] = await Assignment.aggregate([{ $match: clearanceCustodyMatch(company, clearance) }, { $group: { _id: "$status", total: { $sum: 1 } } }]).session(session);
  // Validate both directions: a live handover must match inventory, and inventory must not point at a closed/missing handover.
  const mismatch: any[] = await Assignment.aggregate([
    { $match: { company, employee: clearance.employee } },
    { $lookup: { from: Asset.collection.name, localField: "asset", foreignField: "_id", pipeline: [{ $match: { company } }, { $project: { status: 1, currentAssignment: 1, holder: 1 } }], as: "unit" } },
    { $set: { unit: { $ifNull: [{ $arrayElemAt: ["$unit", 0] }, {}] } } },
    { $match: { $expr: { $or: [
      { $and: [{ $eq: ["$active", true] }, { $or: [{ $ne: [{ $ifNull: ["$unit.status", null] }, "issued"] }, { $ne: [{ $ifNull: ["$unit.currentAssignment", null] }, "$_id"] }, { $ne: [{ $ifNull: ["$unit.holder.employee", null] }, clearance.employee] }, { $not: [{ $in: ["$status", ["issued", "return_requested"]] }] }] }] },
      { $and: [{ $ne: ["$active", true] }, { $eq: ["$unit.currentAssignment", "$_id"] }] },
    ] } } }, { $count: "total" },
  ]).session(session);
  const orphaned: any[] = await Asset.aggregate([
    { $match: { company, "holder.employee": clearance.employee } },
    { $lookup: { from: Assignment.collection.name, localField: "currentAssignment", foreignField: "_id", let: { unitId: "$_id" }, pipeline: [{ $match: { company, employee: clearance.employee, active: true, status: { $in: ["issued", "return_requested"] }, $expr: { $eq: ["$asset", "$$unitId"] } } }, { $project: { _id: 1 } }], as: "custody" } },
    { $match: { $or: [{ "custody.0": { $exists: false } }, { status: { $ne: "issued" } }] } }, { $count: "total" },
  ]).session(session);
  const integrityFindings = (mismatch[0]?.total || 0) + (orphaned[0]?.total || 0);
  const count = (status: string) => resolutions.find((row) => row._id === status)?.total || 0;
  return { evaluatedAt: new Date(), evidenceRevision: control?.sourceRevision || 0, outstanding, returnRequested, openIncidents: incidents, pendingWriteOffs, integrityFindings,
    returned: count("returned"), voided: count("voided"), writtenOff: count("written_off"), ready: outstanding === 0 && pendingWriteOffs === 0 && integrityFindings === 0 };
}
export const visibleClearance = (ctx: AssetContext, clearance: any) => canViewAssets(ctx) || idString(ctx.actor) === idString(clearance.employee);
export function clearanceDto(ctx: AssetContext, clearance: any, summary: any, control?: any) {
  const current = Boolean(clearance.isCurrent && control?.issueBlocked && idString(control.clearance) === idString(clearance));
  const manage = current && canManageClearances(ctx) && idString(ctx.actor) !== idString(clearance.employee);
  const { _id, reference, employee, employeeName, employeeCode, openedAt, lastWorkingDate, status, revision, cycle, initialOutstanding, creatorName, openingReason, clearedAt, clearerName, clearanceReason, cancelledAt, cancellerName, cancellationReason, clearanceEvidence } = clearance;
  return { _id, reference, employee, employeeName, employeeCode, openedAt, lastWorkingDate, status, revision, cycle, initialOutstanding, creatorName, openingReason, clearedAt, clearerName, clearanceReason, cancelledAt, cancellerName, cancellationReason, clearanceEvidence,
    summary, isCurrent: clearance.isCurrent, issueBlocked: current, isCurrentlyClear: Boolean(status === "cleared" && current && summary?.ready && clearanceEvidence?.evidenceRevision === summary.evidenceRevision),
    canViewCompany: canViewAssets(ctx), canClear: Boolean(manage && status === "open" && summary?.ready), canReopen: Boolean(manage && status === "cleared"), canCancel: Boolean(manage), canReschedule: Boolean(manage && status === "open"), canAddNote: Boolean(manage) };
}
