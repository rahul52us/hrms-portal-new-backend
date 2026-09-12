import assert from "node:assert/strict";
import {
  buildCompOffClaimNotificationContent,
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

assert.deepEqual(
  buildCompOffClaimNotificationContent("awaiting_approval", {
    attendanceDate: "2026-08-23",
    requestedUnits: 1,
    employeeName: "Ankit",
  }),
  {
    eventType: "comp_off_claim.awaiting_approval",
    title: "Comp-off claim needs approval",
    message: "Ankit submitted a 1-day comp-off claim for work on 2026-08-23.",
    actionUrl: "/employee",
  }
);

assert.deepEqual(
  buildCompOffClaimNotificationContent("approved", {
    attendanceDate: "2026-08-23",
    requestedUnits: 0.5,
    expiresOn: "2026-11-21",
  }),
  {
    eventType: "comp_off_claim.approved",
    title: "Comp-off claim approved",
    message: "Your 0.5-day comp-off claim for work on 2026-08-23 was approved. The credit expires on 2026-11-21.",
    actionUrl: "/dashboard/requests",
  }
);

assert.deepEqual(
  buildCompOffClaimNotificationContent("rejected", {
    attendanceDate: "2026-08-23",
    requestedUnits: 1,
  }),
  {
    eventType: "comp_off_claim.rejected",
    title: "Comp-off claim rejected",
    message: "Your 1-day comp-off claim for work on 2026-08-23 was rejected.",
    actionUrl: "/dashboard/requests",
  }
);

assert.deepEqual(
  buildCompOffClaimNotificationContent("withdrawn", {
    attendanceDate: "2026-08-23",
    requestedUnits: 1,
  }),
  {
    eventType: "comp_off_claim.withdrawn",
    title: "Comp-off claim withdrawn",
    message: "The 1-day comp-off claim for work on 2026-08-23 was withdrawn.",
    actionUrl: "/employee",
  }
);

assert.deepEqual(
  buildCompOffClaimNotificationContent("revoked", {
    attendanceDate: "2026-08-23",
    requestedUnits: 1,
  }),
  {
    eventType: "comp_off_claim.revoked",
    title: "Comp-off credit revoked",
    message: "Your approved 1-day comp-off credit earned on 2026-08-23 was revoked. Any unused credit was removed.",
    actionUrl: "/dashboard/requests",
  }
);

console.log("Comp-off calculation tests passed");
