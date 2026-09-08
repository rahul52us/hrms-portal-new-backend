import assert from "node:assert/strict";
import mongoose from "mongoose";
import LeaveBalanceTransaction from "./LeaveBalanceTransaction.schema";
import LeaveCarryForwardLot from "./LeaveCarryForwardLot.schema";
import LeaveYearEndClosure from "./LeaveYearEndClosure.schema";
import LeaveYearEndRun from "./LeaveYearEndRun.schema";

const id = () => new mongoose.Types.ObjectId();
const company = id();
const employee = id();
const leaveType = id();
const actor = id();
const closureId = id();

assert.equal(
  new LeaveCarryForwardLot({
    company,
    employee,
    leaveType,
    sourceClosure: closureId,
    sequence: 1,
    sourceLeaveYearKey: "2025-01-01:2025-12-31",
    sourceLeaveYearStart: "2025-01-01",
    sourceLeaveYearEnd: "2025-12-31",
    leaveYearKey: "2026-01-01:2026-12-31",
    leaveYearStart: "2026-01-01",
    leaveYearEnd: "2026-12-31",
    originalUnits: 5,
    availableUnits: 5,
    expiresOn: "2026-03-31",
    createdBy: actor,
  }).validateSync(),
  undefined
);

assert.equal(
  new LeaveYearEndClosure({
    company,
    employee,
    leaveType,
    sourceLeaveYearKey: "2025-01-01:2025-12-31",
    sourceLeaveYearStart: "2025-01-01",
    sourceLeaveYearEnd: "2025-12-31",
    carryForwardEnabledSnapshot: true,
    maxCarryForwardSnapshot: 5,
    carryForwardExpiryMonthsSnapshot: 3,
    status: "partial",
  }).validateSync(),
  undefined
);

assert.equal(
  new LeaveYearEndRun({
    company,
    asOf: "2026-01-01",
    trigger: "manual",
    triggeredBy: actor,
  }).validateSync(),
  undefined
);

assert.equal(
  new LeaveBalanceTransaction({
    company,
    employee,
    leaveType,
    leaveYearKey: "2025-01-01:2025-12-31",
    leaveYearStart: "2025-01-01",
    leaveYearEnd: "2025-12-31",
    units: -2,
    transactionType: "lapse",
    sourceType: "year_end",
    sourceId: closureId,
    effectiveDate: "2025-12-31",
    idempotencyKey: "year-end-schema-test",
    reason: "Unused balance lapsed",
    createdBy: actor,
  }).validateSync(),
  undefined
);

console.log("Leave year-end schema tests passed");
