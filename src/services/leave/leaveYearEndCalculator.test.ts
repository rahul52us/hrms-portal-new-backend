import assert from "node:assert/strict";
import {
  calculateCarryForwardExpiry,
  planCarryForwardExpiryUnits,
  planLeaveYearEndAmounts,
} from "./leaveYearEndCalculator.utils";

assert.deepEqual(
  planLeaveYearEndAmounts({ availableUnits: 12, carryForwardEnabled: false, maxCarryForward: 5 }),
  { carryUnits: 0, lapseUnits: 12 }
);
assert.deepEqual(
  planLeaveYearEndAmounts({ availableUnits: 12, carryForwardEnabled: true, maxCarryForward: 5 }),
  { carryUnits: 5, lapseUnits: 7 }
);
assert.deepEqual(
  planLeaveYearEndAmounts({
    availableUnits: 4,
    carryForwardEnabled: true,
    maxCarryForward: 5,
    alreadyCarriedUnits: 3,
  }),
  { carryUnits: 2, lapseUnits: 2 }
);
assert.equal(calculateCarryForwardExpiry("2026-01-01", "2026-12-31", 3), "2026-03-31");
assert.equal(calculateCarryForwardExpiry("2026-04-01", "2027-03-31", 0), null);
assert.equal(calculateCarryForwardExpiry("2024-02-29", "2025-02-27", 12), "2025-02-27");
assert.equal(planCarryForwardExpiryUnits(5, 2), 2);
assert.equal(planCarryForwardExpiryUnits(2, 5), 2);

console.log("Leave year-end calculator tests passed");
