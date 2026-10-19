import assert from "node:assert/strict";
import {
  CompOffLotCandidate,
  CompOffUsage,
  planCompOffFifoAllocations,
} from "./compOffCredit.utils";

function lot(id: string, expiresOn: string, availableUnits: number): CompOffLotCandidate {
  return { id, expiresOn, availableUnits };
}

function use(attendanceDate: string, units: number): CompOffUsage {
  return { attendanceDate, units };
}

function testSingleLotCoversUsage() {
  const result = planCompOffFifoAllocations(
    [lot("a", "2026-12-31", 2)],
    [use("2026-11-01", 1)]
  );

  assert.deepEqual(result, [{ lotId: "a", expiresOn: "2026-12-31", units: 1 }]);
}

function testUsageSpillsIntoNextLotInCandidateOrder() {
  const result = planCompOffFifoAllocations(
    [lot("a", "2026-12-01", 1), lot("b", "2026-12-31", 1)],
    [use("2026-11-01", 1.5)]
  );

  assert.deepEqual(result, [
    { lotId: "a", expiresOn: "2026-12-01", units: 1 },
    { lotId: "b", expiresOn: "2026-12-31", units: 0.5 },
  ]);
}

function testMultipleDaysConsumeSameLotAndAccumulate() {
  const result = planCompOffFifoAllocations(
    [lot("a", "2026-12-31", 3)],
    [use("2026-11-01", 1), use("2026-11-02", 0.5), use("2026-11-03", 1)]
  );

  assert.deepEqual(result, [{ lotId: "a", expiresOn: "2026-12-31", units: 2.5 }]);
}

function testUsageIsProcessedInDateOrderRegardlessOfInputOrder() {
  // Earlier date must claim the older lot first even if listed last.
  const result = planCompOffFifoAllocations(
    [lot("old", "2026-11-05", 1), lot("new", "2026-12-31", 1)],
    [use("2026-11-20", 1), use("2026-11-01", 1)]
  );

  // 2026-11-01 takes "old" (still valid). 2026-11-20 finds "old" exhausted and takes "new".
  assert.deepEqual(result, [
    { lotId: "old", expiresOn: "2026-11-05", units: 1 },
    { lotId: "new", expiresOn: "2026-12-31", units: 1 },
  ]);
}

function testExpiredLotIsSkippedForLaterUsage() {
  const result = planCompOffFifoAllocations(
    [lot("expired", "2026-10-31", 5), lot("valid", "2026-12-31", 5)],
    [use("2026-11-01", 1)]
  );

  assert.deepEqual(result, [{ lotId: "valid", expiresOn: "2026-12-31", units: 1 }]);
}

function testLotIsStillUsableOnItsExpiryDate() {
  const result = planCompOffFifoAllocations(
    [lot("a", "2026-11-01", 1)],
    [use("2026-11-01", 1)]
  );

  assert.deepEqual(result, [{ lotId: "a", expiresOn: "2026-11-01", units: 1 }]);
}

function testReturnsNullWhenBalanceIsInsufficient() {
  assert.equal(
    planCompOffFifoAllocations([lot("a", "2026-12-31", 1)], [use("2026-11-01", 2)]),
    null
  );
}

function testReturnsNullWhenOnlyExpiredLotsRemain() {
  assert.equal(
    planCompOffFifoAllocations([lot("a", "2026-10-01", 5)], [use("2026-11-01", 1)]),
    null
  );
}

function testReturnsNullIfAnyLaterDayCannotBeCovered() {
  // Day one fits, day two does not: the whole plan is rejected, not partially applied.
  assert.equal(
    planCompOffFifoAllocations(
      [lot("a", "2026-12-31", 1)],
      [use("2026-11-01", 1), use("2026-11-02", 1)]
    ),
    null
  );
}

function testNoUsageProducesEmptyPlan() {
  assert.deepEqual(planCompOffFifoAllocations([lot("a", "2026-12-31", 1)], []), []);
  assert.deepEqual(planCompOffFifoAllocations([], []), []);
}

function testNoCandidatesWithUsageFails() {
  assert.equal(planCompOffFifoAllocations([], [use("2026-11-01", 1)]), null);
}

function testZeroUnitLotsAreIgnored() {
  const result = planCompOffFifoAllocations(
    [lot("empty", "2026-12-31", 0), lot("a", "2026-12-31", 1)],
    [use("2026-11-01", 1)]
  );

  assert.deepEqual(result, [{ lotId: "a", expiresOn: "2026-12-31", units: 1 }]);
}

function testFractionalUnitsAreRoundedToAvoidFloatingPointDrift() {
  // 0.1 + 0.2 is 0.30000000000000004 in raw floating point.
  const result = planCompOffFifoAllocations(
    [lot("a", "2026-12-31", 0.3)],
    [use("2026-11-01", 0.1), use("2026-11-02", 0.2)]
  );

  assert.deepEqual(result, [{ lotId: "a", expiresOn: "2026-12-31", units: 0.3 }]);
}

function testInputsAreNotMutated() {
  const candidates = [lot("a", "2026-12-31", 2)];
  const usage = [use("2026-11-02", 1), use("2026-11-01", 0.5)];

  planCompOffFifoAllocations(candidates, usage);

  assert.deepEqual(candidates, [lot("a", "2026-12-31", 2)]);
  assert.deepEqual(usage, [use("2026-11-02", 1), use("2026-11-01", 0.5)]);
}

testSingleLotCoversUsage();
testUsageSpillsIntoNextLotInCandidateOrder();
testMultipleDaysConsumeSameLotAndAccumulate();
testUsageIsProcessedInDateOrderRegardlessOfInputOrder();
testExpiredLotIsSkippedForLaterUsage();
testLotIsStillUsableOnItsExpiryDate();
testReturnsNullWhenBalanceIsInsufficient();
testReturnsNullWhenOnlyExpiredLotsRemain();
testReturnsNullIfAnyLaterDayCannotBeCovered();
testNoUsageProducesEmptyPlan();
testNoCandidatesWithUsageFails();
testZeroUnitLotsAreIgnored();
testFractionalUnitsAreRoundedToAvoidFloatingPointDrift();
testInputsAreNotMutated();

console.log("Comp-off credit FIFO allocation tests passed");
