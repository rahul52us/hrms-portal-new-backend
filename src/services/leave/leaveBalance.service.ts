import mongoose, { ClientSession } from "mongoose";
import { generateError } from "../../config/Error/functions";
import EmployeeLeaveBalance from "../../schemas/Leave/EmployeeLeaveBalance.schema";
import LeaveBalanceTransaction, {
  LEAVE_TRANSACTION_TYPES,
} from "../../schemas/Leave/LeaveBalanceTransaction.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import LeaveEncashmentRequest from "../../schemas/Leave/LeaveEncashmentRequest.schema";
import LeaveCarryForwardLot from "../../schemas/Leave/LeaveCarryForwardLot.schema";

export interface LeaveBalanceKey {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  leaveType: mongoose.Types.ObjectId;
  leaveYearKey: string;
  leaveYearStart: string;
  leaveYearEnd: string;
}

function roundUnits(value: number) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function keyFilter(key: LeaveBalanceKey) {
  return {
    company: key.company,
    employee: key.employee,
    leaveType: key.leaveType,
    leaveYearKey: key.leaveYearKey,
  };
}

function carryForwardLotStatus(lot: any) {
  if (Number(lot.availableUnits || 0) > 0) return "active";
  return Number(lot.expiredUnits || 0) > 0 ? "expired" : "exhausted";
}

async function allocateCarryForwardLots(options: {
  key: LeaveBalanceKey;
  units: number;
  session: ClientSession;
}) {
  let remaining = roundUnits(Math.abs(options.units));
  const lots = await LeaveCarryForwardLot.find({
    ...keyFilter(options.key),
    status: "active",
    availableUnits: { $gt: 0 },
  }).session(options.session);
  lots.sort((left: any, right: any) => {
    const leftExpiry = left.expiresOn || "9999-12-31";
    const rightExpiry = right.expiresOn || "9999-12-31";
    return leftExpiry.localeCompare(rightExpiry) || String(left._id).localeCompare(String(right._id));
  });

  const allocations: Array<{ lot: mongoose.Types.ObjectId; units: number }> = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const units = roundUnits(Math.min(remaining, Number(lot.availableUnits || 0)));
    if (units <= 0) continue;
    lot.availableUnits = roundUnits(Number(lot.availableUnits || 0) - units);
    lot.consumedUnits = roundUnits(Number(lot.consumedUnits || 0) + units);
    lot.status = carryForwardLotStatus(lot);
    await lot.save({ session: options.session });
    allocations.push({ lot: lot._id as mongoose.Types.ObjectId, units });
    remaining = roundUnits(remaining - units);
  }
  return allocations;
}

async function restoreCarryForwardLots(options: {
  key: LeaveBalanceKey;
  reversalOf: mongoose.Types.ObjectId;
  effectiveDate: string;
  session: ClientSession;
}) {
  const original = await LeaveBalanceTransaction.findOne({
    _id: options.reversalOf,
    company: options.key.company,
  }).session(options.session);
  if (!original) throw generateError("The original leave transaction could not be found", 409);

  const allocations = original.carryForwardAllocations || [];
  const expiredRestorations: Array<{ lot: any; units: number }> = [];
  for (const allocation of allocations) {
    const lot = await LeaveCarryForwardLot.findOne({
      _id: allocation.lot,
      ...keyFilter(options.key),
      consumedUnits: { $gte: allocation.units },
    }).session(options.session);
    if (!lot) throw generateError("Carried leave allocation is inconsistent", 409);
    const units = roundUnits(Number(allocation.units));
    lot.consumedUnits = roundUnits(Number(lot.consumedUnits || 0) - units);
    if (lot.expiresOn && lot.expiresOn < options.effectiveDate) {
      lot.expiredUnits = roundUnits(Number(lot.expiredUnits || 0) + units);
      expiredRestorations.push({ lot, units });
    } else {
      lot.availableUnits = roundUnits(Number(lot.availableUnits || 0) + units);
    }
    lot.status = carryForwardLotStatus(lot);
    await lot.save({ session: options.session });
  }
  return { allocations, expiredRestorations };
}

async function ensureProjection(key: LeaveBalanceKey, session: ClientSession) {
  return EmployeeLeaveBalance.findOneAndUpdate(
    keyFilter(key),
    {
      $setOnInsert: {
        ...keyFilter(key),
        leaveYearStart: key.leaveYearStart,
        leaveYearEnd: key.leaveYearEnd,
        creditedUnits: 0,
        debitedUnits: 0,
        pendingUnits: 0,
        balanceUnits: 0,
        availableUnits: 0,
        negativeBalanceLimit: 0,
        lastCalculatedAt: new Date(),
      },
    },
    { upsert: true, new: true, session, setDefaultsOnInsert: true }
  );
}

