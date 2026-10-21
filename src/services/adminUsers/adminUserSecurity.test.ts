import assert from "node:assert/strict";
import { assertUserStatusChangeAllowed } from "./adminUserSecurity.utils";

assert.throws(
  () => assertUserStatusChangeAllowed({ requesterId: "same", targetUserId: "same", nextStatus: false }),
  /cannot deactivate your own account/
);
assert.doesNotThrow(() =>
  assertUserStatusChangeAllowed({ requesterId: "same", targetUserId: "same", nextStatus: true })
);
assert.doesNotThrow(() =>
  assertUserStatusChangeAllowed({ requesterId: "admin", targetUserId: "employee", nextStatus: false })
);

console.log("Admin user security tests passed (3 assertions)");
