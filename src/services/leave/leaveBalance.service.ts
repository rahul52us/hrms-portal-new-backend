import mongoose, { ClientSession } from "mongoose";
import { generateError } from "../../config/Error/functions";
import EmployeeLeaveBalance from "../../schemas/Leave/EmployeeLeaveBalance.schema";
import LeaveBalanceTransaction, {
  LEAVE_TRANSACTION_TYPES,
} from "../../schemas/Leave/LeaveBalanceTransaction.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import LeaveEncashmentRequest from "../../schemas/Leave/LeaveEncashmentRequest.schema";

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
  sourceType: "leave_request" | "leave_encashment" | "comp_off_claim" | "manual" | "policy" | "system";
  sourceId?: mongoose.Types.ObjectId | null;
  effectiveDate: string;
  idempotencyKey: string;
  reason: string;
  leavePolicyAssignment?: mongoose.Types.ObjectId | null;
  leavePolicy?: mongoose.Types.ObjectId | null;
  leavePolicyVersion?: mongoose.Types.ObjectId | null;
  reversalOf?: mongoose.Types.ObjectId | null;
  compOffCreditLot?: mongoose.Types.ObjectId | null;
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