export async function reserveLeaveBalance(options: {
  key: LeaveBalanceKey;
  units: number;
  maxNegativeBalance: number;
  session: ClientSession;
}) {
  const units = roundUnits(options.units);
  const maxNegativeBalance = Math.max(0, roundUnits(options.maxNegativeBalance));
  await ensureProjection(options.key, options.session);
  const updated = await EmployeeLeaveBalance.findOneAndUpdate(
    {
      ...keyFilter(options.key),
      availableUnits: { $gte: roundUnits(units - maxNegativeBalance) },
    },
    {
      $inc: { pendingUnits: units, availableUnits: -units },
      $set: { negativeBalanceLimit: maxNegativeBalance, lastCalculatedAt: new Date() },
    },
    { new: true, session: options.session }
  );
  if (!updated) {
    throw generateError(
      `Insufficient leave balance for leave year ${options.key.leaveYearStart} to ${options.key.leaveYearEnd}`,
      422
    );
  }
  return updated;
}

export async function releasePendingLeaveBalance(options: {
  key: LeaveBalanceKey;
  units: number;
  session: ClientSession;
}) {
  const units = roundUnits(options.units);
  const updated = await EmployeeLeaveBalance.findOneAndUpdate(
    {
      ...keyFilter(options.key),
      pendingUnits: { $gte: units },
    },
    {
      $inc: { pendingUnits: -units, availableUnits: units },
      $set: { lastCalculatedAt: new Date() },
    },
    { new: true, session: options.session }
  );
  if (!updated) {
    throw generateError("Reserved leave balance is inconsistent; rebuild the employee balance", 409);
  }
  return updated;
}

export async function postLeaveBalanceTransaction(options: {
  key: LeaveBalanceKey;
  units: number;
  transactionType: (typeof LEAVE_TRANSACTION_TYPES)[number];
  sourceType: "leave_request" | "leave_encashment" | "comp_off_claim" | "manual" | "policy" | "system" | "year_end";
  sourceId?: mongoose.Types.ObjectId | null;
  effectiveDate: string;
  idempotencyKey: string;
  reason: string;
  leavePolicyAssignment?: mongoose.Types.ObjectId | null;
  leavePolicy?: mongoose.Types.ObjectId | null;
  leavePolicyVersion?: mongoose.Types.ObjectId | null;
  reversalOf?: mongoose.Types.ObjectId | null;
  compOffCreditLot?: mongoose.Types.ObjectId | null;
  carryForwardLot?: mongoose.Types.ObjectId | null;
  skipCarryForwardAllocation?: boolean;
  createdBy: mongoose.Types.ObjectId;
  session: ClientSession;
}) {
  const units = roundUnits(options.units);
  if (!Number.isFinite(units) || units === 0) {
    throw generateError("Leave transaction units must be non-zero", 400);
  }
  const existing = await LeaveBalanceTransaction.findOne({
    company: options.key.company,
    idempotencyKey: options.idempotencyKey,
  }).session(options.session);
  if (existing) return existing;

  let carryForwardAllocations: Array<{ lot: mongoose.Types.ObjectId; units: number }> = [];
  let expiredRestorations: Array<{ lot: any; units: number }> = [];
  if (units < 0 && !options.skipCarryForwardAllocation && !["expiry", "comp_off_reversal"].includes(options.transactionType)) {
    carryForwardAllocations = await allocateCarryForwardLots({
      key: options.key,
      units,
      session: options.session,
    });
  } else if (units > 0 && options.reversalOf) {
    const restored = await restoreCarryForwardLots({
      key: options.key,
      reversalOf: options.reversalOf,
      effectiveDate: options.effectiveDate,
      session: options.session,
    });
    carryForwardAllocations = restored.allocations.map((allocation: any) => ({
      lot: allocation.lot,
      units: allocation.units,
    }));
    expiredRestorations = restored.expiredRestorations;
  }

  const [transaction] = await LeaveBalanceTransaction.create(
    [
      {
        ...options.key,
        units,
        transactionType: options.transactionType,
        sourceType: options.sourceType,
        sourceId: options.sourceId || null,
        effectiveDate: options.effectiveDate,
        idempotencyKey: options.idempotencyKey,
        reason: options.reason,
        leavePolicyAssignment: options.leavePolicyAssignment || null,
        leavePolicy: options.leavePolicy || null,
        leavePolicyVersion: options.leavePolicyVersion || null,
        reversalOf: options.reversalOf || null,
        compOffCreditLot: options.compOffCreditLot || null,
        carryForwardLot: options.carryForwardLot || null,
        carryForwardAllocations,
        createdBy: options.createdBy,
      },
    ],
    { session: options.session }
  );

  await ensureProjection(options.key, options.session);
  const positiveUnits = units > 0 ? units : 0;
  const negativeUnits = units < 0 ? Math.abs(units) : 0;
  await EmployeeLeaveBalance.updateOne(
    keyFilter(options.key),
    {
      $inc: {
        creditedUnits: positiveUnits,
        debitedUnits: negativeUnits,
        balanceUnits: units,
        availableUnits: units,
      },
      $set: {
        lastTransaction: transaction._id,
        lastCalculatedAt: new Date(),
      },
    },
    { session: options.session }
  );

  for (const restoration of expiredRestorations) {
    const expiryIdempotencyKey = `${options.idempotencyKey}:carry-forward-expiry:${restoration.lot._id}`;
    const [expiryTransaction] = await LeaveBalanceTransaction.create(
      [
        {
          ...options.key,
          units: -restoration.units,
          transactionType: "expiry",
          sourceType: "year_end",
          sourceId: restoration.lot.sourceClosure,
          effectiveDate: options.effectiveDate,
          idempotencyKey: expiryIdempotencyKey,
          reason: `Restored carried leave had expired on ${restoration.lot.expiresOn}`,
          leavePolicyAssignment: restoration.lot.leavePolicyAssignment || null,
          leavePolicy: restoration.lot.leavePolicy || null,
          leavePolicyVersion: restoration.lot.leavePolicyVersion || null,
          carryForwardLot: restoration.lot._id,
          carryForwardAllocations: [],
          createdBy: options.createdBy,
        },
      ],
      { session: options.session }
    );
    await EmployeeLeaveBalance.updateOne(
      keyFilter(options.key),
      {
        $inc: {
          debitedUnits: restoration.units,
          balanceUnits: -restoration.units,
          availableUnits: -restoration.units,
        },
        $set: {
          lastTransaction: expiryTransaction._id,
          lastCalculatedAt: new Date(),
        },
      },
      { session: options.session }
    );
  }
  return transaction;
}

