import assert from "node:assert/strict";
import {
  hasAttendanceRemoteAuthorization,
  matchAllowedNetwork,
  normalizeAllowedNetwork,
  normalizeAllowedNetworks,
  normalizeClientIp,
} from "./attendancePunchAccess.utils";

assert.equal(normalizeClientIp("::ffff:127.0.0.1"), "127.0.0.1");
assert.equal(normalizeAllowedNetwork("10.20.30.40"), "10.20.30.40/32");
assert.equal(normalizeAllowedNetwork("10.20.0.0/16"), "10.20.0.0/16");
assert.deepEqual(normalizeAllowedNetworks(["10.20.0.0/16", "10.20.0.0/16"]), ["10.20.0.0/16"]);
assert.equal(matchAllowedNetwork("10.20.4.5", ["10.20.0.0/16"]).allowed, true);
assert.equal(matchAllowedNetwork("10.21.4.5", ["10.20.0.0/16"]).allowed, false);
assert.equal(matchAllowedNetwork("2001:db8::4", ["2001:db8::/32"]).allowed, true);
assert.throws(() => normalizeAllowedNetwork("10.0.0.0/80"));
assert.equal(hasAttendanceRemoteAuthorization({ workMode: "remote", workModeSource: "work_schedule" }), true);
assert.equal(hasAttendanceRemoteAuthorization({ workMode: "remote", workModeSource: "remote_work_request" }), true);
assert.equal(hasAttendanceRemoteAuthorization({ workMode: "office", workModeSource: "work_schedule" }), false);
assert.equal(hasAttendanceRemoteAuthorization({ workMode: "remote", workModeSource: "manual" }), false);

console.log("Attendance punch access tests passed");
