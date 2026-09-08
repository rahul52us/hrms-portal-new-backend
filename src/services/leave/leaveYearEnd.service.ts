import { NextFunction, Response } from "express";
import mongoose, { ClientSession } from "mongoose";
import { generateError } from "../../config/Error/functions";
import EmployeeLeaveBalance from "../../schemas/Leave/EmployeeLeaveBalance.schema";
import LeaveCarryForwardLot from "../../schemas/Leave/LeaveCarryForwardLot.schema";
import LeaveYearEndClosure from "../../schemas/Leave/LeaveYearEndClosure.schema";
import LeaveYearEndRun from "../../schemas/Leave/LeaveYearEndRun.schema";
import User from "../../schemas/User/User";
import LeaveType from "../../schemas/WorkforcePolicy/LeaveType.schema";
import { resolveEmployeeDayContext } from "../attendance/employeeDayContext.service";
import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";
import { PERMISSION_KEYS, hasPermission } from "../permissions/permission.utils";
import { ensureEmployeeLeaveAccruals, runCompanyLeaveAccrualCatchUp } from "./leaveAccrual.service";
import {
  ensureEmployeeInActorScope,
  getLeaveActor,
  resolveLeaveCompanyId,
} from "./leaveAccess.utils";
import { LeaveBalanceKey, postLeaveBalanceTransaction } from "./leaveBalance.service";
import { resolveLeaveYear } from "./leaveRequestCalculator.utils";
import {
  calculateCarryForwardExpiry,
  nextDateKey,
  planCarryForwardExpiryUnits,
  planLeaveYearEndAmounts,
  roundLeaveUnits,
} from "./leaveYearEndCalculator.utils";

const EMPLOYEE_FIELDS =
  "_id company name username code role joiningDate employmentEndDate department team officeLocation reportingManager is_enabled deletedAt";

function text(value: unknown) {
  return String(value || "").trim();
}