export async function rebuildLeaveBalanceProjection(options: {
  key: LeaveBalanceKey;
  session: ClientSession;
}) {
  const [ledgerTotals] = await LeaveBalanceTransaction.aggregate([
    { $match: keyFilter(options.key) },
    { $sort: { createdAt: 1, _id: 1 } },
    {
      $group: {
        _id: null,
        creditedUnits: { $sum: { $cond: [{ $gt: ["$units", 0] }, "$units", 0] } },
        debitedUnits: { $sum: { $cond: [{ $lt: ["$units", 0] }, { $abs: "$units" }, 0] } },
        balanceUnits: { $sum: "$units" },
        lastTransaction: { $last: "$_id" },
      },
    },
  ]).session(options.session);

  const [pendingLeaveTotals, pendingEncashmentTotals] = await Promise.all([
    LeaveRequest.aggregate([
      {
        $match: {
          company: options.key.company,
          employee: options.key.employee,
          leaveType: options.key.leaveType,
          status: "submitted",
        },
      },
      { $unwind: "$dayBreakdown" },
      { $match: { "dayBreakdown.leaveYearKey": options.key.leaveYearKey } },
      { $group: { _id: null, pendingUnits: { $sum: "$dayBreakdown.chargedUnits" } } },
    ]).session(options.session),
    LeaveEncashmentRequest.aggregate([
      {
        $match: {
          company: options.key.company,
          employee: options.key.employee,
          leaveType: options.key.leaveType,
          leaveYearKey: options.key.leaveYearKey,
          status: "submitted",
        },
      },
      { $group: { _id: null, pendingUnits: { $sum: "$requestedUnits" } } },
    ]).session(options.session),
  ]);

  const creditedUnits = roundUnits(ledgerTotals?.creditedUnits || 0);
  const debitedUnits = roundUnits(ledgerTotals?.debitedUnits || 0);
  const balanceUnits = roundUnits(ledgerTotals?.balanceUnits || 0);
  const pendingUnits = roundUnits(
    Number(pendingLeaveTotals[0]?.pendingUnits || 0) +
    Number(pendingEncashmentTotals[0]?.pendingUnits || 0)
  );
  return EmployeeLeaveBalance.findOneAndUpdate(
    keyFilter(options.key),
    {
      $set: {
        ...keyFilter(options.key),
        leaveYearStart: options.key.leaveYearStart,
        leaveYearEnd: options.key.leaveYearEnd,
        creditedUnits,
        debitedUnits,
        pendingUnits,
        balanceUnits,
        availableUnits: roundUnits(balanceUnits - pendingUnits),
        lastTransaction: ledgerTotals?.lastTransaction || null,
        lastCalculatedAt: new Date(),
      },
    },
    { upsert: true, new: true, session: options.session, setDefaultsOnInsert: true }
  );
}
