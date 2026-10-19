import assert from "node:assert/strict";
import {
  ACTIVE_USER_PASSWORD_MATCH,
  canUserLogin,
  getUserAccountStatus,
  hasUserPassword,
  isUserAccountActive,
} from "./userAccountStatus";

function testHasUserPassword() {
  assert.equal(hasUserPassword({ password: "hashed-value" }), true);
  assert.equal(hasUserPassword({ password: "" }), false);
  assert.equal(hasUserPassword({ password: "   " }), false, "whitespace only is not a password");
  assert.equal(hasUserPassword({}), false);
  assert.equal(hasUserPassword(null), false);
  assert.equal(hasUserPassword(undefined), false);
}

function testUserWithPasswordIsActive() {
  assert.equal(getUserAccountStatus({ password: "hash" }), "ACTIVE");
  assert.equal(getUserAccountStatus({ password: "hash", is_enabled: true }), "ACTIVE");
}

function testUserWithoutPasswordIsPending() {
  assert.equal(getUserAccountStatus({}), "PENDING");
  assert.equal(getUserAccountStatus({ password: "" }), "PENDING");
  assert.equal(getUserAccountStatus({ is_enabled: true }), "PENDING");
  assert.equal(getUserAccountStatus(null), "PENDING");
}

function testDisabledUserIsInactive() {
  assert.equal(getUserAccountStatus({ password: "hash", is_enabled: false }), "INACTIVE");
  assert.equal(getUserAccountStatus({ is_enabled: false }), "INACTIVE", "disabled beats pending");
}

function testMissingEnabledFlagIsNotTreatedAsDisabled() {
  // Only an explicit `false` disables an account; legacy users have no flag.
  assert.equal(getUserAccountStatus({ password: "hash", is_enabled: undefined }), "ACTIVE");
  assert.equal(getUserAccountStatus({ password: "hash", is_enabled: null }), "ACTIVE");
}

function testDeletedUserWinsOverEveryOtherState() {
  assert.equal(
    getUserAccountStatus({ password: "hash", is_enabled: true, deletedAt: new Date() }),
    "DELETED"
  );
  assert.equal(
    getUserAccountStatus({ password: "hash", is_enabled: false, deletedAt: new Date() }),
    "DELETED"
  );
  assert.equal(getUserAccountStatus({ deletedAt: new Date() }), "DELETED");
}

function testOnlyActiveUsersCanLogin() {
  const active = { password: "hash", is_enabled: true };
  const pending = {};
  const inactive = { password: "hash", is_enabled: false };
  const deleted = { password: "hash", deletedAt: new Date() };

  assert.equal(isUserAccountActive(active), true);
  assert.equal(canUserLogin(active), true);

  for (const user of [pending, inactive, deleted, null, undefined]) {
    assert.equal(isUserAccountActive(user), false);
    assert.equal(canUserLogin(user), false);
  }
}

function testActivePasswordMatchFilterExcludesEmptyValues() {
  assert.deepEqual(ACTIVE_USER_PASSWORD_MATCH, {
    $exists: true,
    $nin: [null, ""],
  });
}

testHasUserPassword();
testUserWithPasswordIsActive();
testUserWithoutPasswordIsPending();
testDisabledUserIsInactive();
testMissingEnabledFlagIsNotTreatedAsDisabled();
testDeletedUserWinsOverEveryOtherState();
testOnlyActiveUsersCanLogin();
testActivePasswordMatchFilterExcludesEmptyValues();

console.log("User account status tests passed");
