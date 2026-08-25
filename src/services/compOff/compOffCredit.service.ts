import mongoose, { ClientSession } from "mongoose";
import { generateError } from "../../config/Error/functions";
import CompOffCreditLot from "../../schemas/CompOff/CompOffCreditLot.schema";
import { postLeaveBalanceTransaction } from "../leave/leaveBalance.service";
import { CompOffUsage, planCompOffFifoAllocations } from "./compOffCredit.utils";

function roundUnits(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 10000) / 10000;
}

function balanceKey(lot: any) {
  return {
    company: lot.company,
    employee: lot.employee,
    leaveType: lot.leaveType,
    leaveYearKey: lot.leaveYearKey,
    leaveYearStart: lot.leaveYearStart,
    leaveYearEnd: lot.leaveYearEnd,
  };
}

function lotStatus(lot: any) {
  if (Number(lot.availableUnits || 0) > 0 || Number(lot.reservedUnits || 0) > 0) {
    return "active";
  }
  return Number(lot.expiredUnits || 0) > 0 ? "expired" : "exhausted";
}

async function postLotExpiry(options: {
  lot: any;
  units: number;
  effectiveDate: string;
  actorId: mongoose.Types.ObjectId;
  session: ClientSession;
  eventKey: string;
}) {
  if (options.units <= 0) return;
  await postLeaveBalanceTransaction({
    key: balanceKey(options.lot),
    units: -options.units,
    transactionType: "expiry",
    sourceType: "system",
    sourceId: options.lot._id,
    effectiveDate: options.effectiveDate,
    idempotencyKey: `comp-off-lot:${options.lot._id}:expiry:${options.eventKey}`,
    reason: `Comp-off credit expired on ${options.lot.expiresOn}`,
    leavePolicyAssignment: options.lot.leavePolicyAssignment,
    leavePolicy: options.lot.leavePolicy,
    leavePolicyVersion: options.lot.leavePolicyVersion,
    compOffCreditLot: options.lot._id,
    createdBy: options.actorId,
    session: options.session,
  });
}

export async function expireCompOffCredits(options: {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  asOf: string;
  actorId: mongoose.Types.ObjectId;
  leaveType?: mongoose.Types.ObjectId;
  session: ClientSession;
}) {
  const match: any = {
    company: options.company,
    employee: options.employee,
    expiresOn: { $lt: options.asOf },
    availableUnits: { $gt: 0 },
  };
  if (options.leaveType) match.leaveType = options.leaveType;
  const lots = await CompOffCreditLot.find(match).sort({ expiresOn: 1, earnedDate: 1 }).session(options.session);
  for (const lot of lots) {
    const units = roundUnits(lot.availableUnits);
    lot.availableUnits = 0;
    lot.expiredUnits = roundUnits(Number(lot.expiredUnits || 0) + units);
    lot.status = lotStatus(lot);
    await lot.save({ session: options.session });
    await postLotExpiry({
      lot,
      units,
      effectiveDate: options.asOf,
      actorId: options.actorId,
      session: options.session,
      eventKey: `available:${options.asOf}`,
    });
  }
  return lots.length;
}

export async function reserveCompOffCredits(options: {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  leaveType: mongoose.Types.ObjectId;
  leaveYearKey: string;
  usage: CompOffUsage[];
  session: ClientSession;
}) {
  const firstUsageDate = [...options.usage]
    .sort((left, right) => left.attendanceDate.localeCompare(right.attendanceDate))[0]?.attendanceDate;
  if (!firstUsageDate) return [];
  const lots = await CompOffCreditLot.find({
    company: options.company,
    employee: options.employee,
    leaveType: options.leaveType,
    leaveYearKey: options.leaveYearKey,
    status: "active",
    expiresOn: { $gte: firstUsageDate },
    availableUnits: { $gt: 0 },
  })
    .sort({ expiresOn: 1, earnedDate: 1, createdAt: 1 })
    .session(options.session);
  const plan = planCompOffFifoAllocations(
    lots.map((lot) => ({ id: String(lot._id), expiresOn: lot.expiresOn, availableUnits: lot.availableUnits })),
    options.usage
  );
  if (!plan) {
    throw generateError("Insufficient unexpired comp-off credits for the selected leave dates", 422);
  }

  const lotById = new Map(lots.map((lot) => [String(lot._id), lot]));
  const allocations: Array<{ creditLot: mongoose.Types.ObjectId; units: number; expiresOn: string; status: "reserved" }> = [];
  for (const allocation of plan) {
    const lot = lotById.get(allocation.lotId);
    if (!lot) throw generateError("Comp-off credit allocation is inconsistent", 409);
    const units = allocation.units;
    lot.availableUnits = roundUnits(Number(lot.availableUnits) - units);
    lot.reservedUnits = roundUnits(Number(lot.reservedUnits || 0) + units);
    lot.status = lotStatus(lot);
    await lot.save({ session: options.session });
    allocations.push({ creditLot: lot._id as mongoose.Types.ObjectId, units, expiresOn: lot.expiresOn, status: "reserved" });
  }
  return allocations;
}

