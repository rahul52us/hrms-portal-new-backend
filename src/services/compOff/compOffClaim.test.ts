import assert from "node:assert/strict";
import {
  calculateCompOffEligibleUnits,
  calculateCompOffExpiryDate,
} from "./compOffClaim.utils";
import { planCompOffFifoAllocations } from "./compOffCredit.utils";

assert.equal(calculateCompOffEligibleUnits({ workedMinutes: 239, halfDayMinutes: 240, fullDayMinutes: 480 }), 0);
assert.equal(calculateCompOffEligibleUnits({ workedMinutes: 240, halfDayMinutes: 240, fullDayMinutes: 480 }), 0.5);
assert.equal(calculateCompOffEligibleUnits({ workedMinutes: 479, halfDayMinutes: 240, fullDayMinutes: 480 }), 0.5);
assert.equal(calculateCompOffEligibleUnits({ workedMinutes: 480, halfDayMinutes: 240, fullDayMinutes: 480 }), 1);

assert.equal(
  calculateCompOffExpiryDate({ earnedDate: "2026-01-01", validityDays: 90, leaveYearEnd: "2026-12-31" }),
  "2026-04-01"
);
assert.equal(
  calculateCompOffExpiryDate({ earnedDate: "2026-12-20", validityDays: 90, leaveYearEnd: "2026-12-31" }),
  "2026-12-31"
);

assert.deepEqual(
  planCompOffFifoAllocations(
    [
      { id: "early", expiresOn: "2026-01-05", availableUnits: 1 },
      { id: "later", expiresOn: "2026-01-31", availableUnits: 2 },
    ],
    [
      { attendanceDate: "2026-01-03", units: 1 },
      { attendanceDate: "2026-01-10", units: 1 },
    ]
  ),
  [
    { lotId: "early", expiresOn: "2026-01-05", units: 1 },
    { lotId: "later", expiresOn: "2026-01-31", units: 1 },
  ]
);
assert.equal(
  planCompOffFifoAllocations(
    [{ id: "expired-before-use", expiresOn: "2026-01-05", availableUnits: 1 }],
    [{ attendanceDate: "2026-01-10", units: 0.5 }]
  ),
  null
);

console.log("Comp-off calculation tests passed");
