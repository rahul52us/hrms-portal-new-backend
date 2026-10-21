import assert from "node:assert/strict";
import {
  DEFAULT_LOGIN_FAILURE_WINDOW_MS,
  isLoginLockActive,
  loginRetryAfterSeconds,
  shouldResetFailedLoginWindow,
} from "./loginSecurity.utils";

const now = new Date("2026-10-20T10:00:00.000Z");

assert.equal(isLoginLockActive(new Date("2026-10-20T10:10:00.000Z"), now), true);
assert.equal(isLoginLockActive(new Date("2026-10-20T09:59:59.000Z"), now), false);
assert.equal(loginRetryAfterSeconds(new Date("2026-10-20T10:00:30.000Z"), now), 30);
assert.equal(
  shouldResetFailedLoginWindow(
    new Date(now.getTime() - DEFAULT_LOGIN_FAILURE_WINDOW_MS),
    now
  ),
  true
);
assert.equal(shouldResetFailedLoginWindow(new Date(now.getTime() - 60_000), now), false);

console.log("Login security tests passed (5 assertions)");