export async function consumeReservedCompOffCredits(request: any, session: ClientSession) {
  for (const allocation of request.compOffAllocations || []) {
    if (allocation.status !== "reserved") continue;
    const lot = await CompOffCreditLot.findOne({
      _id: allocation.creditLot,
      company: request.company,
      employee: request.employee,
      leaveType: request.leaveType,
      reservedUnits: { $gte: allocation.units },
    }).session(session);
    if (!lot) throw generateError("Reserved comp-off credit is inconsistent", 409);
    lot.reservedUnits = roundUnits(Number(lot.reservedUnits) - Number(allocation.units));
    lot.consumedUnits = roundUnits(Number(lot.consumedUnits || 0) + Number(allocation.units));
    lot.status = lotStatus(lot);
    await lot.save({ session });
    allocation.status = "consumed";
  }
}

export async function releaseReservedCompOffCredits(options: {
  request: any;
  actorId: mongoose.Types.ObjectId;
  asOf: string;
  session: ClientSession;
}) {
  for (const allocation of options.request.compOffAllocations || []) {
    if (allocation.status !== "reserved") continue;
    const lot = await CompOffCreditLot.findOne({
      _id: allocation.creditLot,
      company: options.request.company,
      reservedUnits: { $gte: allocation.units },
    }).session(options.session);
    if (!lot) throw generateError("Reserved comp-off credit is inconsistent", 409);
    lot.reservedUnits = roundUnits(Number(lot.reservedUnits) - Number(allocation.units));
    if (lot.expiresOn < options.asOf) {
      lot.expiredUnits = roundUnits(Number(lot.expiredUnits || 0) + Number(allocation.units));
      allocation.status = "expired";
      await postLotExpiry({
        lot,
        units: Number(allocation.units),
        effectiveDate: options.asOf,
        actorId: options.actorId,
        session: options.session,
        eventKey: `release:${options.request._id}:${allocation.creditLot}`,
      });
    } else {
      lot.availableUnits = roundUnits(Number(lot.availableUnits || 0) + Number(allocation.units));
      allocation.status = "released";
    }
    lot.status = lotStatus(lot);
    await lot.save({ session: options.session });
  }
}

export async function reverseConsumedCompOffCredits(options: {
  request: any;
  actorId: mongoose.Types.ObjectId;
  asOf: string;
  session: ClientSession;
}) {
  for (const allocation of options.request.compOffAllocations || []) {
    if (allocation.status !== "consumed") continue;
    const lot = await CompOffCreditLot.findOne({
      _id: allocation.creditLot,
      company: options.request.company,
      consumedUnits: { $gte: allocation.units },
    }).session(options.session);
    if (!lot) throw generateError("Consumed comp-off credit is inconsistent", 409);
    lot.consumedUnits = roundUnits(Number(lot.consumedUnits) - Number(allocation.units));
    if (lot.expiresOn < options.asOf) {
      lot.expiredUnits = roundUnits(Number(lot.expiredUnits || 0) + Number(allocation.units));
      allocation.status = "expired";
      await postLotExpiry({
        lot,
        units: Number(allocation.units),
        effectiveDate: options.asOf,
        actorId: options.actorId,
        session: options.session,
        eventKey: `reversal:${options.request._id}:${allocation.creditLot}`,
      });
    } else {
      lot.availableUnits = roundUnits(Number(lot.availableUnits || 0) + Number(allocation.units));
      allocation.status = "reversed";
    }
    lot.status = lotStatus(lot);
    await lot.save({ session: options.session });
  }
}
