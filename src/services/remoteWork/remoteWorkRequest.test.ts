import assert from "assert";
import {
  buildRemoteWorkDateRange,
  getMaximumConsecutiveRemoteWorkDays,
  getRemoteWorkWeekKey,
} from "./remoteWorkRequest.service";

const range = buildRemoteWorkDateRange("2026-08-31", "2026-09-02");
assert.deepStrictEqual(range, ["2026-08-31", "2026-09-01", "2026-09-02"]);
assert.strictEqual(getRemoteWorkWeekKey("2026-08-31"), "2026-08-31");
assert.strictEqual(getRemoteWorkWeekKey("2026-09-06"), "2026-08-31");
assert.strictEqual(
  getMaximumConsecutiveRemoteWorkDays(["2026-09-03", "2026-09-01", "2026-09-02", "2026-09-05"]),
  3
);
assert.strictEqual(getMaximumConsecutiveRemoteWorkDays([]), 0);
assert.throws(() => buildRemoteWorkDateRange("2026-09-02", "2026-09-01"));
assert.throws(() => buildRemoteWorkDateRange("2026-09-01", "2026-10-02"));

console.log("Remote-work request date tests passed (7 assertions)");
