import assert from "node:assert/strict";
import User from "./User";

const departmentPath = User.schema.path("department");
const accessRolePath = User.schema.path("accessRole");
const failedLoginAttemptsPath = User.schema.path("failedLoginAttempts");
const loginLockedUntilPath = User.schema.path("loginLockedUntil");

assert.ok(departmentPath, "User.department must exist");
assert.equal(departmentPath.instance, "String");
assert.equal(
  departmentPath.options.ref,
  undefined,
  "User.department stores a department name and must not be populated as an ObjectId reference"
);
assert.ok(accessRolePath, "User.accessRole must exist");
assert.equal(accessRolePath.instance, "String");
assert.equal(accessRolePath.options.default, null);
assert.equal(failedLoginAttemptsPath.options.select, false);
assert.equal(failedLoginAttemptsPath.options.default, 0);
assert.equal(loginLockedUntilPath.options.select, false);

console.log("User schema tests passed (9 assertions)");