function objectId(value: unknown, label: string) {
  const normalized = text((value as any)?._id || value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function optionalObjectId(value: unknown) {
  const normalized = text((value as any)?._id || value);
  return mongoose.Types.ObjectId.isValid(normalized)
    ? new mongoose.Types.ObjectId(normalized)
    : null;
}

function currentDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function balanceKey(balance: any): LeaveBalanceKey {
  return {
    company: objectId(balance.company, "company id"),
    employee: objectId(balance.employee, "employee id"),
    leaveType: objectId(balance.leaveType, "leave type id"),
    leaveYearKey: balance.leaveYearKey,
    leaveYearStart: balance.leaveYearStart,
    leaveYearEnd: balance.leaveYearEnd,
  };
}

function closureFilter(balance: any) {
  return {
    company: balance.company,
    employee: balance.employee,
    leaveType: balance.leaveType,
    sourceLeaveYearKey: balance.leaveYearKey,
  };
}

function balanceProjectionFilter(balance: any) {
  return {
    company: balance.company,
    employee: balance.employee,
    leaveType: balance.leaveType,
    leaveYearKey: balance.leaveYearKey,
  };
}

function policyReferences(context: any) {
  const reference = context?.policyReferences?.leavePolicy || {};
  return {
    assignment: optionalObjectId(reference.assignmentId),
    policy: optionalObjectId(reference.resourceId),
    version: optionalObjectId(reference.versionId),
  };
}

async function updateClosureState(options: {
  balance: any;
  runId: mongoose.Types.ObjectId;
  actorId?: mongoose.Types.ObjectId | null;
  sourceContext?: any;
  rule?: any;
  status: "partial" | "completed" | "not_applicable" | "configuration_error";
  message: string;
  destination?: { leaveYearKey: string; leaveYearStart: string; leaveYearEnd: string } | null;
}) {
  const refs = policyReferences(options.sourceContext);
  const update: any = {
    $set: {
      sourceLeaveYearStart: options.balance.leaveYearStart,
      sourceLeaveYearEnd: options.balance.leaveYearEnd,
      sourceLeavePolicyAssignment: refs.assignment,
      sourceLeavePolicy: refs.policy,
      sourceLeavePolicyVersion: refs.version,
      carryForwardEnabledSnapshot: options.rule?.carryForwardEnabled === true,
      maxCarryForwardSnapshot: Math.max(0, Number(options.rule?.maxCarryForward || 0)),
      carryForwardExpiryMonthsSnapshot: Math.max(
        0,
        Number(options.rule?.carryForwardExpiryMonths || 0)
      ),
      pendingUnits: Math.max(0, Number(options.balance.pendingUnits || 0)),
      remainingBalanceUnits: Number(options.balance.balanceUnits || 0),
      status: options.status,
      message: options.message,
      lastRun: options.runId,
      completedAt: ["completed", "not_applicable"].includes(options.status) ? new Date() : null,
      lastProcessedAt: new Date(),
      updatedBy: options.actorId || null,
    },
    $setOnInsert: {
      ...closureFilter(options.balance),
      carriedUnits: 0,
      lapsedUnits: 0,
      iteration: 0,
      createdBy: options.actorId || null,
    },
  };
  if (options.destination) {
    update.$set.destinationLeaveYearKey = options.destination.leaveYearKey;
    update.$set.destinationLeaveYearStart = options.destination.leaveYearStart;
    update.$set.destinationLeaveYearEnd = options.destination.leaveYearEnd;
  }
  return LeaveYearEndClosure.findOneAndUpdate(closureFilter(options.balance), update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });
}

async function processClosedBalance(options: {
  balance: any;
  employee: any;
  runId: mongoose.Types.ObjectId;
  actorId?: mongoose.Types.ObjectId | null;
}) {
  const { balance, employee, runId, actorId } = options;
  const existingClosure = await LeaveYearEndClosure.findOne(closureFilter(balance)).lean();
  if (existingClosure?.status === "not_applicable") {
    return { status: existingClosure.status, carryUnits: 0, lapseUnits: 0 };
  }

  const sourceContext = await resolveEmployeeDayContext({
    companyId: balance.company,
    employeeId: balance.employee,
    attendanceDate: balance.leaveYearEnd,
  });
  const sourceResolved = sourceContext.policies.leavePolicy;
  const sourceVersion = sourceResolved?.version;
  const rule = (sourceVersion?.rules || []).find(
    (item: any) => String(item.leaveType?._id || item.leaveType) === String(balance.leaveType)
  );
  if (!sourceResolved?.assignment || !sourceVersion || !rule) {
    await updateClosureState({
      balance,
      runId,
      actorId,
      sourceContext,
      status: "configuration_error",
      message: "The effective source leave policy or leave rule could not be resolved",
    });
    return { status: "configuration_error", carryUnits: 0, lapseUnits: 0 };
  }
  if (rule.balanceTracked === false || String(rule.entitlementMode || "fixed") !== "fixed") {
    await updateClosureState({
      balance,
      runId,
      actorId,
      sourceContext,
      rule,
      status: "not_applicable",
      message: "Year-end carry-forward applies only to fixed, balance-tracked leave types",
    });
    return { status: "not_applicable", carryUnits: 0, lapseUnits: 0 };
  }
  if (rule.carryForwardEnabled === true && Number(rule.maxCarryForward || 0) <= 0) {
    await updateClosureState({
      balance,
      runId,
      actorId,
      sourceContext,
      rule,
      status: "configuration_error",
      message: "Carry-forward is enabled but the source policy has no positive carry limit",
    });
    return { status: "configuration_error", carryUnits: 0, lapseUnits: 0 };
  }

  await ensureEmployeeLeaveAccruals({
    companyId: balance.company,
    employee,
    asOf: balance.leaveYearEnd,
    context: sourceContext,
  });
  const refreshedBalance = await EmployeeLeaveBalance.findOne(balanceProjectionFilter(balance)).lean();
  if (!refreshedBalance) throw new Error("The source leave balance could not be reloaded");
  const sourceRefs = policyReferences(sourceContext);
  const transactionActor =
    actorId ||
    optionalObjectId(sourceResolved.assignment.createdBy) ||
    optionalObjectId(sourceVersion.publishedBy) ||
    optionalObjectId(sourceVersion.createdBy);
  if (!transactionActor) {
    await updateClosureState({
      balance: refreshedBalance,
      runId,
      actorId,
      sourceContext,
      rule,
      status: "configuration_error",
      message: "The source policy has no valid audit actor",
    });
    return { status: "configuration_error", carryUnits: 0, lapseUnits: 0 };
  }

  const availableUnits = Math.max(0, Number(refreshedBalance.availableUnits || 0));
  if (availableUnits <= 0) {
    const pendingUnits = Math.max(0, Number(refreshedBalance.pendingUnits || 0));
    const status = pendingUnits > 0 ? "partial" : "completed";
    await updateClosureState({
      balance: refreshedBalance,
      runId,
      actorId,
      sourceContext,
      rule,
      status,
      message: pendingUnits > 0
        ? "Pending requests are retaining the remaining source-year balance"
        : "No available units remained at year close",
    });
    return { status, carryUnits: 0, lapseUnits: 0 };
  }

  const alreadyCarriedUnits = Number(existingClosure?.carriedUnits || 0);
  const initialPlan = planLeaveYearEndAmounts({
    availableUnits,
    carryForwardEnabled: rule.carryForwardEnabled === true,
    maxCarryForward: Number(rule.maxCarryForward || 0),
    alreadyCarriedUnits,
  });

  let destinationContext: any = null;
  let destinationYear: ReturnType<typeof resolveLeaveYear> | null = null;
  let expiresOn: string | null = null;
  if (initialPlan.carryUnits > 0) {
    const destinationDate = nextDateKey(balance.leaveYearEnd);
    destinationContext = await resolveEmployeeDayContext({
      companyId: balance.company,
      employeeId: balance.employee,
      attendanceDate: destinationDate,
    });
    const destinationVersion = destinationContext.policies.leavePolicy?.version;
    const destinationRule = (destinationVersion?.rules || []).find(
      (item: any) => String(item.leaveType?._id || item.leaveType) === String(balance.leaveType)
    );
    const activeLeaveType = await LeaveType.exists({
      _id: balance.leaveType,
      company: balance.company,
      status: "active",
    });
    if (
      !activeLeaveType ||
      !destinationVersion ||
      !destinationRule ||
      destinationRule.balanceTracked === false ||
      String(destinationRule.entitlementMode || "fixed") !== "fixed"
    ) {
      await updateClosureState({
        balance: refreshedBalance,
        runId,
        actorId,
        sourceContext,
        rule,
        status: "configuration_error",
        message: "Carry-forward is enabled but the destination has no active, compatible leave type rule",
      });
      return { status: "configuration_error", carryUnits: 0, lapseUnits: 0 };
    }
    destinationYear = resolveLeaveYear(
      destinationDate,
      Number(destinationVersion.leaveYearStartMonth || 1),
      Number(destinationVersion.leaveYearStartDay || 1)
    );
    if (destinationYear.leaveYearStart !== destinationDate) {
      await updateClosureState({
        balance: refreshedBalance,
        runId,
        actorId,
        sourceContext,
        rule,
        status: "configuration_error",
        message: "The destination policy leave-year boundary does not continue the source leave year",
        destination: destinationYear,
      });
      return { status: "configuration_error", carryUnits: 0, lapseUnits: 0 };
    }
    expiresOn = calculateCarryForwardExpiry(
      destinationYear.leaveYearStart,
      destinationYear.leaveYearEnd,
      Number(rule.carryForwardExpiryMonths || 0)
    );
  }

  let result = { status: "partial", carryUnits: 0, lapseUnits: 0 };
  await mongoose.connection.transaction(async (session) => {
    const [currentBalance, closure] = await Promise.all([
      EmployeeLeaveBalance.findOne(balanceProjectionFilter(balance)).session(session),
      LeaveYearEndClosure.findOneAndUpdate(
        closureFilter(balance),
        {
          $setOnInsert: {
            ...closureFilter(balance),
            sourceLeaveYearStart: balance.leaveYearStart,
            sourceLeaveYearEnd: balance.leaveYearEnd,
            carryForwardEnabledSnapshot: rule.carryForwardEnabled === true,
            maxCarryForwardSnapshot: Math.max(0, Number(rule.maxCarryForward || 0)),
            carryForwardExpiryMonthsSnapshot: Math.max(
              0,
              Number(rule.carryForwardExpiryMonths || 0)
            ),
            carriedUnits: 0,
            lapsedUnits: 0,
            pendingUnits: 0,
            remainingBalanceUnits: 0,
            iteration: 0,
            createdBy: actorId || null,
          },
        },
        { upsert: true, new: true, session, setDefaultsOnInsert: true }
      ),
    ]);
    if (!currentBalance || !closure) throw new Error("The year-end closure state could not be loaded");
    const plan = planLeaveYearEndAmounts({
      availableUnits: currentBalance.availableUnits,
      carryForwardEnabled: rule.carryForwardEnabled === true,
      maxCarryForward: Number(rule.maxCarryForward || 0),
      alreadyCarriedUnits: closure.carriedUnits,
    });
    const iteration = Number(closure.iteration || 0) + 1;
    const sourceKey = balanceKey(currentBalance);

    if (plan.carryUnits > 0) {
      if (!destinationYear || !destinationContext) {
        throw new Error("The validated destination leave year is missing");
      }
      const [lot] = await LeaveCarryForwardLot.create(
        [
          {
            company: currentBalance.company,
            employee: currentBalance.employee,
            leaveType: currentBalance.leaveType,
            sourceClosure: closure._id,
            sequence: iteration,
            sourceLeaveYearKey: currentBalance.leaveYearKey,
            sourceLeaveYearStart: currentBalance.leaveYearStart,
            sourceLeaveYearEnd: currentBalance.leaveYearEnd,
            ...destinationYear,
            originalUnits: plan.carryUnits,
            availableUnits: plan.carryUnits,
            consumedUnits: 0,
            expiredUnits: 0,
            expiresOn,
            status: "active",
            leavePolicyAssignment: sourceRefs.assignment,
            leavePolicy: sourceRefs.policy,
            leavePolicyVersion: sourceRefs.version,
            createdBy: transactionActor,
          },
        ],
        { session }
      );
      await postLeaveBalanceTransaction({
        key: sourceKey,
        units: -plan.carryUnits,
        transactionType: "carry_forward_out",
        sourceType: "year_end",
        sourceId: closure._id as mongoose.Types.ObjectId,
        effectiveDate: currentBalance.leaveYearEnd,
        idempotencyKey: `leave-year-end:${closure._id}:${iteration}:carry-out`,
        reason: `Carried ${plan.carryUnits} units into ${destinationYear.leaveYearKey}`,
        leavePolicyAssignment: sourceRefs.assignment,
        leavePolicy: sourceRefs.policy,
        leavePolicyVersion: sourceRefs.version,
        carryForwardLot: lot._id as mongoose.Types.ObjectId,
        createdBy: transactionActor,
        session,
      });
      const destinationRefs = policyReferences(destinationContext);
      const credit = await postLeaveBalanceTransaction({
        key: {
          company: currentBalance.company,
          employee: currentBalance.employee,
          leaveType: currentBalance.leaveType,
          ...destinationYear,
        },
        units: plan.carryUnits,
        transactionType: "carry_forward",
        sourceType: "year_end",
        sourceId: closure._id as mongoose.Types.ObjectId,
        effectiveDate: destinationYear.leaveYearStart,
        idempotencyKey: `leave-year-end:${closure._id}:${iteration}:carry-in`,
        reason: `Carry-forward from ${currentBalance.leaveYearKey}`,
        leavePolicyAssignment: destinationRefs.assignment,
        leavePolicy: destinationRefs.policy,
        leavePolicyVersion: destinationRefs.version,
        carryForwardLot: lot._id as mongoose.Types.ObjectId,
        createdBy: transactionActor,
        session,
      });
      lot.creditTransaction = credit._id as mongoose.Types.ObjectId;
      await lot.save({ session });
    }

    if (plan.lapseUnits > 0) {
      await postLeaveBalanceTransaction({
        key: sourceKey,
        units: -plan.lapseUnits,
        transactionType: "lapse",
        sourceType: "year_end",
        sourceId: closure._id as mongoose.Types.ObjectId,
        effectiveDate: currentBalance.leaveYearEnd,
        idempotencyKey: `leave-year-end:${closure._id}:${iteration}:lapse`,
        reason: rule.carryForwardEnabled === true
          ? "Year-end balance above the carry-forward limit lapsed"
          : "Unused year-end balance lapsed under the effective leave policy",
        leavePolicyAssignment: sourceRefs.assignment,
        leavePolicy: sourceRefs.policy,
        leavePolicyVersion: sourceRefs.version,
        createdBy: transactionActor,
        session,
      });
    }

    const remainingBalanceUnits = roundLeaveUnits(
      Number(currentBalance.balanceUnits || 0) - plan.carryUnits - plan.lapseUnits
    );
    const pendingUnits = Math.max(0, Number(currentBalance.pendingUnits || 0));
    const status = pendingUnits > 0 ? "partial" : "completed";
    closure.sourceLeavePolicyAssignment = sourceRefs.assignment;
    closure.sourceLeavePolicy = sourceRefs.policy;
    closure.sourceLeavePolicyVersion = sourceRefs.version;
    closure.carryForwardEnabledSnapshot = rule.carryForwardEnabled === true;
    closure.maxCarryForwardSnapshot = Math.max(0, Number(rule.maxCarryForward || 0));
    closure.carryForwardExpiryMonthsSnapshot = Math.max(
      0,
      Number(rule.carryForwardExpiryMonths || 0)
    );
    if (destinationYear) {
      closure.destinationLeaveYearKey = destinationYear.leaveYearKey;
      closure.destinationLeaveYearStart = destinationYear.leaveYearStart;
      closure.destinationLeaveYearEnd = destinationYear.leaveYearEnd;
    }
    closure.carriedUnits = roundLeaveUnits(Number(closure.carriedUnits || 0) + plan.carryUnits);
    closure.lapsedUnits = roundLeaveUnits(Number(closure.lapsedUnits || 0) + plan.lapseUnits);
    closure.pendingUnits = pendingUnits;
    closure.remainingBalanceUnits = remainingBalanceUnits;
    closure.iteration = iteration;
    closure.status = status;
    closure.message = status === "partial"
      ? "Pending requests are retaining the remaining source-year balance"
      : "Year-end balance was closed successfully";
    closure.lastRun = runId;
    closure.completedAt = status === "completed" ? new Date() : null;
    closure.lastProcessedAt = new Date();
    closure.updatedBy = actorId || null;
    await closure.save({ session });
    result = { status, carryUnits: plan.carryUnits, lapseUnits: plan.lapseUnits };
  });
  return result;
}

export async function expireCarryForwardCredits(options: {
  company: mongoose.Types.ObjectId;
  asOf: string;
  employeeId?: mongoose.Types.ObjectId | null;
}) {
  const match: any = {
    company: options.company,
    status: "active",
    expiresOn: { $ne: null, $lt: options.asOf },
    availableUnits: { $gt: 0 },
  };
  if (options.employeeId) match.employee = options.employeeId;
  let lastId: mongoose.Types.ObjectId | null = null;
  let expiredUnits = 0;
  let deferredExpiryLots = 0;
  while (true) {
    const lots = await LeaveCarryForwardLot.find(
      lastId ? { ...match, _id: { $gt: lastId } } : match
    )
      .sort({ _id: 1 })
      .limit(100)
      .lean();
    if (!lots.length) break;
    for (const candidate of lots) {
      await mongoose.connection.transaction(async (session) => {
        const lot = await LeaveCarryForwardLot.findOne({
          _id: candidate._id,
          ...match,
        }).session(session);
        if (!lot) return;
        const projection = await EmployeeLeaveBalance.findOne({
          company: lot.company,
          employee: lot.employee,
          leaveType: lot.leaveType,
          leaveYearKey: lot.leaveYearKey,
        }).session(session);
        const units = planCarryForwardExpiryUnits(
          Number(lot.availableUnits || 0),
          Number(projection?.availableUnits || 0)
        );
        if (units <= 0) {
          deferredExpiryLots += 1;
          return;
        }
        const expiredBefore = roundLeaveUnits(Number(lot.expiredUnits || 0));
        lot.availableUnits = roundLeaveUnits(Number(lot.availableUnits || 0) - units);
        lot.expiredUnits = roundLeaveUnits(expiredBefore + units);
        lot.status = Number(lot.availableUnits || 0) > 0 ? "active" : "expired";
        await lot.save({ session });
        await postLeaveBalanceTransaction({
          key: balanceKey(lot),
          units: -units,
          transactionType: "expiry",
          sourceType: "year_end",
          sourceId: lot.sourceClosure,
          effectiveDate: options.asOf,
          idempotencyKey: `carry-forward-lot:${lot._id}:expiry:${expiredBefore}:${units}`,
          reason: `Carried leave expired after ${lot.expiresOn}`,
          leavePolicyAssignment: lot.leavePolicyAssignment,
          leavePolicy: lot.leavePolicy,
          leavePolicyVersion: lot.leavePolicyVersion,
          carryForwardLot: lot._id as mongoose.Types.ObjectId,
          skipCarryForwardAllocation: true,
          createdBy: lot.createdBy,
          session,
        });
        expiredUnits = roundLeaveUnits(expiredUnits + units);
        if (Number(lot.availableUnits || 0) > 0) deferredExpiryLots += 1;
      });
    }
    lastId = lots[lots.length - 1]._id as mongoose.Types.ObjectId;
    if (lots.length < 100) break;
  }
  return { expiredUnits, deferredExpiryLots };
}

export async function runCompanyLeaveYearEnd(options: {
  companyId: unknown;
  asOf?: unknown;
  employeeId?: unknown;
  actorId?: unknown;
  trigger?: "manual" | "scheduler";
}) {
  const company = objectId(options.companyId, "company id");
  const asOf = parseAttendanceDate(text(options.asOf || currentDateKey())).dateKey;
  const employeeId = options.employeeId ? objectId(options.employeeId, "employee id") : null;
  const actorId = options.actorId ? objectId(options.actorId, "actor id") : null;
  const run = await LeaveYearEndRun.create({
    company,
    asOf,
    trigger: options.trigger || "manual",
    employee: employeeId,
    status: "running",
    triggeredBy: actorId,
  });

  let processedBalances = 0;
  let completedClosures = 0;
  let partialClosures = 0;
  let configurationErrors = 0;
  let carriedUnits = 0;
  let lapsedUnits = 0;
  let expiredUnits = 0;
  let deferredExpiryLots = 0;
  let failedItems = 0;
  const failures: Array<{
    employee?: mongoose.Types.ObjectId | null;
    leaveType?: mongoose.Types.ObjectId | null;
    message: string;
  }> = [];
  const recordFailure = (failure: (typeof failures)[number]) => {
    failedItems += 1;
    if (failures.length < 50) failures.push(failure);
  };

  try {
    await runCompanyLeaveAccrualCatchUp({ companyId: company, employeeId, asOf });
    const expiry = await expireCarryForwardCredits({ company, employeeId, asOf });
    expiredUnits = expiry.expiredUnits;
    deferredExpiryLots = expiry.deferredExpiryLots;

    const match: any = {
      company,
      leaveYearEnd: { $lt: asOf },
      balanceUnits: { $gt: 0 },
    };
    if (employeeId) match.employee = employeeId;
    let lastId: mongoose.Types.ObjectId | null = null;
    while (true) {
      const balances = await EmployeeLeaveBalance.find(
        lastId ? { ...match, _id: { $gt: lastId } } : match
      )
        .sort({ _id: 1 })
        .limit(100)
        .lean();
      if (!balances.length) break;
      const employeeIds = Array.from(new Set(balances.map((item) => String(item.employee))));
      const employees = await User.find({ _id: { $in: employeeIds }, company })
        .select(EMPLOYEE_FIELDS)
        .lean();
      const employeeById = new Map(employees.map((employee) => [String(employee._id), employee]));
      for (const balance of balances) {
        processedBalances += 1;
        const employee = employeeById.get(String(balance.employee));
        if (!employee) {
          recordFailure({
            employee: balance.employee,
            leaveType: balance.leaveType,
            message: "Employee record is missing for the leave balance",
          });
          continue;
        }
        try {
          const result = await processClosedBalance({
            balance,
            employee,
            runId: run._id as mongoose.Types.ObjectId,
            actorId,
          });
          carriedUnits = roundLeaveUnits(carriedUnits + result.carryUnits);
          lapsedUnits = roundLeaveUnits(lapsedUnits + result.lapseUnits);
          if (["completed", "not_applicable"].includes(result.status)) completedClosures += 1;
          if (result.status === "partial") partialClosures += 1;
          if (result.status === "configuration_error") configurationErrors += 1;
        } catch (error: any) {
          recordFailure({
            employee: balance.employee,
            leaveType: balance.leaveType,
            message: text(error?.message || "Year-end balance processing failed"),
          });
        }
      }
      lastId = balances[balances.length - 1]._id as mongoose.Types.ObjectId;
      if (balances.length < 100) break;
    }

    const partialMatch: any = {
      company,
      status: "partial",
      sourceLeaveYearEnd: { $lt: asOf },
    };
    if (employeeId) partialMatch.employee = employeeId;
    let lastClosureId: mongoose.Types.ObjectId | null = null;
    while (true) {
      const partials = await LeaveYearEndClosure.find(
        lastClosureId ? { ...partialMatch, _id: { $gt: lastClosureId } } : partialMatch
      )
        .sort({ _id: 1 })
        .limit(100)
        .lean();
      if (!partials.length) break;
      for (const partial of partials) {
        const [balance, employee] = await Promise.all([
          EmployeeLeaveBalance.findOne({
            company,
            employee: partial.employee,
            leaveType: partial.leaveType,
            leaveYearKey: partial.sourceLeaveYearKey,
            balanceUnits: { $lte: 0 },
          }).lean(),
          User.findOne({ _id: partial.employee, company }).select(EMPLOYEE_FIELDS).lean(),
        ]);
        if (!balance || !employee) continue;
        processedBalances += 1;
        try {
          const result = await processClosedBalance({
            balance,
            employee,
            runId: run._id as mongoose.Types.ObjectId,
            actorId,
          });
          if (["completed", "not_applicable"].includes(result.status)) completedClosures += 1;
          if (result.status === "partial") partialClosures += 1;
          if (result.status === "configuration_error") configurationErrors += 1;
        } catch (error: any) {
          recordFailure({
            employee: partial.employee,
            leaveType: partial.leaveType,
            message: text(error?.message || "Partial year-end closure finalization failed"),
          });
        }
      }
      lastClosureId = partials[partials.length - 1]._id as mongoose.Types.ObjectId;
      if (partials.length < 100) break;
    }

    const status = failedItems || configurationErrors || partialClosures || deferredExpiryLots
      ? "partial"
      : "completed";
    Object.assign(run, {
      status,
      processedBalances,
      completedClosures,
      partialClosures,
      configurationErrors,
      carriedUnits,
      lapsedUnits,
      expiredUnits,
      deferredExpiryLots,
      failedItems,
      failures,
      completedAt: new Date(),
    });
    await run.save();
    return run.toObject();
  } catch (error: any) {
    run.status = "failed";
    run.failedItems = 1;
    run.failures = [{ message: text(error?.message || "Year-end run failed") }];
    run.completedAt = new Date();
    await run.save();
    throw error;
  }
}

export async function runAllCompaniesLeaveYearEnd(asOf: unknown = currentDateKey()) {
  const companies = await EmployeeLeaveBalance.distinct("company", {
    leaveYearEnd: { $lt: parseAttendanceDate(text(asOf)).dateKey },
    balanceUnits: { $gt: 0 },
  });
  const expiryCompanies = await LeaveCarryForwardLot.distinct("company", {
    status: "active",
    expiresOn: { $ne: null, $lt: parseAttendanceDate(text(asOf)).dateKey },
    availableUnits: { $gt: 0 },
  });
  const companyIds = Array.from(new Set([...companies, ...expiryCompanies].map(String)));
  const results = [];
  for (const companyId of companyIds) {
    try {
      results.push(
        await runCompanyLeaveYearEnd({ companyId, asOf, trigger: "scheduler" })
      );
    } catch (error: any) {
      results.push({
        companyId,
        asOf: text(asOf),
        status: "failed",
        message: text(error?.message || "Company year-end run failed"),
      });
    }
  }
  return results;
}

function pagination(query: any) {
  const page = Math.max(1, Number(query?.page || 1));
  const limit = Math.max(1, Math.min(100, Number(query?.limit || 20)));
  return { page, limit, skip: (page - 1) * limit };
}

function ensureCanManageYearEnd(actor: any) {
  if (!hasPermission(actor, PERMISSION_KEYS.MANAGE_LEAVE_BALANCES)) {
    throw generateError("You do not have permission to manage leave year-end processing", 403);
  }
}

export async function runLeaveYearEndService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId);
    ensureCanManageYearEnd(actor);
    const employeeId = req.body?.employeeId
      ? objectId(req.body.employeeId, "employee id")
      : null;
    if (employeeId) {
      const employee = await User.findOne({ _id: employeeId, company }).select(EMPLOYEE_FIELDS).lean();
      if (!employee) throw generateError("Employee not found in this company", 404);
      ensureEmployeeInActorScope(
        actor,
        employee,
        PERMISSION_KEYS.MANAGE_LEAVE_BALANCES,
        "You cannot run leave year-end processing for this employee"
      );
    } else if (!["superadmin", "admin", "hradmin"].includes(text(actor.role).toLowerCase())) {
      throw generateError("Company-wide year-end processing requires company administrator access", 403);
    }
    const asOf = parseAttendanceDate(text(req.body?.asOf || currentDateKey())).dateKey;
    if (asOf > currentDateKey()) throw generateError("Year-end processing cannot run for a future date", 422);
    const result = await runCompanyLeaveYearEnd({
      companyId: company,
      employeeId,
      actorId: actor._id,
      asOf,
      trigger: "manual",
    });
    return res.status(200).json({
      success: true,
      data: result,
      message: result.status === "completed"
        ? "Leave year-end processing completed"
        : "Leave year-end processing completed with items requiring attention",
    });
  } catch (error) {
    next(error);
  }
}

