import assert from "node:assert/strict";
import {
  planLeaveAccrualCredits,
  planLeaveRuleAccrualCredits,
  scheduledAnnualCredit,
} from "./leaveAccrualCalculator.utils";

const baseRule = {
  balanceTracked: true,
  annualEntitlement: 12,
  accrualFrequency: "monthly" as const,
  accrualAmount: 1,
  prorateOnJoining: true,
  prorateOnExit: true,
};

const baseInput = {
  asOf: "2026-03-15",
  leaveYearStart: "2026-01-01",
  leaveYearEnd: "2026-12-31",
  assignmentEffectiveFrom: "2026-01-01",
  versionEffectiveFrom: "2026-01-01",
  joiningDate: "2025-06-01",
  rule: baseRule,
};

const tests = [
  {
    name: "plans each monthly credit through the current period",
    run: () => {
      const credits = planLeaveAccrualCredits(baseInput);
      assert.deepEqual(credits.map((credit) => credit.units), [1, 1, 1]);
      assert.deepEqual(credits.map((credit) => credit.effectiveDate), [
        "2026-01-01",
        "2026-02-01",
        "2026-03-01",
      ]);
    },
  },
  {
    name: "credits the current month when a policy starts mid-month",
    run: () => {
      const credits = planLeaveAccrualCredits({
        ...baseInput,
        asOf: "2026-08-23",
        assignmentEffectiveFrom: "2026-08-23",
        versionEffectiveFrom: "2026-08-23",
      });
      assert.equal(credits.length, 1);
      assert.equal(credits[0].units, 1);
      assert.equal(credits[0].effectiveDate, "2026-08-23");
      assert.equal(credits[0].periodKey, "monthly:2026-08-01");
    },
  },
  {
    name: "prorates the joining month by active calendar days",
    run: () => {
      const credits = planLeaveAccrualCredits({
        ...baseInput,
        asOf: "2026-07-31",
        joiningDate: "2026-07-16",
      });
      assert.equal(credits.length, 1);
      assert.equal(credits[0].units, 0.5161);
      assert.equal(credits[0].effectiveDate, "2026-07-16");
    },
  },
  {
    name: "does not prorate joining when the policy starts after joining",
    run: () => {
      const credits = planLeaveAccrualCredits({
        ...baseInput,
        asOf: "2026-08-23",
        joiningDate: "2026-07-01",
        assignmentEffectiveFrom: "2026-08-23",
        versionEffectiveFrom: "2026-08-23",
      });
      assert.equal(credits[0].units, 1);
    },
  },
  {
    name: "prorates an upfront entitlement for a mid-year joiner",
    run: () => {
      const credits = planLeaveAccrualCredits({
        ...baseInput,
        asOf: "2026-07-01",
        joiningDate: "2026-07-01",
        rule: { ...baseRule, accrualFrequency: "upfront", accrualAmount: 12 },
      });
      assert.equal(credits.length, 1);
      assert.equal(credits[0].units, 6.0493);
      assert.equal(credits[0].transactionType, "entitlement_credit");
    },
  },
  {
    name: "plans quarter credits from a custom leave-year anchor",
    run: () => {
      const credits = planLeaveAccrualCredits({
        ...baseInput,
        asOf: "2026-08-23",
        leaveYearStart: "2026-04-01",
        leaveYearEnd: "2027-03-31",
        assignmentEffectiveFrom: "2026-04-01",
        versionEffectiveFrom: "2026-04-01",
        rule: { ...baseRule, accrualFrequency: "quarterly", accrualAmount: 3 },
      });
      assert.deepEqual(credits.map((credit) => credit.effectiveDate), [
        "2026-04-01",
        "2026-07-01",
      ]);
      assert.deepEqual(credits.map((credit) => credit.units), [3, 3]);
    },
  },
  {
    name: "prorates the final period when an employment end date is known",
    run: () => {
      const credits = planLeaveAccrualCredits({
        ...baseInput,
        asOf: "2026-03-31",
        employmentEndDate: "2026-03-16",
      });
      assert.equal(credits.length, 3);
      assert.equal(credits[2].units, 0.5161);
    },
  },
  {
    name: "does not auto-credit a manual accrual rule",
    run: () => {
      const credits = planLeaveAccrualCredits({
        ...baseInput,
        rule: { ...baseRule, accrualFrequency: "none", accrualAmount: 0 },
      });
      assert.deepEqual(credits, []);
    },
  },
  {
    name: "does not credit before policy eligibility begins",
    run: () => {
      const credits = planLeaveAccrualCredits({
        ...baseInput,
        asOf: "2026-02-01",
        assignmentEffectiveFrom: "2026-03-01",
      });
      assert.deepEqual(credits, []);
    },
  },
  {
    name: "derives the annual total for a hybrid schedule",
    run: () => {
      assert.equal(scheduledAnnualCredit([
        {
          componentId: "opening-grant",
          frequency: "upfront",
          amount: 10,
          upfrontTiming: "leave_year_start",
          prorateOnJoining: false,
          prorateOnExit: false,
        },
        {
          componentId: "monthly-accrual",
          frequency: "monthly",
          amount: 0.25,
          prorateOnJoining: true,
          prorateOnExit: true,
        },
      ]), 13);
    },
  },
  {
    name: "plans upfront and monthly hybrid credits independently",
    run: () => {
      const credits = planLeaveRuleAccrualCredits({
        ...baseInput,
        asOf: "2026-08-23",
        assignmentEffectiveFrom: "2026-08-23",
        versionEffectiveFrom: "2026-08-23",
        rule: {
          ...baseRule,
          annualEntitlement: 13,
          creditComponents: [
            {
              componentId: "opening-grant",
              frequency: "upfront",
              amount: 10,
              upfrontTiming: "leave_year_start",
              prorateOnJoining: false,
              prorateOnExit: false,
            },
            {
              componentId: "monthly-accrual",
              frequency: "monthly",
              amount: 0.25,
              prorateOnJoining: true,
              prorateOnExit: true,
            },
          ],
        },
      });
      assert.deepEqual(credits.map((credit) => credit.units), [10, 0.25]);
      assert.deepEqual(credits.map((credit) => credit.componentId), [
        "opening-grant",
        "monthly-accrual",
      ]);
      assert.equal(credits.every((credit) => !credit.legacyIdempotency), true);
    },
  },
  {
    name: "does not repeat a first-eligibility credit in a later leave year",
    run: () => {
      const credits = planLeaveRuleAccrualCredits({
        ...baseInput,
        asOf: "2026-03-15",
        assignmentEffectiveFrom: "2025-01-01",
        versionEffectiveFrom: "2025-01-01",
        joiningDate: "2025-06-01",
        rule: {
          ...baseRule,
          annualEntitlement: 10,
          creditComponents: [{
            componentId: "first-eligibility-grant",
            frequency: "upfront",
            amount: 10,
            upfrontTiming: "first_eligibility",
            prorateOnJoining: false,
            prorateOnExit: false,
          }],
        },
      });
      assert.deepEqual(credits, []);
    },
  },
  {
    name: "applies joining proration per component",
    run: () => {
      const credits = planLeaveRuleAccrualCredits({
        ...baseInput,
        asOf: "2026-07-31",
        joiningDate: "2026-07-16",
        rule: {
          ...baseRule,
          annualEntitlement: 13,
          creditComponents: [
            {
              componentId: "opening-grant",
              frequency: "upfront",
              amount: 10,
              upfrontTiming: "leave_year_start",
              prorateOnJoining: false,
              prorateOnExit: false,
            },
            {
              componentId: "monthly-accrual",
              frequency: "monthly",
              amount: 0.25,
              prorateOnJoining: true,
              prorateOnExit: true,
            },
          ],
        },
      });
      assert.deepEqual(credits.map((credit) => credit.units), [10, 0.129]);
    },
  },
  {
    name: "marks legacy schedules for existing v1 idempotency keys",
    run: () => {
      const credits = planLeaveRuleAccrualCredits(baseInput);
      assert.equal(credits.length, 3);
      assert.equal(credits[0].componentId, "legacy-monthly");
      assert.equal(credits[0].legacyIdempotency, true);
    },
  },
];

let passed = 0;
for (const test of tests) {
  test.run();
  passed += 1;
  process.stdout.write(`PASS ${test.name}\n`);
}
process.stdout.write(`${passed} leave accrual calculator tests passed\n`);