export async function listLeaveYearEndRunsService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    ensureCanManageYearEnd(actor);
    const { page, limit, skip } = pagination(req.query);
    const match: any = { company };
    if (req.query?.employeeId) {
      const employee = await User.findOne({
        _id: objectId(req.query.employeeId, "employee id"),
        company,
      })
        .select(EMPLOYEE_FIELDS)
        .lean();
      if (!employee) throw generateError("Employee not found in this company", 404);
      ensureEmployeeInActorScope(
        actor,
        employee,
        PERMISSION_KEYS.MANAGE_LEAVE_BALANCES,
        "You cannot view year-end runs for this employee"
      );
      match.employee = employee._id;
    } else if (!["superadmin", "admin", "hradmin"].includes(text(actor.role).toLowerCase())) {
      throw generateError("Select an employee to view year-end runs within your HR scope", 403);
    }
    const [items, total] = await Promise.all([
      LeaveYearEndRun.find(match)
        .populate("employee", "name username code")
        .populate("triggeredBy", "name username code role")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      LeaveYearEndRun.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: items,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}

export async function listLeaveYearEndClosuresService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    ensureCanManageYearEnd(actor);
    const { page, limit, skip } = pagination(req.query);
    const match: any = { company };
    if (req.query?.status) match.status = text(req.query.status);
    if (req.query?.employeeId) {
      const employee = await User.findOne({
        _id: objectId(req.query.employeeId, "employee id"),
        company,
      })
        .select(EMPLOYEE_FIELDS)
        .lean();
      if (!employee) throw generateError("Employee not found in this company", 404);
      ensureEmployeeInActorScope(
        actor,
        employee,
        PERMISSION_KEYS.MANAGE_LEAVE_BALANCES,
        "You cannot view year-end history for this employee"
      );
      match.employee = employee._id;
    } else if (!["superadmin", "admin", "hradmin"].includes(text(actor.role).toLowerCase())) {
      throw generateError("Select an employee to view year-end history within your HR scope", 403);
    }
    const [items, total] = await Promise.all([
      LeaveYearEndClosure.find(match)
        .populate("employee", "name username code")
        .populate("leaveType", "name code color unit")
        .populate("updatedBy", "name username code role")
        .sort({ sourceLeaveYearEnd: -1, updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      LeaveYearEndClosure.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: items,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}
